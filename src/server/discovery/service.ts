import {
  DISCOVERY_APPS,
  URGENCIES,
  type Asked,
  type AccountSourceConfig,
  type DiscoverySettings,
  type FindingView,
  type InboxEventView,
  type ProposalView,
  type Route,
  type Urgency,
} from '../../shared/inbox-types.js';
import type { NewEvents } from '../inbox/engine.js';
import type { InboxStore } from '../inbox/store.js';
import { extractTags } from '../inbox/tags.js';
import type { MemoryService } from '../memory/service.js';
import type { EntityKind, Fact, Resolved } from '../memory/store.js';
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
import {
  importanceOf,
  quietedBySender,
  type ProposalService,
} from './proposals.js';

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
    history?: HistoryNote[];
    /** Names, projects, places and keys tagged in the item. */
    tags?: { kind: string; value: string }[];
  },
  signal: AbortSignal,
) => Promise<{ threadId: string; reply?: string }>;
/** An earlier item for the investigating Dot, and why it matters. */
export interface HistoryNote {
  event: InboxEventView;
  /** What Jev said about it: useful for answering, or contradicting. */
  note: string;
  /** Why it was gathered: same sender, both mention X, similar wording. */
  found?: string[];
}
type ReadyListener = (finding: FindingView, event: InboxEventView) => unknown;

// A "same thing" score of 0.8 or more links two items; 0.5 to 0.8 goes to
// the owner's review queue; below 0.5 they stay unlinked.
const LINK = 0.8;
const REVIEW = 0.5;
// Entities that name one matter, so closing one item can close others.
const IDENTIFIERS = new Set<EntityKind>(['invoice', 'order', 'ticket']);

/** What deciding one item needs besides the verdict. */
interface Context {
  config: AccountSourceConfig;
  settings: DiscoverySettings;
  /** The known entities the item mentions. */
  entities: Resolved[];
}
/** An earlier item still stored, with Jev's answers about it. */
interface Related {
  entry: RelatedVerdict;
  earlier: InboxEventView;
}
/** The earlier item a new one is about. */
interface Referenced {
  entry: RelatedVerdict;
  finding?: FindingView;
}
/** What is left of a pruned item, as text for Jev. */
const noteText = (fact: Fact) =>
  [
    'Only a note of this item is kept.',
    fact.amounts?.length ? `Amounts: ${fact.amounts.join(', ')}.` : '',
    fact.status ? `Outcome: ${fact.status}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

const safeError = (error: unknown) =>
  (error instanceof Error && error.message
    ? error.message
    : 'The investigation did not finish.'
  ).slice(0, 300);
/** A sender's bare address, lower case. */
export const address = (from: string | null | undefined) =>
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
  return later === address(earlierFrom) || fromOwner(laterFrom, trusted);
}

/** Whether a sender is the owner or in the owner's organisation. */
export function fromOwner(from: string | null, trusted: string[]) {
  const sender = address(from);
  if (!sender) return false;
  const domain = sender.split('@')[1] ?? '';
  return trusted.some((entry) => {
    const value = entry.trim().toLowerCase().replace(/^@/, '');
    return value.includes('@')
      ? value === sender
      : !!domain && (domain === value || domain.endsWith(`.${value}`));
  });
}
/** Set only when the owner listed their addresses, so an empty list says nothing. */
const ownerFact = (from: string | null, trusted: string[]) =>
  trusted.length ? fromOwner(from, trusted) : undefined;

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
 * 1. Gather earlier items it could relate to from memory: the people,
 *    companies, invoices and projects it mentions, and every earlier item
 *    in them, including pruned items known only by their facts.
 * 2. Judge it with that history in one Jev call.
 * 3. Decide, in code: link the same thing, save the finding, and update
 *    earlier items: resolve what the new item says is done (from trusted
 *    senders only, and every open item about the same invoice, order or
 *    ticket with it), escalate what it makes more urgent.
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
  private notes = new Map<string, HistoryNote[]>();
  constructor(
    private store: InboxStore,
    private options: {
      judge: () => Judge | undefined;
      investigate: Investigate;
      /** Entities and their facts, for history; none when left out. */
      memory?: MemoryService;
      /** Sends the push for a finding; tests may leave it out. */
      delivery?: DeliveryService;
      /** Offers the owner's three choices on what a Dot looked into. */
      proposals?: ProposalService;
      /** A Dot's name, for pushes. */
      dotName?: (dotId: string) => Promise<string | undefined>;
      /** Whether pushes may quote item text (PUSH_PREVIEWS). */
      previews?: () => boolean;
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
      /** false: flag items but never start a Dot on its own (tests, scenarios). */
      autoInvestigate?: boolean;
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
    if (!batch.events.length || batch.source.type !== 'account') return;
    const work = this.classifying.then(() => this.judge(batch));
    this.classifying = work.catch((error: unknown) => {
      console.error(`Discovery could not judge new items: ${safeError(error)}`);
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

  /**
   * Earlier items this one could relate to, strongest first, and why each
   * was picked: every earlier item in the entities it mentions, including
   * items already pruned, which are known by their facts alone. Code only,
   * apart from Jev's match for names memory can't settle.
   */
  async gather(
    event: InboxEventView,
    settings: DiscoverySettings,
  ): Promise<{ history: HistoryItem[]; entities: Resolved[] }> {
    const memory = this.options.memory;
    if (!memory) return { history: [], entities: [] };
    // Everything that came before is in its entities first. Best effort:
    // what is already in memory still counts.
    try {
      await memory.distill(settings, event.occurredAt);
    } catch (error) {
      console.error(`Memory could not catch up: ${safeError(error)}`);
    }
    const entities = await memory.resolve(event.id, settings);
    const found = new Map<
      string,
      { score: number; why: Map<string, number>; fact: Fact }
    >();
    for (const entity of entities)
      for (const fact of entity.facts) {
        // History is what came before; never a later item.
        if (fact.eventId === event.id || fact.at > event.occurredAt) continue;
        const { score, why } = this.weigh(entity, fact, event);
        const entry = found.get(fact.eventId) ?? {
          score: 0,
          why: new Map<string, number>(),
          fact,
        };
        entry.score += score;
        entry.why.set(why, Math.max(entry.why.get(why) ?? 0, score));
        found.set(fact.eventId, entry);
      }
    const rejected = await this.store.discovery.rejected(event.id);
    const history: HistoryItem[] = [];
    for (const [id, entry] of [...found]
      .filter(([id]) => !rejected.has(id))
      .sort((a, b) => b[1].score - a[1].score || b[1].fact.at - a[1].fact.at)
      .slice(0, this.options.historySize ?? 12)) {
      const earlier = await this.store.event(id);
      const { fact } = entry;
      // The strongest reason first.
      const why = [...entry.why]
        .sort((a, b) => b[1] - a[1])
        .map(([reason]) => reason);
      history.push(
        earlier
          ? {
              event: earlier,
              app: earlier.sourceName,
              fromOwner: ownerFact(earlier.from, settings.trusted),
              why,
            }
          : {
              event: {
                id,
                title: fact.title,
                summary: noteText(fact),
                from: fact.from,
                kind: fact.kind ?? 'item',
                occurredAt: fact.at,
              },
              app: fact.app,
              fromOwner: ownerFact(fact.from, settings.trusted),
              why,
              pruned: true,
            },
      );
    }
    return { history, entities };
  }
  /** How much one shared entity says about an earlier item, and why. */
  private weigh(entity: Resolved, fact: Fact, event: InboxEventView) {
    switch (entity.kind) {
      case 'invoice':
      case 'order':
      case 'ticket':
        return { score: 3, why: `both mention ${entity.kind} ${entity.name}` };
      case 'project':
      case 'place':
      case 'name':
        return { score: 1.5, why: `both mention ${entity.name}` };
      case 'person':
        if (entity.role !== 'sender')
          return { score: 1, why: `both mention ${entity.name}` };
        return address(fact.from) === address(event.from)
          ? {
              // A sender's recent items say more than old ones.
              score: event.occurredAt - fact.at <= this.windowMs ? 1 : 0.5,
              why: 'same sender',
            }
          : { score: 1, why: `about ${entity.name}, who sent this` };
      default:
        return { score: 0.5, why: `both involve ${entity.name}` };
    }
  }

  private async judge(batch: NewEvents) {
    const config = batch.source.config as AccountSourceConfig;
    const app = DISCOVERY_APPS[config.app]?.name ?? config.app;
    const flagged: FindingView[] = [];
    for (const event of batch.events.slice(0, this.options.maxJudged ?? 25)) {
      if (this.controller.signal.aborted) return;
      if (await this.store.findingForEvent(event.id)) continue;
      const settings = await this.store.discovery.settings();
      let verdict: Verdict | undefined = ruleVerdict(
        await this.store.payload(event.id),
      );
      let judgedBy = 'rules';
      let entities: Resolved[] = [];
      if (!verdict) {
        const model = this.options.judge();
        if (!model) return;
        const item: JudgeItem = {
          ...event,
          app,
          fromOwner: ownerFact(event.from, settings.trusted),
        };
        try {
          const gathered = await this.gather(event, settings);
          const history = gathered.history;
          entities = gathered.entities;
          verdict = await model.judge(item, history, this.controller.signal);
          judgedBy = model.name;
          // Why each earlier item was gathered, kept with Jev's answers so
          // the investigating Dot is told even after a restart.
          if (verdict.answers && typeof verdict.answers === 'object')
            verdict = {
              ...verdict,
              answers: {
                ...(verdict.answers as Record<string, unknown>),
                found_by: Object.fromEntries(
                  history.map((entry) => [entry.event.id, entry.why]),
                ),
              },
            };
        } catch (error) {
          // Left unjudged; the item stays in the Inbox as an ordinary event.
          console.error(`Discovery model failed: ${safeError(error)}`);
          continue;
        }
      }
      const finding = await this.decide(event, verdict, judgedBy, {
        config,
        settings,
        entities,
      });
      if (finding.state !== 'flagged') continue;
      if (finding.route === 'tell') await this.deliver(finding, event);
      else flagged.push(finding);
    }
    for (const finding of flagged
      .sort((a, b) => b.confidence - a.confidence)
      .slice(
        0,
        this.options.autoInvestigate === false
          ? 0
          : (this.options.maxInvestigations ?? 5),
      ))
      await this.investigate(finding.id);
  }

  /**
   * Code's half: maps Jev's answers to a finding and to earlier items, in
   * three steps.
   */
  private async decide(
    event: InboxEventView,
    verdict: Verdict,
    judgedBy: string,
    context: Context,
  ) {
    const { related, referenced } = await this.linkEarlier(event, verdict);
    const finding = await this.saveVerdict(
      event,
      verdict,
      judgedBy,
      referenced,
      context,
    );
    await this.followUp(event, finding, related, verdict, context);
    return finding;
  }

  /**
   * Step 1: links the earlier items Jev says are the same thing, and picks
   * the one this item is about. Items already pruned can't be linked.
   */
  private async linkEarlier(event: InboxEventView, verdict: Verdict) {
    const rejected = await this.store.discovery.rejected(event.id);
    const related: Related[] = [];
    for (const entry of verdict.related) {
      if (rejected.has(entry.eventId)) continue;
      const earlier = await this.store.event(entry.eventId);
      if (earlier) related.push({ entry, earlier });
    }
    for (const { entry } of related)
      if (entry.same >= REVIEW)
        await this.store.discovery.link(
          event.id,
          entry.eventId,
          entry.same,
          entry.same >= LINK ? 'linked' : 'review',
        );
    // The item this one is about: the strongest link that was itself
    // flagged, so a follow-up joins the conversation already under way.
    let referenced: Referenced | undefined;
    for (const { entry } of related
      .filter(({ entry }) => entry.same >= LINK)
      .sort((a, b) => b.entry.same - a.entry.same)) {
      const finding = await this.store.findingForEvent(entry.eventId);
      if (finding?.attention) {
        referenced = { entry, finding };
        break;
      }
      referenced ??= { entry, finding };
    }
    return { related, referenced };
  }

  /** Step 2: whether the item needs the owner, and the route if so. */
  private async saveVerdict(
    event: InboxEventView,
    verdict: Verdict,
    judgedBy: string,
    referenced: Referenced | undefined,
    context: Context,
  ) {
    const asksSomething = !!verdict.asked && verdict.asked !== 'nothing';
    // The triage rule the owner's dismissals feed: a sender they keep
    // dismissing is no longer flagged.
    const sender = address(event.from);
    const quieted =
      !!sender &&
      quietedBySender(
        await this.store.discovery.proposals.senderHistory(sender),
        verdict,
      );
    const attention =
      !quieted &&
      ((verdict.attention && verdict.confidence >= this.threshold) ||
        verdict.injection ||
        (!!referenced?.finding?.attention &&
          asksSomething &&
          referenced.entry.resolves < YES));
    const canAct = context.settings.allowedApps.includes(context.config.app);
    return this.store.saveFinding({
      eventId: event.id,
      attention,
      category: verdict.category,
      confidence: verdict.confidence,
      reason: verdict.injection
        ? `Contains instructions aimed at an AI assistant; shown to you only. ${verdict.reason}`
        : quieted
          ? `Not flagged: you dismissed recent items from ${sender}. ${verdict.reason}`
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
  }

  /**
   * Step 3: notes for the investigating Dot, and what the item changes
   * about the earlier items it is the same thing as.
   */
  private async followUp(
    event: InboxEventView,
    finding: FindingView,
    related: Related[],
    verdict: Verdict,
    context: Context,
  ) {
    const notes: HistoryNote[] = [];
    const foundBy = (verdict.answers as { found_by?: Record<string, string[]> })
      ?.found_by;
    for (const { entry, earlier } of related) {
      const found = foundBy?.[earlier.id] ?? [];
      if (entry.useful >= YES)
        notes.push({
          event: earlier,
          note: 'holds facts useful for answering',
          found,
        });
      if (entry.contradicts >= YES)
        notes.push({ event: earlier, note: 'contradicts the new item', found });
      if (entry.same >= LINK)
        await this.updateEarlier(event, earlier, entry, verdict, context);
    }
    if (notes.length) this.notes.set(finding.id, notes);
  }

  /**
   * The earlier items Jev rated useful or contradicting, rebuilt from the
   * answers saved with the finding: for an investigation started after a
   * restart, or by hand later.
   */
  private async storedNotes(findingId: string): Promise<HistoryNote[]> {
    const saved = (await this.store.findingAnswers(findingId)) as {
      earlier?: Record<string, string>;
      answers?: Record<string, { noul?: number }>;
      found_by?: Record<string, string[]>;
    } | null;
    const notes: HistoryNote[] = [];
    for (const [label, eventId] of Object.entries(saved?.earlier ?? {})) {
      const earlier = await this.store.event(eventId);
      if (!earlier) continue;
      const found = saved?.found_by?.[eventId] ?? [];
      if ((saved?.answers?.[`useful__${label}`]?.noul ?? 0) >= YES)
        notes.push({
          event: earlier,
          note: 'holds facts useful for answering',
          found,
        });
      if ((saved?.answers?.[`contradicts__${label}`]?.noul ?? 0) >= YES)
        notes.push({ event: earlier, note: 'contradicts the new item', found });
    }
    return notes;
  }

  /** What the new item changes about an earlier one it is about. */
  private async updateEarlier(
    event: InboxEventView,
    earlier: InboxEventView,
    entry: RelatedVerdict,
    verdict: Verdict,
    context: Context,
  ) {
    const finding = await this.store.findingForEvent(earlier.id);
    if (!finding || finding.state === 'resolved') return;
    if (entry.resolves >= YES) {
      if (
        !verdict.injection &&
        mayDowngrade(event.from, earlier.from, context.settings.trusted)
      ) {
        await this.close(finding, earlier, event);
        await this.closeSiblings(event, earlier, context);
      } else
        await this.store.updateFinding(finding.id, {
          note: `${event.from ?? 'Someone'} says this can be ignored, but isn't its sender or in your organisation, so it stays flagged.`,
        });
      return;
    }
    if (entry.escalates >= YES)
      await this.escalate(finding, earlier, event, verdict);
  }

  /** A later item says an earlier one no longer needs the owner. */
  private async close(
    finding: FindingView,
    earlier: InboxEventView,
    event: InboxEventView,
  ) {
    await this.store.updateFinding(finding.id, {
      state: 'resolved',
      note: `A later item says this no longer needs you: ${event.title}`,
      resolvedBy: event.id,
    });
    await this.store.discovery.proposals.close(finding.id);
    await this.options.delivery?.cancel(finding.id, {
      title: 'No longer needed',
      body: this.previews()
        ? `A later item says "${earlier.title}" no longer needs you.`.slice(
            0,
            160,
          )
        : 'A later item says something you were told about no longer needs you.',
    });
  }

  /**
   * Closing works through the entity: once an item is done, other open
   * items about the same invoice, order or ticket, which both it and the
   * new item mention, are done too. The sender rule applies to each.
   */
  private async closeSiblings(
    event: InboxEventView,
    earlier: InboxEventView,
    context: Context,
  ) {
    const mentioned = new Set(
      context.entities
        .filter((entity) => IDENTIFIERS.has(entity.kind))
        .map((entity) => entity.id),
    );
    if (!mentioned.size) return;
    const memory = this.store.memory;
    const shared = (await memory.entitiesOf(earlier.id)).filter((id) =>
      mentioned.has(id),
    );
    for (const id of await memory.eventsFor(shared)) {
      if (id === event.id || id === earlier.id) continue;
      const other = await this.store.event(id);
      const finding = await this.store.findingForEvent(id);
      if (
        !other ||
        !finding ||
        other.occurredAt > event.occurredAt ||
        finding.state === 'resolved' ||
        finding.state === 'ignored' ||
        !mayDowngrade(event.from, other.from, context.settings.trusted)
      )
        continue;
      await this.close(finding, other, event);
    }
  }

  /** A later item makes an earlier one more urgent. */
  private async escalate(
    finding: FindingView,
    earlier: InboxEventView,
    event: InboxEventView,
    verdict: Verdict,
  ) {
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
    await this.store.discovery.proposals.escalate(
      updated.id,
      urgency,
      importanceOf(urgency, updated.confidence),
    );
    if (updated.state === 'flagged' && updated.route !== 'tell') {
      if (this.options.autoInvestigate !== false)
        await this.investigate(updated.id);
    } else if (updated.state === 'ready' || updated.route === 'tell') {
      // Already delivered or waiting: deliver again at the new urgency.
      await this.options.delivery?.cancel(updated.id);
      await this.deliver(
        updated,
        earlier,
        await this.store.discovery.proposals.forFinding(updated.id),
      );
    }
  }

  private previews() {
    return this.options.previews?.() ?? false;
  }
  private async deliver(
    finding: FindingView,
    event: InboxEventView,
    proposal?: ProposalView,
  ) {
    const delivery = this.options.delivery;
    if (!delivery) return;
    const name =
      (finding.dotId && (await this.options.dotName?.(finding.dotId))) ||
      'Your Dot';
    const how = await delivery.deliver(finding, event, name, proposal);
    await this.store.updateFinding(finding.id, { delivery: how });
  }

  private async run(findingId: string) {
    const finding = await this.store.finding(findingId);
    const event = finding && (await this.store.event(finding.eventId));
    if (!finding?.dotId || !event || this.controller.signal.aborted) return;
    const source = await this.store.source(event.sourceId);
    const app =
      source?.type === 'account'
        ? (source.config as AccountSourceConfig).app
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
      const appName = (app && DISCOVERY_APPS[app]?.name) || event.sourceName;
      const { threadId, reply } = await this.options.investigate(
        {
          dotId: finding.dotId,
          app: appName,
          event,
          finding,
          referencedEvent,
          existingThreadId,
          history:
            this.notes.get(finding.id) ?? (await this.storedNotes(finding.id)),
          tags: extractTags(event)
            .map(({ kind, value }) => ({ kind, value }))
            .sort(
              (a, b) =>
                a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
            ),
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
      // The owner's three choices, in this same conversation. A follow-up
      // that continued an earlier item's thread brings its proposal back.
      const proposal = await this.options.proposals?.offer(done, event, {
        threadId,
        reply,
        app: appName,
        sender: address(event.from),
      });
      await this.deliver(done, event, proposal);
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
