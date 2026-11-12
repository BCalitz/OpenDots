import {
  DISCOVERY_TOOLKITS,
  type ComposioSourceConfig,
  type FindingView,
  type InboxEventView,
} from '../../shared/inbox-types.js';
import type { NewEvents } from '../inbox/engine.js';
import type { InboxStore } from '../inbox/store.js';
import { ruleVerdict, type Judge, type Verdict } from './classifier.js';

/** Starts a read-only investigation of one flagged item; returns its thread. */
export type Investigate = (
  input: {
    dotId: string;
    app: string;
    event: InboxEventView;
    finding: FindingView;
    /** The earlier item this one was found to reference, if any. */
    referencedEvent?: InboxEventView;
    /** Set when the referenced item already has its own thread; continue
     * there instead of opening a second, disconnected conversation. */
    existingThreadId?: string;
  },
  signal: AbortSignal,
) => Promise<{ threadId: string }>;
type ReadyListener = (finding: FindingView, event: InboxEventView) => unknown;

const safeError = (error: unknown) =>
  (error instanceof Error && error.message
    ? error.message
    : 'The investigation did not finish.'
  ).slice(0, 300);

/**
 * Discovery. New items from discovery sources go to a small, fast model
 * that only decides whether the owner needs to see them. Items it flags go
 * to a Dot, one at a time, which investigates with read-only tools and
 * writes up what it found and what it proposes. Nothing changes until the
 * owner answers in that conversation.
 */
export class DiscoveryService {
  private classifying: Promise<void> = Promise.resolve();
  private investigating: Promise<void> = Promise.resolve();
  private queued = new Set<string>();
  private ready: ReadyListener[] = [];
  private controller = new AbortController();
  constructor(
    private store: InboxStore,
    private options: {
      judge: () => Judge | undefined;
      investigate: Investigate;
      /** Lowest confidence — or, for a correlated item, lowest urgency —
       * that still counts as needing attention. */
      threshold?: number;
      /** How far back a new item can correlate with one from the same
       * sender. */
      windowMs?: number;
      /** Items judged per check; the rest are left unjudged. */
      maxJudged?: number;
      /** Investigations started per check; the rest wait for the owner. */
      maxInvestigations?: number;
      investigationTimeoutMs?: number;
    },
  ) {}
  get threshold() {
    return this.options.threshold ?? 0.6;
  }
  get windowMs() {
    return this.options.windowMs ?? 72 * 60 * 60_000;
  }
  /** Called when a Dot has finished looking into a flagged item. */
  onReady(listener: ReadyListener) {
    this.ready.push(listener);
  }
  /** For InboxEngine.onEvents. Returns at once; the work is queued. */
  readonly listener = (batch: NewEvents) => {
    if (batch.source.type !== 'composio' || !batch.events.length) return;
    const work = this.classifying.then(() => this.judge(batch));
    this.classifying = work.catch(() => {
      console.error('Discovery could not judge new items.');
    });
  };
  /** Picks up work a restart interrupted. */
  async start() {
    for (const finding of await this.store.findings('investigating'))
      await this.store.updateFinding(finding.id, {
        state: 'failed',
        error:
          'OpenDots restarted during this investigation. Start it again from the Inbox.',
      });
  }
  stop() {
    this.controller.abort(new Error('Server stopped.'));
  }
  /** Resolves when queued work is done. For tests and shutdown. */
  async idle() {
    let before: Promise<void> | undefined;
    while (before !== this.classifying) {
      before = this.classifying;
      await before;
    }
    await this.investigating;
  }
  /** Queues a read-only investigation, for example from the Inbox. */
  async investigate(findingId: string) {
    const finding = await this.store.finding(findingId);
    if (!finding?.dotId) throw new Error('Finding not found.');
    if (finding.state === 'investigating' || this.queued.has(finding.id))
      return finding;
    this.queued.add(finding.id);
    this.investigating = this.investigating
      .then(() => this.run(finding.id))
      .catch(() => undefined)
      .finally(() => this.queued.delete(finding.id));
    return finding;
  }

  private async judge(batch: NewEvents) {
    const config = batch.source.config as ComposioSourceConfig;
    const app = DISCOVERY_TOOLKITS[config.toolkit]?.name ?? config.toolkit;
    const flagged: FindingView[] = [];
    for (const event of batch.events.slice(0, this.options.maxJudged ?? 25)) {
      if (this.controller.signal.aborted) return;
      if (await this.store.findingForEvent(event.id)) continue;
      let verdict: Verdict | undefined = ruleVerdict(
        await this.store.payload(event.id),
      );
      let judgedBy = 'rules';
      if (!verdict) {
        const model = this.options.judge();
        if (!model) return;
        const candidates = event.from
          ? await this.store.recentFrom(
              event.from,
              event.occurredAt,
              this.windowMs,
              event.id,
            )
          : [];
        try {
          verdict = await model.judge(
            { ...event, app },
            candidates,
            this.controller.signal,
          );
          judgedBy = model.name;
        } catch (error) {
          // Left unjudged; the item stays in the Inbox as an ordinary event.
          console.error(`Discovery model failed: ${safeError(error)}`);
          continue;
        }
      }
      // A correlated reference escalates on its own urgency threshold, same
      // as the base signal escalates on its own confidence threshold.
      const correlated =
        verdict.referencedEventId !== null &&
        (verdict.urgency ?? 0) >= this.threshold;
      const finding = await this.store.saveFinding({
        eventId: event.id,
        attention:
          (verdict.attention && verdict.confidence >= this.threshold) ||
          correlated,
        category: verdict.category,
        confidence: verdict.confidence,
        reason: verdict.reason,
        judgedBy,
        dotId: config.dotId,
        referencedEventId: correlated ? verdict.referencedEventId : null,
      });
      if (finding.state === 'flagged') flagged.push(finding);
    }
    for (const finding of flagged
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.options.maxInvestigations ?? 5))
      await this.investigate(finding.id);
  }

  private async run(findingId: string) {
    const finding = await this.store.finding(findingId);
    const event = finding && (await this.store.event(finding.eventId));
    if (!finding?.dotId || !event || this.controller.signal.aborted) return;
    const source = await this.store.source(event.sourceId);
    const toolkit =
      source?.type === 'composio'
        ? (source.config as ComposioSourceConfig).toolkit
        : undefined;
    const referencedEvent = finding.referencedEventId
      ? await this.store.event(finding.referencedEventId)
      : undefined;
    // When this item follows up on one already flagged for the same Dot,
    // continue that conversation instead of opening a second, disconnected
    // one for what is really the same thread of work.
    const referencedFinding = finding.referencedEventId
      ? await this.store.findingForEvent(finding.referencedEventId)
      : undefined;
    const sameDot = referencedFinding?.dotId === finding.dotId;
    const existingThreadId = sameDot
      ? (referencedFinding!.threadId ?? undefined)
      : undefined;
    await this.store.updateFinding(finding.id, { state: 'investigating' });
    try {
      const { threadId } = await this.options.investigate(
        {
          dotId: finding.dotId,
          app:
            (toolkit && DISCOVERY_TOOLKITS[toolkit]?.name) || event.sourceName,
          event,
          finding,
          referencedEvent,
          existingThreadId,
        },
        AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(
            this.options.investigationTimeoutMs ?? 10 * 60_000,
          ),
        ]),
      );
      const done = await this.store.updateFinding(finding.id, {
        state: 'ready',
        threadId,
      });
      // The item this one followed up on now shares this conversation, so
      // it never needs a standalone investigation of its own.
      if (sameDot && referencedFinding!.threadId !== threadId)
        await this.store.updateFinding(referencedFinding!.id, {
          state: 'ready',
          threadId,
        });
      for (const listener of this.ready) {
        try {
          await listener(done!, event);
        } catch {
          console.error('A discovery listener failed.');
        }
      }
    } catch (error) {
      // The conversation may exist even though the turn failed.
      const threadId =
        error && typeof error === 'object' && 'threadId' in error
          ? String(error.threadId)
          : undefined;
      await this.store.updateFinding(finding.id, {
        state: 'failed',
        error: safeError(error),
        ...(threadId ? { threadId } : {}),
      });
    }
  }
}
