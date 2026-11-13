import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';

/** Sorts of real things OpenDots remembers. */
export type EntityKind =
  | 'person'
  | 'company'
  | 'project'
  | 'place'
  | 'name'
  | 'invoice'
  | 'order'
  | 'ticket';
/**
 * Alias families: tag kinds that name the same sort of thing share one, so
 * "Project Falcon" and a plain "Falcon" can be one entity.
 */
export type AliasFamily =
  'person' | 'email' | 'domain' | 'name' | 'invoice' | 'order' | 'ticket';
/** How an item was matched to an entity, cheapest first. */
type MatchHow = 'alias' | 'sender' | 'fuzzy' | 'jev' | 'new' | 'owner';

/** One thing an item said about an entity. Kept after the item is pruned. */
export interface Fact {
  at: number;
  eventId: string;
  sourceId: string;
  app: string;
  title: string;
  from: string | null;
  /** Amounts in the item, such as "ZAR 1200.00". */
  amounts?: string[];
  /** What discovery made of it: category and state. */
  status?: string;
  /** Where to read the item live once its text is pruned. */
  url?: string | null;
  externalId?: string;
}
export interface Alias {
  family: AliasFamily;
  normalized: string;
  value: string;
}
export interface EntityView {
  id: string;
  kind: EntityKind;
  name: string;
  mentions: number;
  firstSeenAt: number;
  lastSeenAt: number;
  facts: Fact[];
}
export interface EntityDetail extends EntityView {
  aliases: Alias[];
  related: {
    id: string;
    kind: EntityKind;
    name: string;
    relation: string;
    weight: number;
  }[];
}
/** An item not yet distilled, with what is needed to distill it. */
export interface PendingItem {
  id: string;
  ownerId: string;
  sourceId: string;
  sourceName: string;
  externalId: string;
  kind: string;
  title: string;
  summary: string;
  from: string | null;
  url: string | null;
  occurredAt: number;
  receivedAt: number;
  category: string | null;
  findingState: string | null;
  /** The earlier item this one said no longer needs the owner. */
  resolvesEventId: string | null;
}
/** One entity an item mentions: a known one, or one to create. */
export type Mention = {
  aliases: Alias[];
  how: MatchHow;
  /** The item's sender, or the company the sender's domain belongs to. */
  role?: 'sender' | 'employer';
} & ({ entityId: string } | { create: { kind: EntityKind; name: string } });

// Facts kept per entity, newest first.
const MAX_FACTS = 20;
const ENTITY = sql.raw(
  'id, kind, name, mentions, first_seen_at, last_seen_at, facts',
);
type EntityRow = Omit<EntityView, 'facts'> & { facts: string };
const view = ({ facts, ...row }: EntityRow): EntityView => ({
  ...row,
  facts: JSON.parse(facts) as Fact[],
});
const addFact = (facts: Fact[], fact: Fact) =>
  [fact, ...facts.filter((f) => f.eventId !== fact.eventId)]
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_FACTS);

/**
 * Entities: one fact sheet per real thing, the names it goes by, how things
 * relate, and which item mentioned what. Every row belongs to one owner.
 */
export class MemoryStore {
  constructor(private db: Db) {}

  /**
   * Items whose facts are not yet in their entities, oldest first. An item
   * from a judged source waits for discovery's verdict, or `settleMs`.
   * `defaultOwner` owns items from sources with no account (webhooks).
   */
  pending(
    defaultOwner: string,
    options: { limit?: number; settleMs?: number; now?: number } = {},
  ) {
    const now = options.now ?? Date.now();
    return this.db.rows<PendingItem>(
      sql`SELECT e.id, COALESCE(a.user_id, ${defaultOwner}) AS owner_id, e.source_id, COALESCE(s.name, 'Removed source') AS source_name,
          e.external_id, e.kind, e.title, e.summary, e.sender AS "from", e.url, e.occurred_at, e.received_at,
          f.category, f.state AS finding_state,
          (SELECT r.event_id FROM discovery_findings r WHERE r.resolved_by=e.id LIMIT 1) AS resolves_event_id
        FROM inbox_events e
        LEFT JOIN inbox_sources s ON s.id=e.source_id
        LEFT JOIN accounts a ON s.type='account' AND a.id=(s.config::jsonb->>'accountId')
        LEFT JOIN discovery_findings f ON f.event_id=e.id
        WHERE e.distilled_at IS NULL
          AND (f.id IS NOT NULL OR s.type IS DISTINCT FROM 'account' OR e.received_at<=${now - (options.settleMs ?? 3_600_000)})
        ORDER BY e.occurred_at, e.seq LIMIT ${options.limit ?? 200}`,
    );
  }

  /** The entity an exact name or identifier belongs to. */
  async lookup(ownerId: string, family: AliasFamily, normalized: string) {
    return (
      await this.db.row<{ entityId: string }>(
        sql`SELECT entity_id FROM entity_aliases WHERE owner_id=${ownerId} AND family=${family} AND normalized=${normalized}`,
      )
    )?.entityId;
  }
  /** Aliases spelled like this one (trigram similarity), most alike first. */
  similar(
    ownerId: string,
    family: AliasFamily,
    normalized: string,
    options: { min?: number; limit?: number } = {},
  ) {
    return this.db.rows<{
      entityId: string;
      normalized: string;
      value: string;
      similarity: number;
    }>(
      sql`SELECT entity_id, normalized, value, public.similarity(normalized, ${normalized})::float AS similarity
        FROM entity_aliases WHERE owner_id=${ownerId} AND family=${family}
          AND public.similarity(normalized, ${normalized})>=${options.min ?? 0.3}
        ORDER BY similarity DESC LIMIT ${options.limit ?? 20}`,
    );
  }

  /**
   * Writes what one item said into its entities and marks it distilled, all
   * at once. Returns false when another worker distilled it first.
   */
  record(item: PendingItem, mentions: Mention[], fact: Fact, now = Date.now()) {
    return this.db.transaction(async () => {
      const claimed = await this.db.run(
        sql`UPDATE inbox_events SET distilled_at=${now} WHERE id=${item.id} AND distilled_at IS NULL`,
      );
      if (!claimed) return false;
      const ids: string[] = [];
      const roles: Partial<Record<'sender' | 'employer', string>> = {};
      for (const mention of mentions) {
        let entityId = 'entityId' in mention ? mention.entityId : undefined;
        if (!entityId && 'create' in mention) {
          // Matched by an earlier mention in this same item, or meanwhile.
          for (const alias of mention.aliases)
            entityId ??= await this.lookup(
              item.ownerId,
              alias.family,
              alias.normalized,
            );
          if (!entityId) {
            entityId = randomUUID();
            await this.db.run(
              sql`INSERT INTO entities (id, owner_id, kind, name, facts, mentions, first_seen_at, last_seen_at, created_at, updated_at)
                VALUES (${entityId}, ${item.ownerId}, ${mention.create.kind}, ${mention.create.name.slice(0, 200)}, '[]', 0, ${item.occurredAt}, ${item.occurredAt}, ${now}, ${now})`,
            );
          }
        }
        if (!entityId) continue;
        if (mention.role) roles[mention.role] ??= entityId;
        if (ids.includes(entityId)) continue;
        ids.push(entityId);
        for (const alias of mention.aliases)
          await this.db.run(
            sql`INSERT INTO entity_aliases VALUES (${item.ownerId}, ${alias.family}, ${alias.normalized}, ${alias.value.slice(0, 200)}, ${entityId}, ${now}) ON CONFLICT DO NOTHING`,
          );
        await this.db.run(
          sql`INSERT INTO event_entity_links VALUES (${item.id}, ${entityId}, ${item.ownerId}, ${mention.how}, ${now}) ON CONFLICT DO NOTHING`,
        );
        await this.appendFact(entityId, fact, now, true);
      }
      // People who send from a company's domain work there; everything an
      // item mentions together is related.
      if (roles.sender && roles.employer)
        await this.edge(
          item.ownerId,
          roles.sender,
          roles.employer,
          'works_at',
          now,
        );
      for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++) {
          const [a, b] = [ids[i], ids[j]].sort();
          await this.edge(item.ownerId, a, b, 'mentioned_with', now);
        }
      return true;
    });
  }
  /**
   * An item that only closes an earlier matter: its entities are the
   * earlier item's, which hear that it is closed.
   */
  recordClosing(item: PendingItem, fact: Fact, now = Date.now()) {
    return this.db.transaction(async () => {
      const claimed = await this.db.run(
        sql`UPDATE inbox_events SET distilled_at=${now} WHERE id=${item.id} AND distilled_at IS NULL`,
      );
      if (!claimed || !item.resolvesEventId) return claimed > 0;
      for (const { entityId } of await this.db.rows<{ entityId: string }>(
        sql`SELECT entity_id FROM event_entity_links WHERE event_id=${item.resolvesEventId}`,
      )) {
        await this.db.run(
          sql`INSERT INTO event_entity_links VALUES (${item.id}, ${entityId}, ${item.ownerId}, 'alias', ${now}) ON CONFLICT DO NOTHING`,
        );
        await this.appendFact(entityId, fact, now, false);
      }
      return true;
    });
  }
  private async appendFact(
    entityId: string,
    fact: Fact,
    now: number,
    mention: boolean,
  ) {
    const row = await this.db.row<{ facts: string }>(
      sql`SELECT facts FROM entities WHERE id=${entityId} FOR UPDATE`,
    );
    if (!row) return;
    const facts = addFact(JSON.parse(row.facts) as Fact[], fact);
    await this.db.run(
      sql`UPDATE entities SET facts=${JSON.stringify(facts)}, mentions=mentions + ${mention ? 1 : 0},
        first_seen_at=LEAST(first_seen_at, ${fact.at}), last_seen_at=GREATEST(last_seen_at, ${fact.at}), updated_at=${now}
        WHERE id=${entityId}`,
    );
  }
  private async edge(
    ownerId: string,
    entityId: string,
    otherId: string,
    relation: string,
    now: number,
  ) {
    if (entityId === otherId) return;
    await this.db.run(
      sql`INSERT INTO entity_edges VALUES (${ownerId}, ${entityId}, ${otherId}, ${relation}, 1, ${now}, ${now})
        ON CONFLICT (entity_id, other_entity_id, relation) DO UPDATE SET weight=entity_edges.weight + 1, updated_at=excluded.updated_at`,
    );
  }

  async entity(ownerId: string, id: string): Promise<EntityDetail | undefined> {
    const row = await this.db.row<EntityRow>(
      sql`SELECT ${ENTITY} FROM entities WHERE owner_id=${ownerId} AND id=${id}`,
    );
    if (!row) return undefined;
    const aliases = await this.db.rows<Alias>(
      sql`SELECT family, normalized, value FROM entity_aliases WHERE entity_id=${id} ORDER BY family, normalized`,
    );
    const related = await this.db.rows<EntityDetail['related'][number]>(
      sql`SELECT o.id, o.kind, o.name, r.relation, r.weight FROM (
          SELECT other_entity_id AS other, relation, weight FROM entity_edges WHERE entity_id=${id}
          UNION ALL SELECT entity_id, CASE relation WHEN 'works_at' THEN 'employs' ELSE relation END, weight FROM entity_edges WHERE other_entity_id=${id}
        ) r JOIN entities o ON o.id=r.other
        ORDER BY (r.relation<>'mentioned_with') DESC, r.weight DESC, o.last_seen_at DESC LIMIT 20`,
    );
    return { ...view(row), aliases, related };
  }
  /**
   * Entities whose name or any alias contains every word of `query`, or is
   * spelled like it; most recently seen first. No query lists recent ones.
   */
  async search(
    ownerId: string,
    options: { query?: string; kind?: EntityKind; limit?: number } = {},
  ): Promise<EntityView[]> {
    const where = [sql`e.owner_id=${ownerId}`];
    if (options.kind) where.push(sql`e.kind=${options.kind}`);
    const words = (options.query ?? '')
      .toLowerCase()
      .split(/\s+/)
      .map((word) => word.replace(/[%_\\]/g, '').trim())
      .filter((word) => word.length > 1)
      .slice(0, 6);
    const whole = words.join(' ');
    if (words.length)
      where.push(
        sql`(${sql.join(
          words.map(
            (word) =>
              sql`(e.name ILIKE ${`%${word}%`} OR EXISTS (SELECT 1 FROM entity_aliases a WHERE a.entity_id=e.id AND a.normalized ILIKE ${`%${word}%`}))`,
          ),
          ' AND ',
        )} OR EXISTS (SELECT 1 FROM entity_aliases a WHERE a.entity_id=e.id AND a.family IN ('person','name') AND public.similarity(a.normalized, ${whole})>=0.5))`,
      );
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    return (
      await this.db.rows<EntityRow>(
        sql`SELECT ${ENTITY} FROM entities e WHERE ${sql.join(where, ' AND ')} ORDER BY e.last_seen_at DESC, e.seq DESC LIMIT ${limit}`,
      )
    ).map(view);
  }

  /**
   * The owner says two entities are one thing: `fromId` folds into `intoId`,
   * with its names, items, facts and relations. Returns the merged entity.
   */
  merge(ownerId: string, fromId: string, intoId: string, now = Date.now()) {
    return this.db.transaction(async () => {
      if (fromId === intoId) return undefined;
      const rows = await this.db.rows<{
        id: string;
        facts: string;
        mentions: number;
      }>(
        sql`SELECT id, facts, mentions FROM entities WHERE owner_id=${ownerId} AND id IN (${fromId}, ${intoId}) FOR UPDATE`,
      );
      const from = rows.find((row) => row.id === fromId);
      const into = rows.find((row) => row.id === intoId);
      if (!from || !into) return undefined;
      let facts = JSON.parse(into.facts) as Fact[];
      for (const fact of JSON.parse(from.facts) as Fact[])
        facts = addFact(facts, fact);
      await this.db.run(
        sql`UPDATE entity_aliases SET entity_id=${intoId} WHERE entity_id=${fromId}`,
      );
      await this.db.run(
        sql`INSERT INTO event_entity_links SELECT event_id, ${intoId}, owner_id, 'owner', ${now} FROM event_entity_links WHERE entity_id=${fromId} ON CONFLICT DO NOTHING`,
      );
      // Relations move over; a pair that now exists twice adds its weights,
      // and a relation between the two becomes none.
      const edges = await this.db.rows<{
        entityId: string;
        otherEntityId: string;
        relation: string;
        weight: number;
      }>(
        sql`SELECT entity_id, other_entity_id, relation, weight FROM entity_edges WHERE entity_id=${fromId} OR other_entity_id=${fromId}`,
      );
      for (const edge of edges) {
        const swap = (id: string) => (id === fromId ? intoId : id);
        let [a, b] = [swap(edge.entityId), swap(edge.otherEntityId)];
        if (a === b) continue;
        if (edge.relation === 'mentioned_with') [a, b] = [a, b].sort();
        await this.db.run(
          sql`INSERT INTO entity_edges VALUES (${ownerId}, ${a}, ${b}, ${edge.relation}, ${edge.weight}, ${now}, ${now})
            ON CONFLICT (entity_id, other_entity_id, relation) DO UPDATE SET weight=entity_edges.weight + excluded.weight, updated_at=excluded.updated_at`,
        );
      }
      await this.db.run(
        sql`UPDATE entities SET facts=${JSON.stringify(facts)}, mentions=${Number(into.mentions) + Number(from.mentions)},
          first_seen_at=LEAST(first_seen_at, (SELECT first_seen_at FROM entities WHERE id=${fromId})),
          last_seen_at=GREATEST(last_seen_at, (SELECT last_seen_at FROM entities WHERE id=${fromId})), updated_at=${now}
          WHERE id=${intoId}`,
      );
      await this.db.run(sql`DELETE FROM entities WHERE id=${fromId}`);
      return this.entity(ownerId, intoId);
    });
  }

  /** Called before a source's items are removed: forgets what they taught. */
  async forgetSource(sourceId: string) {
    await this.db.run(
      sql`DELETE FROM event_entity_links WHERE event_id IN (SELECT id FROM inbox_events WHERE source_id=${sourceId})`,
    );
    await this.db.run(
      sql`UPDATE entities SET facts=COALESCE((SELECT jsonb_agg(f.value ORDER BY f.ordinality) FROM jsonb_array_elements(facts::jsonb) WITH ORDINALITY f
          WHERE f.value->>'sourceId' IS DISTINCT FROM ${sourceId}), '[]'::jsonb)::text
        WHERE facts::jsonb @> ${JSON.stringify([{ sourceId }])}::jsonb`,
    );
    await this.db.run(sql`DELETE FROM entities WHERE facts='[]'`);
  }

  /** Whether a plain name also appears in another item: lone ones are noise. */
  async recurs(eventId: string, normalized: string) {
    return !!(await this.db.row(
      sql`SELECT 1 FROM event_tags WHERE event_id<>${eventId} AND normalized=${normalized} AND kind IN ('project','place','name') LIMIT 1`,
    ));
  }

  async entityCount(ownerId: string) {
    return Number(
      (
        await this.db.row<{ n: number }>(
          sql`SELECT count(*) AS n FROM entities WHERE owner_id=${ownerId}`,
        )
      )?.n ?? 0,
    );
  }
  /** The day's line; written once per owner and local date. */
  async saveRun(
    ownerId: string,
    day: string,
    run: { distilled: number; pruned: number; entities: number },
    report: string,
    now = Date.now(),
  ) {
    return (
      (await this.db.run(
        sql`INSERT INTO memory_runs VALUES (${ownerId}, ${day}, ${run.distilled}, ${run.pruned}, ${run.entities}, ${report}, ${now}) ON CONFLICT DO NOTHING`,
      )) > 0
    );
  }
  runs(ownerId: string, limit = 14) {
    return this.db.rows<{
      day: string;
      distilled: number;
      pruned: number;
      entities: number;
      report: string;
      createdAt: number;
    }>(
      sql`SELECT day, distilled, pruned, entities, report, created_at FROM memory_runs WHERE owner_id=${ownerId} ORDER BY day DESC LIMIT ${limit}`,
    );
  }
  /** The line written for one local day, if the daily run has happened. */
  async report(ownerId: string, day: string) {
    return (
      await this.db.row<{ report: string }>(
        sql`SELECT report FROM memory_runs WHERE owner_id=${ownerId} AND day=${day}`,
      )
    )?.report;
  }
  /** Items distilled since `since`, for the day's line. */
  async distilledSince(since: number) {
    return Number(
      (
        await this.db.row<{ n: number }>(
          sql`SELECT count(*) AS n FROM inbox_events WHERE distilled_at>=${since}`,
        )
      )?.n ?? 0,
    );
  }
}
