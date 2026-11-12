import {
  DISCOVERY_TOOLKITS,
  URGENCIES,
  type Asked,
  type ComposioSourceConfig,
  type DiscoverySettings,
  type FindingView,
  type InboxEventView,
  type Route,
  type Urgency,
} from '../../shared/inbox-types.js';
import type { NewEvents } from '../inbox/engine.js';
import type { InboxStore } from '../inbox/store.js';
import {
  YES,
  ruleVerdict,
  type HistoryItem,
  type Judge,
  type JudgeItem,
  type RelatedVerdict,
  type Verdict,
} from './classifier.js';
import type { DeliveryService } from './delivery.js';
import { embeddingText, type Embedder } from './embeddings.js';

/** Starts a read-only investigation of one flagged item; returns its thread. */
export type Investigate = (
  input: {
    dotId: string;
    app: string;
    event: InboxEventView;
    finding: FindingView;
    /** The earlier item this one was found to be about, if any. */
    referencedEvent?: InboxEventView;
    /** Set when the referenced item already has its own thread; continue
     * there instead of opening a second, disconnected conversation. */
    existingThreadId?: string;
    /** Earlier items Jev found useful for answering, or contradicting. */
    history?: { event: InboxEventView; note: string }[];
  },
  signal: AbortSignal,
) => Promise<{ threadId: string }>;
type ReadyListener = (finding: FindingView, event: InboxEventView) => unknown;

// A "same thing" score of 0.8 or more links two items; 0.5 to 0.8 goes to
// the owner's review queue; below 0.5 they stay unlinked.
const LINK = 0.8;
const REVIEW = 0.5;

const safeError = (error: unknown) =>
  (error instanceof Error && error.message
    ? error.message
    : 'The investigation did not finish.'
  ).slice(0, 300);
const address = (from: string | null | undefined) =>
  (/<([^>]+)>/.exec(from ?? '')?.[1] ?? from ?? '').trim().toLowerCase();

/**
 * What the Dot does, from what is asked and whether it may act. Code, not
 * the model, decides this.
 *
 * | What is asked              | May the Dot act? | Route   |
 * | -------------------------- | ---------------- | ------- |
 * | nothing (information only) | -                | tell    |
 * | information or a reply     | as a draft       | draft   |
 * | an action                  | yes              | propose |
 * | an action                  | no               | inform  |
 * | a decision                 | -                | decide  |
 *
 * An item that tries to instruct an AI assistant is only shown to the
 * owner, never handed to a Dot. When the judge didn't say what is asked,
 * the Dot looks into it read-only and reports (inform).
 */
export function routeFor(
  asked: Asked | null,
  options: { injection: boolean; canAct: boolean },
): Route {
  if (options.injection || asked === 'nothing') return 'tell';
  if (asked === 'information' || asked === 'reply') return 'draft';
  if (asked === 'action') return options.canAct ? 'propose' : 'inform';
  if (asked === 'decision') return 'decide';
  return 'inform';
}

/**
 * Whether a later item may say an earlier one no longer needs the owner:
 * only the earlier item's own sender, or the owner and their organisation
 * (addresses and domains in `trusted`). Anyone may make an item more
 * urgent.
 */
export function mayDowngrade(
  laterFrom: string | null,
  earlierFrom: string | null,
  trusted: string[],
) {
  const later = address(laterFrom);
  if (!later) return false;
  if (later === address(earlierFrom)) return true;
  const domain = later.split('@')[1] ?? '';
  return trusted.some((entry) => {
    const value = entry.trim().toLowerCase().replace(/^@/, '');
    return value.includes('@')
      ? value === later
      : !!domain && (domain === value || domain.endsWith(`.${value}`));
  });
}

const raise = (a: Urgency | null, b: Urgency | null): Urgency => {
  const index = Math.max(
    URGENCIES.indexOf(a ?? 'days'),
    URGENCIES.indexOf(b ?? 'days'),
  );
  return URGENCIES[Math.max(index, 0)];
};

/**
 * Discovery with history. For each new item from a discovery source:
 *
 * 1. Gather earlier items it could relate to: shared tags (exact, then near
 *    spellings), the same sender lately, similar wording (embeddings), and
 *    Jev's match for names code can't settle.
 * 2. Judge it with that history in one Jev call.
 * 3. Update earlier items: link the same thing, resolve what the new item
 *    says is done (from trusted senders only), escalate what it makes more
 *    urgent.
 * 4. Route it: tell, draft, propose, inform or decide.
 * 5. Investigate it read-only when the route calls for it, then deliver by
 *    the delivery table: now, after a short hold, or in the morning brief.
 */
export class DiscoveryService {
  private classifying: Promise<void> = Promise.resolve();
  private investigating: Promise<void> = Promise.resolve();
  private queued = new Set<string>();
  private ready: ReadyListener[] = [];
  private controller = new AbortController();
  /** Notes for the investigation, kept between judging and running it. */
  private notes = new Map<string, { event: InboxEventView; note: string }[]>();
  constructor(
    private store: InboxStore,
    private options: {
      judge: () => Judge | undefined;
      investigate: Investigate;
      /** Similar items by wording; off when undefined. */
      embedder?: () => Embedder | undefined;
      /** Sends the push for a finding; tests may leave it out. */
      delivery?: DeliveryService;
      /** A Dot's name, for pushes. */
      dotName?: (dotId: string) => Promise<string | undefined>;
      /** Whether pushes may quote item text (PUSH_PREVIEWS). */
      previews?: () => boolean;
      /** Whether connected apps are allowed at all (Settings). */
      appsAllowed?: () => Promise<boolean>;
      /** Lowest confidence that still counts as needing attention. */
      threshold?: number;
      /** How far back the same sender counts as history. */
      windowMs?: number;
      /** Earlier items given to Jev per new item. */
      historySize?: number;
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
    if (!batch.events.length) return;
    const embedder = this.options.embedder?.();
    const judged = batch.source.type === 'composio';
    if (!embedder && !judged) return;
    const work = this.classifying.then(async () => {
      if (embedder) await this.embed(embedder, batch.events);
      if (judged) await this.judge(batch);
    });
    this.classifying = work.catch((error: unknown) => {
      console.error(`Discovery could not judge new items: ${safeError(error)}`);
    });
  };
  /** Picks up work a restart interrupted, and embeds earlier items. */
  async start() {
    for (const finding of await this.store.findings('investigating'))
      await this.store.updateFinding(finding.id, {
        state: 'failed',
        error:
          'OpenDots restarted during this investigation. Start it again from the Inbox.',
      });
    const embedder = this.options.embedder?.();
    if (embedder) {
      const work = this.classifying.then(() => this.backfill(embedder));
      this.classifying = work.catch(() => {
        console.error('Could not embed earlier inbox items.');
      });
    }
  }
  stop() {
    this.controller.abort(new Error('Server stopped.'));
  }
  /** Resolves when queued work is done. For tests and shutdown. */
  async idle() {
    let before: Promise<void> | undefined;
    while (before !== this.classifying || this.queued.size) {
      before = this.classifying;
      await before;
      await this.investigating;
    }
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

  private async embed(embedder: Embedder, events: InboxEventView[]) {
    const missing: InboxEventView[] = [];
    for (const event of events)
      if (!(await this.store.discovery.hasEmbedding(event.id, embedder.model)))
        missing.push(event);
    for (let i = 0; i < missing.length; i += 32) {
      const chunk = missing.slice(i, i + 32);
      try {
        const vectors = await embedder.embed(
          chunk.map(embeddingText),
          this.controller.signal,
        );
        for (const [index, event] of chunk.entries())
          await this.store.discovery.saveEmbedding(
            event.id,
            embedder.model,
            vectors[index],
          );
      } catch (error) {
        // Similar items are a help, not a requirement; judging goes on.
        console.error(`Could not embed inbox items: ${safeError(error)}`);
        return;
      }
    }
  }
  private async backfill(embedder: Embedder) {
    for (;;) {
      if (this.controller.signal.aborted) return;
      const rows = await this.store.discovery.unembedded(embedder.model, 32);
      if (!rows.length) return;
      const vectors = await embedder.embed(
        rows.map(embeddingText),
        this.controller.signal,
      );
      for (const [index, row] of rows.entries())
        await this.store.discovery.saveEmbedding(
          row.id,
          embedder.model,
          vectors[index],
        );
    }
  }

  /**
   * Earlier items this one could relate to, strongest first, and why each
   * was picked. Code only, apart from Jev's match for names it can't settle.
   */
  async gather(
    event: InboxEventView,
    item: JudgeItem,
    model: Judge | undefined,
    settings: DiscoverySettings,
  ): Promise<HistoryItem[]> {
    const signal = this.controller.signal;
    if (model?.match)
      for (const entity of (
        await this.store.discovery.unsettled(event.id)
      ).slice(0, 3)) {
        try {
          const matched = await model.match(entity, item, signal);
          if (matched)
            await this.store.discovery.alias(
              event.id,
              entity.kind,
              matched,
              entity.value,
            );
        } catch (error) {
          console.error(
            `Discovery could not match a name: ${safeError(error)}`,
          );
        }
      }
    const found = new Map<string, { score: number; why: string[] }>();
    const add = (id: string, score: number, why: string) => {
      const entry = found.get(id) ?? { score: 0, why: [] };
      entry.score += score;
      if (!entry.why.includes(why)) entry.why.push(why);
      found.set(id, entry);
    };
    const size = this.options.historySize ?? 12;
    const ignoreDomains = settings.trusted
      .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
      .filter((entry) => entry && !entry.includes('@'));
    for (const match of await this.store.discovery.related(event.id, {
      limit: size,
      ignoreDomains,
    }))
      for (const [index, shared] of match.shared.entries())
        add(match.eventId, index ? 0 : match.score, `both mention ${shared}`);
    if (event.from)
      for (const earlier of await this.store.recentFrom(
        event.from,
        event.occurredAt,
        this.windowMs,
        event.id,
      ))
        add(earlier.id, 1, 'same sender in the last few days');
    const embedder = this.options.embedder?.();
    if (embedder)
      try {
        if (
          !(await this.store.discovery.hasEmbedding(event.id, embedder.model))
        )
          await this.embed(embedder, [event]);
        for (const near of await this.store.discovery.nearest(
          event.id,
          embedder.model,
          { limit: size },
        ))
          add(near.eventId, (1 - near.distance) * 2, 'similar wording');
      } catch (error) {
        console.error(`Could not find similar items: ${safeError(error)}`);
      }
    const rejected = await this.store.discovery.rejected(event.id);
    const history: HistoryItem[] = [];
    for (const [id, entry] of [...found]
      .filter(([id]) => !rejected.has(id))
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, size)) {
      const earlier = await this.store.event(id);
      if (earlier)
        history.push({
          event: earlier,
          app: earlier.sourceName,
          why: entry.why,
        });
    }
    return history;
  }

  private async judge(batch: NewEvents) {
    const config = batch.source.config as ComposioSourceConfig;
    const app = DISCOVERY_TOOLKITS[config.toolkit]?.name ?? config.toolkit;
    const flagged: FindingView[] = [];
    for (const event of batch.events.slice(0, this.options.maxJudged ?? 25)) {
      if (this.controller.signal.aborted) return;
      if (await this.store.findingForEvent(event.id)) continue;
      const settings = await this.store.discovery.settings();
      let verdict: Verdict | undefined = ruleVerdict(
        await this.store.payload(event.id),
      );
      let judgedBy = 'rules';
      if (!verdict) {
        const model = this.options.judge();
        if (!model) return;
        const item: JudgeItem = { ...event, app };
        try {
          const history = await this.gather(event, item, model, settings);
          verdict = await model.judge(item, history, this.controller.signal);
          judgedBy = model.name;
        } catch (error) {
          // Left unjudged; the item stays in the Inbox as an ordinary event.
          console.error(`Discovery model failed: ${safeError(error)}`);
          continue;
        }
      }
      const finding = await this.decide(event, verdict, judgedBy, {
        config,
        settings,
      });
      if (finding.state !== 'flagged') continue;
      if (finding.route === 'tell') await this.deliver(finding, event);
      else flagged.push(finding);
    }
    for (const finding of flagged
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.options.maxInvestigations ?? 5))
      await this.investigate(finding.id);
  }

  /** Code's half: maps Jev's answers to a finding and to earlier items. */
  private async decide(
    event: InboxEventView,
    verdict: Verdict,
    judgedBy: string,
    context: { config: ComposioSourceConfig; settings: DiscoverySettings },
  ) {
    const rejected = await this.store.discovery.rejected(event.id);
    const related = verdict.related.filter(
      (entry) => !rejected.has(entry.eventId),
    );
    for (const entry of related)
      if (entry.same >= REVIEW)
        await this.store.discovery.link(
          event.id,
          entry.eventId,
          entry.same,
          entry.same >= LINK ? 'linked' : 'review',
        );
    const linked = related
      .filter((entry) => entry.same >= LINK)
      .sort((a, b) => b.same - a.same);
    // The item this one is about: the strongest link that was itself
    // flagged, so a follow-up joins the conversation already under way.
    let referenced:
      { entry: RelatedVerdict; finding?: FindingView } | undefined;
    for (const entry of linked) {
      const finding = await this.store.findingForEvent(entry.eventId);
      if (finding?.attention) {
        referenced = { entry, finding };
        break;
      }
      referenced ??= { entry, finding };
    }
    const asksSomething = !!verdict.asked && verdict.asked !== 'nothing';
    const attention =
      (verdict.attention && verdict.confidence >= this.threshold) ||
      verdict.injection ||
      (!!referenced?.finding?.attention &&
        asksSomething &&
        referenced.entry.resolves < YES);
    const canAct =
      (await (this.options.appsAllowed?.() ?? Promise.resolve(false))) &&
      context.settings.allowedApps.includes(context.config.toolkit);
    const finding = await this.store.saveFinding({
      eventId: event.id,
      attention,
      category: verdict.category,
      confidence: verdict.confidence,
      reason: verdict.injection
        ? `Contains instructions aimed at an AI assistant; shown to you only. ${verdict.reason}`
        : verdict.reason,
      judgedBy,
      dotId: context.config.dotId,
      referencedEventId: referenced?.entry.eventId ?? null,
      urgency: verdict.urgency,
      asked: verdict.asked,
      injection: verdict.injection,
      route: attention
        ? routeFor(verdict.asked, { injection: verdict.injection, canAct })
        : null,
      answers: verdict.answers,
    });
    const notes: { event: InboxEventView; note: string }[] = [];
    for (const entry of related) {
      const earlier = await this.store.event(entry.eventId);
      if (!earlier) continue;
      if (entry.useful >= YES)
        notes.push({
          event: earlier,
          note: 'holds facts useful for answering',
        });
      if (entry.contradicts >= YES)
        notes.push({ event: earlier, note: 'contradicts the new item' });
      if (entry.same >= LINK)
        await this.updateEarlier(
          event,
          earlier,
          entry,
          verdict,
          context.settings,
        );
    }
    if (notes.length) this.notes.set(finding.id, notes);
    return finding;
  }

  /** What the new item changes about an earlier one it is about. */
  private async updateEarlier(
    event: InboxEventView,
    earlier: InboxEventView,
    entry: RelatedVerdict,
    verdict: Verdict,
    settings: DiscoverySettings,
  ) {
    const finding = await this.store.findingForEvent(earlier.id);
    if (!finding || finding.state === 'resolved') return;
    if (entry.resolves >= YES) {
      if (
        !verdict.injection &&
        mayDowngrade(event.from, earlier.from, settings.trusted)
      ) {
        await this.store.updateFinding(finding.id, {
          state: 'resolved',
          note: `A later item says this no longer needs you: ${event.title}`,
        });
        await this.options.delivery?.cancel(finding.id, {
          title: 'No longer needed',
          body: this.previews()
            ? `A later item says "${earlier.title}" no longer needs you.`.slice(
                0,
                160,
              )
            : 'A later item says something you were told about no longer needs you.',
        });
      } else
        await this.store.updateFinding(finding.id, {
          note: `${event.from ?? 'Someone'} says this can be ignored, but isn't its sender or in your organisation, so it stays flagged.`,
        });
      return;
    }
    if (entry.escalates >= YES) {
      const next =
        URGENCIES[
          Math.min(URGENCIES.indexOf(finding.urgency ?? 'tomorrow') + 1, 3)
        ];
      const urgency = raise(next, verdict.urgency);
      const updated = await this.store.updateFinding(finding.id, {
        attention: true,
        urgency,
        note: `Made more urgent by a later item: ${event.title}`,
        ...(finding.state === 'ignored'
          ? {
              state: 'flagged' as const,
              route:
                finding.route ??
                routeFor(finding.asked, {
                  injection: finding.injection,
                  canAct: false,
                }),
            }
          : {}),
      });
      if (!updated) return;
      if (updated.state === 'flagged' && updated.route !== 'tell')
        await this.investigate(updated.id);
      else if (updated.state === 'ready' || updated.route === 'tell') {
        // Already delivered or waiting: deliver again at the new urgency.
        await this.options.delivery?.cancel(updated.id);
        await this.deliver(updated, earlier);
      }
    }
  }

  private previews() {
    return this.options.previews?.() ?? false;
  }
  private async deliver(finding: FindingView, event: InboxEventView) {
    const delivery = this.options.delivery;
    if (!delivery) return;
    const name =
      (finding.dotId && (await this.options.dotName?.(finding.dotId))) ||
      'Your Dot';
    const how = await delivery.deliver(finding, event, name);
    await this.store.updateFinding(finding.id, { delivery: how });
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
          history: this.notes.get(finding.id),
        },
        AbortSignal.any([
          this.controller.signal,
          AbortSignal.timeout(
            this.options.investigationTimeoutMs ?? 10 * 60_000,
          ),
        ]),
      );
      this.notes.delete(finding.id);
      // A later item may have resolved this one while the Dot worked.
      const now = await this.store.finding(finding.id);
      const done = await this.store.updateFinding(finding.id, {
        state: now?.state === 'resolved' ? 'resolved' : 'ready',
        threadId,
      });
      // The item this one followed up on now shares this conversation, so
      // it never needs a standalone investigation of its own.
      if (
        sameDot &&
        referencedFinding!.threadId !== threadId &&
        referencedFinding!.state !== 'resolved'
      )
        await this.store.updateFinding(referencedFinding!.id, {
          state: 'ready',
          threadId,
        });
      if (done?.state !== 'ready') return;
      await this.deliver(done, event);
      for (const listener of this.ready) {
        try {
          await listener(done, event);
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
