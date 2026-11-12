import {
  URGENCIES,
  type DiscoverySettings,
  type FindingView,
  type InboxEventView,
  type ProposalChoice,
  type ProposalState,
  type ProposalView,
  type Route,
  type Urgency,
} from '../../shared/inbox-types.js';
import type { ApprovalView } from '../../shared/approvals.js';
import type { PushMessage } from '../push.js';
import { localTime } from './delivery.js';
import type { ProposalStore } from './proposal-store.js';

/** Dismissals of one sender, with no prepare or handle, that quiet them. */
export const DISMISSALS_TO_QUIET = 2;
/** "Not now" without a time: three hours. */
const LATER_MS = 3 * 60 * 60_000;
const SUMMARY_LENGTH = 1200;

/**
 * Which of the three choices fit, by route. "Handle it" only where the Dot
 * may act: a reply it can draft, or an action the owner allowed.
 */
export function proposalOptions(route: Route | null): ProposalChoice[] {
  return route === 'draft' || route === 'propose'
    ? ['prepare', 'handle', 'not_now']
    : ['prepare', 'not_now'];
}
/** Sort key: urgency first (0 to 3), then how sure Jev was (0 to 1). */
export function importanceOf(urgency: Urgency | null, confidence: number) {
  return Math.max(URGENCIES.indexOf(urgency ?? 'tomorrow'), 0) + confidence;
}
/**
 * The triage rule dismissals feed: a sender the owner dismissed at least
 * DISMISSALS_TO_QUIET times lately, and never chose to prepare or handle,
 * is no longer flagged. "Within hours" and injection still get through.
 */
export function quietedBySender(
  history: { dismissed: number; acted: number },
  verdict: { urgency: Urgency | null; injection: boolean },
) {
  return (
    history.dismissed >= DISMISSALS_TO_QUIET &&
    history.acted === 0 &&
    verdict.urgency !== 'hours' &&
    !verdict.injection
  );
}
/** The next time the local clock shows `time` ("HH:MM"), at least a minute away. */
export function nextLocal(now: number, time: string, timeZone: string) {
  const [hours, minutes] = time.split(':').map(Number);
  const target = hours * 60 + minutes;
  const current = localTime(now, timeZone).minutes;
  let delta = (target - current + 1440) % 1440;
  if (delta === 0) delta = 1440;
  return now - (now % 60_000) + delta * 60_000;
}

/** "Prepare it for me": research and drafts; nothing leaves OpenDots. */
const prepareMessage = (proposal: ProposalView) =>
  [
    `Prepare it for me: ${proposal.title}`,
    '',
    'Research it with read-only tools, then save a page with the plan, the context and links, and put any replies I need to send here, word for word, as drafts. Nothing may leave OpenDots: do not send, book, pay or change anything. Tell me when the page and drafts are ready.',
  ].join('\n');
/** "Handle it": run the plan; each change still asks the owner. */
const handleMessage = (proposal: ProposalView) =>
  [
    `Handle it: ${proposal.title}`,
    '',
    proposal.state === 'prepared'
      ? 'Carry out the plan you prepared above.'
      : 'Carry out what you suggested above.',
    'Ask for my approval before each change, send or reply, exactly as it will go out, and wait for it. Then report what was done and what is left.',
  ].join('\n');

export class ProposalClosedError extends Error {}

type Run = (
  threadId: string,
  prompt: string,
  metadata: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<string>;

/**
 * The owner's three choices on a flagged item: prepare it, handle it, or
 * not now (snooze or dismiss). Each runs in the proposal's own
 * conversation, so the owner can ask follow-up questions first.
 */
export class ProposalService {
  private controller = new AbortController();
  private running = new Set<Promise<void>>();
  constructor(
    private store: ProposalStore,
    private options: {
      run: Run;
      /** Sends a push; quiet when push is not set up. */
      notify?: (message: PushMessage) => Promise<unknown>;
      /** Cancels the finding's waiting pushes once the owner decides. */
      cancelPushes?: (findingId: string) => Promise<unknown>;
      settings: () => Promise<DiscoverySettings>;
      /** Whether pushes may quote item text (PUSH_PREVIEWS). */
      previews?: () => boolean;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }

  /** Marks work a restart interrupted as failed, so it can be chosen again. */
  start() {
    return this.store.failRunning(
      'OpenDots restarted while this was running. Choose again.',
    );
  }
  stop() {
    this.controller.abort(new Error('Server stopped.'));
  }
  /** Resolves when running choices are done. For tests. */
  async idle() {
    while (this.running.size) await Promise.all([...this.running]);
  }

  /** Records the proposal for a finding a Dot has looked into. */
  offer(
    finding: FindingView,
    event: InboxEventView,
    input: { threadId: string; reply?: string; app: string; sender: string },
  ) {
    const summary = (input.reply ?? '').trim() || finding.reason;
    return this.store.save({
      findingId: finding.id,
      eventId: event.id,
      dotId: finding.dotId!,
      threadId: input.threadId,
      title: `${input.app}: ${event.title}`,
      summary: summary.slice(0, SUMMARY_LENGTH),
      options: proposalOptions(finding.route),
      importance: importanceOf(finding.urgency, finding.confidence),
      urgency: finding.urgency,
      route: finding.route,
      sender: input.sender || null,
    });
  }

  /** The owner's choice. Prepare and handle run in the background. */
  async decide(
    id: string,
    choice: 'prepare' | 'handle' | 'dismiss' | 'snooze',
    until?: number | 'later' | 'tomorrow',
  ) {
    const proposal = await this.store.get(id);
    if (!proposal) throw new ProposalClosedError('Proposal not found.');
    let moved: ProposalView | undefined;
    if (choice === 'prepare' || choice === 'handle') {
      if (!proposal.options.includes(choice))
        throw new ProposalClosedError(
          'This item has no action the Dot may take. Prepare it, or answer in its conversation.',
        );
      const from: ProposalState[] =
        choice === 'prepare'
          ? ['open', 'failed', 'snoozed']
          : ['open', 'prepared', 'failed', 'snoozed'];
      moved = await this.store.transition(
        id,
        from,
        choice === 'prepare' ? 'preparing' : 'handling',
        { decision: choice, snoozeUntil: null },
      );
      if (moved) this.track(this.work(moved, proposal.state, choice));
    } else if (choice === 'dismiss')
      moved = await this.store.transition(
        id,
        ['open', 'prepared', 'failed', 'snoozed', 'handled'],
        'dismissed',
        { decision: 'dismiss', snoozeUntil: null },
      );
    else
      moved = await this.store.transition(
        id,
        ['open', 'prepared', 'failed'],
        'snoozed',
        { decision: 'snooze', snoozeUntil: await this.snoozeTime(until) },
      );
    if (!moved)
      throw new ProposalClosedError(
        `This item is already ${proposal.state}. Refresh to see where it is.`,
      );
    await this.options.cancelPushes?.(moved.findingId);
    return moved;
  }
  private async snoozeTime(until?: number | 'later' | 'tomorrow') {
    const now = this.now();
    if (typeof until === 'number') return Math.max(until, now + 60_000);
    if (until === 'tomorrow') {
      const settings = await this.options.settings();
      return nextLocal(now, settings.briefTime, settings.timeZone);
    }
    return now + LATER_MS;
  }
  private track(work: Promise<void>) {
    this.running.add(work);
    void work.finally(() => this.running.delete(work));
  }
  private async work(
    proposal: ProposalView,
    before: ProposalState,
    choice: 'prepare' | 'handle',
  ) {
    const running = choice === 'prepare' ? 'preparing' : 'handling';
    try {
      const reply = await this.options.run(
        proposal.threadId,
        choice === 'prepare'
          ? prepareMessage(proposal)
          : handleMessage({ ...proposal, state: before }),
        { opendotsSource: choice, proposalId: proposal.id },
        this.controller.signal,
      );
      const done = await this.store.transition(
        proposal.id,
        [running],
        choice === 'prepare' ? 'prepared' : 'handled',
      );
      if (!done) return;
      await this.notify({
        title:
          choice === 'prepare'
            ? 'Ready: plan and drafts to review'
            : 'Done: see what was handled',
        body: this.previews()
          ? reply.replace(/\s+/g, ' ').slice(0, 160)
          : 'Open the conversation to see it.',
        data: { threadId: proposal.threadId, proposalId: proposal.id },
        // A prepared item can still be handled from the notification.
        ...(choice === 'prepare' && done.options.includes('handle')
          ? { categoryId: 'proposal_prepared' }
          : {}),
      });
    } catch (error) {
      if (this.controller.signal.aborted) return;
      await this.store.transition(proposal.id, [running], 'failed', {
        error:
          error instanceof Error && error.message
            ? error.message
            : 'It did not finish.',
      });
      await this.notify({
        title:
          choice === 'prepare' ? 'Could not prepare it' : 'Could not handle it',
        body: 'Open the conversation to see what happened.',
        data: { threadId: proposal.threadId },
      });
    }
  }
  /** While handling, an approval needs the owner even if they aren't looking. */
  async approvalRequested(approval: ApprovalView) {
    const proposal = await this.store.forThread(approval.threadId);
    if (proposal?.state !== 'handling') return;
    await this.notify({
      title: 'Approval needed',
      body: this.previews()
        ? `Handling "${proposal.title}" needs your approval.`.slice(0, 160)
        : 'Handling an item needs your approval. Open the conversation to decide.',
      data: { threadId: proposal.threadId },
    });
  }
  private previews() {
    return this.options.previews?.() ?? false;
  }
  private async notify(message: PushMessage) {
    try {
      await this.options.notify?.(message);
    } catch {
      console.error('Could not send a proposal push.');
    }
  }
}
