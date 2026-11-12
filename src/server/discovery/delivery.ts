import type {
  Asked,
  BriefEntry,
  Delivery,
  DiscoverySettings,
  FindingView,
  InboxEventView,
  Route,
  Urgency,
} from '../../shared/inbox-types.js';
import type { PushMessage } from '../push.js';
import type { DiscoveryStore } from './store.js';

/**
 * When the owner hears about an item, from how urgent it is and whether it
 * needs their decision. Pure, so the table can be tested on its own.
 *
 * | Urgency              | Decision? | Delivery                                |
 * | -------------------- | --------- | --------------------------------------- |
 * | within hours         | either    | now, through quiet hours                |
 * | today                | either    | after the hold window ("draft ready" or |
 * |                      |           | the options); quiet hours: the brief    |
 * | by tomorrow or later | either    | the morning brief                       |
 */
export function planDelivery(input: {
  urgency: Urgency | null;
  asked: Asked | null;
  route: Route | null;
}): { delivery: Delivery; section: BriefEntry['section'] } {
  const section: BriefEntry['section'] =
    input.asked === 'decision' || input.route === 'decide'
      ? 'decisions'
      : input.route === 'draft' || input.route === 'propose'
        ? 'drafts'
        : 'updates';
  if (input.urgency === 'hours') return { delivery: 'now', section };
  if (input.urgency === 'today') return { delivery: 'held', section };
  return { delivery: 'brief', section };
}

const ROUTE_TITLE: Record<Route, string> = {
  tell: 'something to know',
  draft: 'a draft reply is ready',
  propose: 'an action to approve',
  inform: 'something needs you',
  decide: 'a decision for you',
};

/** Local date and minutes past midnight in a time zone. */
export function localTime(now: number, timeZone: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return localTime(now, 'UTC');
  }
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? '0';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}
const minutesOf = (value: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
};
export function inQuietHours(now: number, settings: DiscoverySettings) {
  if (!settings.quietHours) return false;
  const { minutes } = localTime(now, settings.timeZone);
  const start = minutesOf(settings.quietHours.start);
  const end = minutesOf(settings.quietHours.end);
  if (start === end) return false;
  return start < end
    ? minutes >= start && minutes < end
    : minutes >= start || minutes < end;
}

/**
 * Sends discovery's pushes by the delivery table: urgent ones at once,
 * others after a short hold so a quick follow-up can cancel them, and the
 * rest (or anything during quiet hours) in one morning brief.
 */
export class DeliveryService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  constructor(
    private store: DiscoveryStore,
    private send: (message: PushMessage) => Promise<unknown>,
    private options: { previews?: () => boolean; now?: () => number } = {},
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  start(intervalMs = 30_000) {
    this.timer ??= setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Plans and queues the push for a finding the owner should hear about. */
  async deliver(
    finding: FindingView,
    event: InboxEventView,
    dotName: string,
  ): Promise<Delivery> {
    const { delivery, section } = planDelivery(finding);
    const settings = await this.store.settings();
    const now = this.now();
    const route = finding.route ?? 'tell';
    const title = `${finding.urgency === 'hours' ? 'Urgent: ' : ''}${dotName}: ${ROUTE_TITLE[route]}`;
    const body = this.options.previews?.()
      ? `${event.title}: ${finding.reason}`.replace(/\s+/g, ' ').slice(0, 160)
      : finding.threadId
        ? 'Open the conversation to see what it found and suggests.'
        : 'Open the OpenDots inbox to see it.';
    await this.store.queuePush(
      {
        findingId: finding.id,
        kind: 'finding',
        title: title.charAt(0).toUpperCase() + title.slice(1),
        body,
        threadId: finding.threadId,
        section,
        urgent: delivery === 'now',
        dueAt:
          delivery === 'brief'
            ? null
            : delivery === 'held'
              ? now + settings.holdMinutes * 60_000
              : now,
        state: delivery === 'brief' ? 'brief' : 'queued',
      },
      now,
    );
    if (delivery === 'now') await this.tick();
    return delivery;
  }
  /**
   * Cancels a finding's waiting pushes. When one already went out, a short
   * correction follows, so the owner isn't left acting on it.
   */
  async cancel(
    findingId: string,
    correction?: { title: string; body: string },
  ) {
    const sent = await this.store.cancelPushes(findingId);
    if (sent && correction)
      await this.store.queuePush(
        {
          findingId,
          kind: 'correction',
          ...correction,
          threadId: null,
          section: 'updates',
          urgent: false,
          dueAt: this.now(),
          state: 'queued',
        },
        this.now(),
      );
    return sent;
  }

  /** Sends what is due, and the morning brief once a day. */
  tick(): Promise<void> {
    this.ticking ??= this.run().finally(() => (this.ticking = undefined));
    return this.ticking;
  }
  private async run() {
    const now = this.now();
    const settings = await this.store.settings();
    const quiet = inQuietHours(now, settings);
    for (const push of await this.store.due(now)) {
      if (quiet && !push.urgent) {
        // Held for the brief; only "within hours" breaks quiet hours.
        await this.store.setPushState(push.id, 'brief');
        continue;
      }
      await this.deliverNow({
        title: push.title,
        body: push.body,
        data: push.threadId ? { threadId: push.threadId } : { url: '/#/inbox' },
      });
      await this.store.setPushState(push.id, 'sent', now);
    }
    await this.brief(now, settings);
  }
  private async deliverNow(message: PushMessage) {
    try {
      await this.send(message);
    } catch {
      console.error('Could not send a discovery push.');
    }
  }
  private async brief(now: number, settings: DiscoverySettings) {
    const today = localTime(now, settings.timeZone);
    const late = today.minutes - minutesOf(settings.briefTime);
    if (late < 0) return;
    const last = await this.store.lastBriefAt();
    if (last !== null && localTime(last, settings.timeZone).date === today.date)
      return;
    // Only what was waiting at brief time; later items wait for tomorrow's.
    const briefAt = now - late * 60_000 - (now % 60_000);
    const waiting = (await this.store.pushes('brief')).filter(
      (push) => push.createdAt <= briefAt,
    );
    if (!waiting.length) return;
    const count = (section: BriefEntry['section']) =>
      waiting.filter((push) => (push.section ?? 'updates') === section).length;
    const parts = [
      [count('decisions'), 'decision', 'decisions'],
      [count('drafts'), 'draft to approve', 'drafts to approve'],
      [count('updates'), 'update', 'updates'],
    ]
      .filter(([n]) => Number(n) > 0)
      .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
    const brief = await this.store.queuePush(
      {
        findingId: null,
        kind: 'brief',
        title: 'Your morning brief',
        body: `${parts.join(', ')}. Open the OpenDots inbox to go through them.`,
        threadId: null,
        section: null,
        urgent: false,
        dueAt: now,
        state: 'queued',
      },
      now,
    );
    await this.deliverNow({
      title: brief.title,
      body: brief.body,
      data: { url: '/#/inbox' },
    });
    await this.store.setPushState(brief.id, 'sent', now);
    for (const push of waiting)
      await this.store.setPushState(push.id, 'briefed', now);
  }
}
