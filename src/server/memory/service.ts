import type { DiscoverySettings } from '../../shared/inbox-types.js';
import type { Judge, JudgeItem } from '../discovery/classifier.js';
import { localTime } from '../discovery/delivery.js';
import { address, fromOwner } from '../discovery/service.js';
import type { InboxStore } from '../inbox/store.js';
import { SHARED_DOMAINS, extractTags, type Tag } from '../inbox/tags.js';
import type {
  Alias,
  AliasFamily,
  EntityKind,
  Fact,
  Mention,
  MemoryStore,
  PendingItem,
  Resolved,
} from './store.js';

// Entities taken from one item; the rest are left out.
const MAX_MENTIONS = 12;
// A near spelling of a known name is the same thing without asking.
const SURE = 0.8;
// Below this a spelling says nothing.
const ALIKE = 0.3;

const FAMILY: Partial<Record<Tag['kind'], AliasFamily>> = {
  invoice: 'invoice',
  order: 'order',
  ticket: 'ticket',
  project: 'name',
  place: 'name',
  name: 'name',
  person: 'person',
  email: 'email',
  domain: 'domain',
};
const safeError = (error: unknown) =>
  (error instanceof Error ? error.message : 'unknown error').slice(0, 300);
const displayName = (from: string | null) =>
  from?.match(/^\s*"?([^"<@]{2,80}?)"?\s*</)?.[1]?.trim();
const normalizeName = (value: string) =>
  value.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Memory: what each item said, kept in its entities so the item itself can
 * go. Every 15 minutes it distills new items; once a day it prunes items
 * past the retention window (only ones already distilled, never one still
 * waiting on the owner) and writes the day's line for the morning brief.
 *
 * Matching an item to entities runs cheapest first:
 * 1. Exact names and identifiers already known (free).
 * 2. Structure: the sender's address, and their company's domain (free).
 * 3. Near spellings of a known name (cheap; pg_trgm).
 * 4. Jev, for spellings code can't settle, a few per item and only for
 *    recent items, so a first backfill costs nothing.
 * 5. The owner, who can merge two entities that are one thing.
 *
 * An item that only says an earlier one is done adds that to the earlier
 * item's entities and nothing else.
 */
export class MemoryService {
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<{ distilled: number; pruned: number }>;
  private controller = new AbortController();
  constructor(
    private inbox: InboxStore,
    private options: {
      /** Owns items from sources with no account, such as webhooks. */
      ownerId: string;
      judge?: () => Judge | undefined;
      /** Nothing runs while the owner has paused OpenDots. */
      paused?: () => Promise<boolean>;
      now?: () => number;
      /** Jev calls per item. */
      maxJudged?: number;
      /** Only items received this recently are worth a Jev call. */
      judgeWindowMs?: number;
    },
  ) {}
  private get store(): MemoryStore {
    return this.inbox.memory;
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  start(intervalMs = 15 * 60_000) {
    this.timer ??= setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
    void this.tick();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller.abort(new Error('Server stopped.'));
  }
  /** Distills what is new, and once a day prunes and reports. */
  tick() {
    this.ticking ??= this.run()
      .catch((error: unknown) => {
        console.error(`Memory could not distill items: ${safeError(error)}`);
        return { distilled: 0, pruned: 0 };
      })
      .finally(() => (this.ticking = undefined));
    return this.ticking;
  }
  private async run() {
    if (await this.options.paused?.()) return { distilled: 0, pruned: 0 };
    const settings = await this.inbox.discovery.settings();
    const distilled = await this.distill(settings);
    const pruned = await this.daily(settings);
    return { distilled, pruned };
  }

  /**
   * Distills every item that is ready; returns how many. With `before`,
   * items that happened earlier are ready too: discovery calls this so an
   * item is judged against everything that came before it.
   */
  async distill(settings: DiscoverySettings, before?: number) {
    let count = 0;
    for (;;) {
      const items = await this.store.pending(this.options.ownerId, {
        limit: 100,
        now: this.now(),
        before,
      });
      if (!items.length) return count;
      for (const item of items) {
        if (this.controller.signal.aborted) return count;
        if (await this.distillItem(item, settings)) count++;
      }
      if (items.length < 100) return count;
    }
  }

  /**
   * The known entities a stored item mentions, matched the same way as
   * when it is distilled, without writing anything. New names have no
   * history yet, so they are left out.
   */
  async resolve(eventId: string, settings: DiscoverySettings) {
    const item = await this.store.item(this.options.ownerId, eventId);
    if (!item) return [];
    const mentions = await this.mentions(item, extractTags(item), settings);
    const known = new Map<string, Mention & { entityId: string }>();
    for (const mention of mentions)
      if ('entityId' in mention && !known.has(mention.entityId))
        known.set(mention.entityId, mention);
    const entities = await this.store.entities(item.ownerId, [...known.keys()]);
    return entities.map((entity): Resolved => {
      const mention = known.get(entity.id)!;
      return {
        id: entity.id,
        kind: entity.kind,
        name: entity.name,
        how: mention.how,
        role: mention.role,
        facts: entity.facts,
      };
    });
  }

  private async distillItem(item: PendingItem, settings: DiscoverySettings) {
    const tags = extractTags(item);
    const fact: Fact = {
      at: item.occurredAt,
      eventId: item.id,
      sourceId: item.sourceId,
      app: item.sourceName,
      title: item.title.slice(0, 200),
      from: item.from,
      kind: item.kind,
      ...(tags.some((tag) => tag.kind === 'amount')
        ? {
            amounts: tags
              .filter((tag) => tag.kind === 'amount')
              .map((tag) => tag.normalized)
              .slice(0, 5),
          }
        : {}),
      ...(item.category
        ? { status: `${item.category}, ${item.findingState}` }
        : {}),
      url: item.url,
      externalId: item.externalId,
    };
    // Tier 0: an item that closes an earlier matter needs no entities of
    // its own.
    if (item.resolvesEventId)
      return this.store.recordClosing(
        item,
        { ...fact, status: 'closed an earlier item' },
        this.now(),
      );
    const mentions = await this.mentions(item, tags, settings);
    return this.store.record(item, mentions, fact, this.now());
  }

  /** The entities an item mentions, matched cheapest first. */
  private async mentions(
    item: PendingItem,
    tags: Tag[],
    settings: DiscoverySettings,
  ): Promise<Mention[]> {
    const owner = item.ownerId;
    const trusted = settings.trusted
      .map((entry) => entry.trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);
    const ownDomain = (domain: string) =>
      trusted.some(
        (entry) =>
          !entry.includes('@') &&
          (domain === entry || domain.endsWith(`.${entry}`)),
      );
    const isOwner = (email: string) =>
      trusted.includes(email) || ownDomain(email.split('@')[1] ?? '');
    const out: Mention[] = [];
    const done = new Set<string>();
    const seen = (family: AliasFamily, normalized: string) => {
      const key = `${family}:${normalized}`;
      if (done.has(key)) return true;
      done.add(key);
      return false;
    };

    // The sender: by address, then by name. Never the owner themselves.
    const sender = address(item.from);
    if (sender.includes('@') && !fromOwner(item.from, settings.trusted)) {
      const name = displayName(item.from);
      const aliases: Alias[] = [
        { family: 'email', normalized: sender, value: sender },
        ...(name
          ? [
              {
                family: 'person' as const,
                normalized: normalizeName(name),
                value: name,
              },
            ]
          : []),
      ];
      aliases.forEach((alias) => seen(alias.family, alias.normalized));
      const known =
        (await this.store.lookup(owner, 'email', sender)) ??
        (name
          ? ((await this.store.lookup(owner, 'person', normalizeName(name))) ??
            (await this.ask(item, 'person', normalizeName(name), name)))
          : undefined);
      out.push(
        known
          ? { entityId: known, aliases, how: 'sender', role: 'sender' }
          : {
              create: { kind: 'person', name: name ?? sender },
              aliases,
              how: 'sender',
              role: 'sender',
            },
      );
      const domain = sender.split('@')[1] ?? '';
      if (domain && !SHARED_DOMAINS.has(domain) && !ownDomain(domain)) {
        seen('domain', domain);
        const alias: Alias = {
          family: 'domain',
          normalized: domain,
          value: domain,
        };
        const company = await this.store.lookup(owner, 'domain', domain);
        out.push(
          company
            ? {
                entityId: company,
                aliases: [alias],
                how: 'sender',
                role: 'employer',
              }
            : {
                create: { kind: 'company', name: domain },
                aliases: [alias],
                how: 'sender',
                role: 'employer',
              },
        );
      }
    }

    for (const tag of tags) {
      if (out.length >= MAX_MENTIONS) break;
      const family = FAMILY[tag.kind];
      if (!family || seen(family, tag.normalized)) continue;
      const alias: Alias = {
        family,
        normalized: tag.normalized,
        value: tag.value,
      };
      const known = await this.store.lookup(owner, family, tag.normalized);
      if (known) {
        out.push({ entityId: known, aliases: [alias], how: 'alias' });
        continue;
      }
      // Addresses and domains in the text only join what is already known;
      // the owner's own never do.
      if (family === 'email' || family === 'domain' || family === 'person')
        continue;
      if (family === 'name') {
        if (ownDomain(tag.normalized) || isOwner(tag.normalized)) continue;
        const near = await this.near(item, family, tag);
        if (near) {
          out.push({
            entityId: near.entityId,
            aliases: [alias],
            how: near.how,
          });
          continue;
        }
        // A plain capitalised name is often noise; keep it once it recurs.
        if (
          tag.kind === 'name' &&
          !(await this.store.recurs(item.id, tag.normalized))
        )
          continue;
      }
      out.push({
        create: {
          kind: tag.kind as EntityKind,
          // INV-2041 however it was written; names as written.
          name: family === 'name' ? tag.value : tag.normalized,
        },
        aliases: [alias],
        how: 'new',
      });
    }
    return out;
  }

  /** A known name spelled like this one: sure by code, or by Jev. */
  private async near(
    item: PendingItem,
    family: AliasFamily,
    tag: Tag,
  ): Promise<{ entityId: string; how: 'fuzzy' | 'jev' } | undefined> {
    const alike = await this.store.similar(
      item.ownerId,
      family,
      tag.normalized,
      { min: ALIKE },
    );
    const entities = [...new Set(alike.map((entry) => entry.entityId))];
    if (alike[0]?.similarity >= SURE && entities.length === 1)
      return { entityId: alike[0].entityId, how: 'fuzzy' };
    const matched = await this.ask(
      item,
      tag.kind === 'person' ? 'person' : 'name',
      tag.normalized,
      tag.value,
      alike,
    );
    return matched ? { entityId: matched, how: 'jev' } : undefined;
  }

  private judged = new Map<string, number>();
  /** Jev's answers per item and mention, so resolving and distilling one
   * item asks only once. */
  private answers = new Map<string, string | undefined>();
  /** Asks Jev which known person or name a mention is; within its budget. */
  private async ask(
    item: PendingItem,
    family: 'person' | 'name',
    normalized: string,
    value: string,
    alike?: Awaited<ReturnType<MemoryStore['similar']>>,
  ) {
    const key = `${item.id}|${family}|${normalized}`;
    if (this.answers.has(key)) return this.answers.get(key);
    const model = this.options.judge?.();
    if (!model?.match) return undefined;
    if (
      this.now() - item.receivedAt >
      (this.options.judgeWindowMs ?? 86_400_000)
    )
      return undefined;
    const used = this.judged.get(item.id) ?? 0;
    if (used >= (this.options.maxJudged ?? 3)) return undefined;
    const candidates =
      alike ??
      (await this.store.similar(item.ownerId, family, normalized, {
        min: ALIKE,
      }));
    if (!candidates.length) return undefined;
    this.judged.set(item.id, used + 1);
    if (this.judged.size > 1000) this.judged.clear();
    if (this.answers.size > 3000) this.answers.clear();
    const judgeItem: JudgeItem = {
      title: item.title,
      summary: item.summary,
      from: item.from,
      kind: item.kind,
      app: item.sourceName,
      occurredAt: item.occurredAt,
    };
    try {
      const picked = await model.match(
        {
          kind: family === 'person' ? 'person' : 'name',
          normalized,
          value,
          candidates: candidates.map(({ normalized, value }) => ({
            normalized,
            value,
          })),
        },
        judgeItem,
        this.controller.signal,
      );
      const entityId = candidates.find(
        (entry) => entry.normalized === picked,
      )?.entityId;
      this.answers.set(key, entityId);
      return entityId;
    } catch (error) {
      console.error(`Memory could not match a name: ${safeError(error)}`);
      return undefined;
    }
  }

  /**
   * Once a local day: prunes items past the retention window and writes the
   * day's line. Returns how many items were pruned.
   */
  async daily(settings: DiscoverySettings) {
    const now = this.now();
    const owner = this.options.ownerId;
    const day = localTime(now, settings.timeZone).date;
    const [last] = await this.store.runs(owner, 1);
    if (last?.day === day) return 0;
    // Counted first: pruning removes some of what was distilled.
    const distilled = await this.store.distilledSince(
      last?.createdAt ?? now - 86_400_000,
    );
    const pruned = await this.inbox.prune(
      now - settings.retentionDays * 86_400_000,
    );
    const entities = await this.store.entityCount(owner);
    const report = `Memory: ${distilled} new ${distilled === 1 ? 'item' : 'items'} noted, ${pruned} older ${pruned === 1 ? 'item' : 'items'} cleared, ${entities} ${entities === 1 ? 'thing' : 'things'} remembered.`;
    await this.store.saveRun(
      owner,
      day,
      { distilled, pruned, entities },
      report,
      now,
    );
    return pruned;
  }
}
