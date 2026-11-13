import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type {
  Asked,
  AccountSourceConfig,
  Delivery,
  FindingState,
  FindingView,
  InboxEventState,
  InboxEventView,
  InboxNotify,
  InboxSourceView,
  LinksState,
  McpSourceConfig,
  Route,
  SourceConfig,
  SourceKind,
  SourceType,
  TagKind,
  Urgency,
} from '../../shared/inbox-types.js';
import type { InboxEvent } from './source.js';
import { DiscoveryStore } from '../discovery/store.js';
import { MemoryStore, type Fact } from '../memory/store.js';

// Kinds that link on the name alone, and kinds whose spellings are compared.
const NAME_KINDS = new Set<TagKind>(['project', 'place', 'name']);
const ALIKE_KINDS = new Set<TagKind>([
  'invoice',
  'order',
  'person',
  'project',
  'place',
  'name',
]);

const MAX_EVENTS_PER_SOURCE = 2000;
const MAX_TEXT = 2000;
export interface SourceRecord {
  id: string;
  name: string;
  kind: SourceKind;
  type: SourceType;
  config: SourceConfig;
  enabled: boolean;
  notify: InboxNotify;
  intervalSeconds: number;
  cursor: string | null;
  lastPolledAt: number | null;
  nextPollAt: number | null;
  lastError: string | null;
  createdAt: number;
}
export interface SourceClaim {
  source: SourceRecord;
  lease: string;
}
type SourceRow = Omit<SourceRecord, 'config'> & {
  config: string;
  secretHash: string | null;
  lease: string | null;
  leaseUntil: number | null;
};
const hash = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');
const clip = (value: string, max = MAX_TEXT) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);
/** Sources the poller runs on a timer. */
const POLLED = sql.raw("type IN ('mcp', 'account')");
const FINDING = sql.raw(
  'id, event_id, attention, category, confidence, reason, judged_by, state, dot_id, thread_id, referenced_event_id, error, urgency, asked, injection, route, delivery, note, created_at, updated_at',
);
type EventRow = Omit<InboxEventView, 'finding'> & {
  findingId: string | null;
};
/**
 * Items that may be removed: their facts are in their entities, and nothing
 * still waits on the owner (an open finding, choice or queued push).
 */
const PRUNABLE = sql.raw(`e.distilled_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM discovery_findings f WHERE f.event_id=e.id AND f.state IN ('flagged','investigating'))
  AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.event_id=e.id AND p.state IN ('open','preparing','prepared','handling','snoozed','failed'))
  AND NOT EXISTS (SELECT 1 FROM discovery_pushes d JOIN discovery_findings f ON f.id=d.finding_id WHERE f.event_id=e.id AND d.state IN ('queued','brief'))`);
const EVENT_QUERY = sql`SELECT e.id, e.source_id, COALESCE(s.name, 'Removed source') AS source_name, e.external_id, e.kind, e.title, e.summary, e.priority, e.sender AS "from", e.url, e.occurred_at, e.received_at, e.state, f.id AS finding_id FROM inbox_events e LEFT JOIN inbox_sources s ON s.id=e.source_id LEFT JOIN discovery_findings f ON f.event_id=e.id`;

export class InboxStore {
  /** Links, embeddings, delivery and settings for discovery with history. */
  readonly discovery: DiscoveryStore;
  /** Entities: what items said, kept after the items are pruned. */
  readonly memory: MemoryStore;
  constructor(private db: Db) {
    this.discovery = new DiscoveryStore(db);
    this.memory = new MemoryStore(db);
  }
  private row(id: string) {
    return this.db.row<SourceRow>(
      sql`SELECT * FROM inbox_sources WHERE id=${id}`,
    );
  }
  private record(row: SourceRow): SourceRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      type: row.type,
      config: JSON.parse(row.config),
      enabled: row.enabled,
      notify: row.notify,
      intervalSeconds: row.intervalSeconds,
      cursor: row.cursor,
      lastPolledAt: row.lastPolledAt,
      nextPollAt: row.nextPollAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    };
  }
  async source(id: string) {
    const row = await this.row(id);
    return row ? this.record(row) : undefined;
  }
  async sources(): Promise<InboxSourceView[]> {
    const rows = await this.db.rows<
      SourceRow & { eventCount: number; newCount: number }
    >(
      sql`SELECT s.*, (SELECT COUNT(*) FROM inbox_events e WHERE e.source_id=s.id) AS event_count,
          (SELECT COUNT(*) FROM inbox_events e WHERE e.source_id=s.id AND e.state='new') AS new_count
        FROM inbox_sources s ORDER BY s.created_at, s.seq`,
    );
    return rows.map((row) => {
      const record = this.record(row);
      return {
        id: record.id,
        name: record.name,
        kind: record.kind,
        type: record.type,
        enabled: record.enabled,
        notify: record.notify,
        intervalSeconds: record.intervalSeconds,
        config: record.config,
        hasSecret: !!row.secretHash,
        lastPolledAt: record.lastPolledAt,
        nextPollAt: record.type === 'webhook' ? null : record.nextPollAt,
        lastError: record.lastError,
        eventCount: Number(row.eventCount),
        newCount: Number(row.newCount),
        createdAt: record.createdAt,
      };
    });
  }
  /** Webhook sources get a secret, returned once and stored only as a hash. */
  async create(value: {
    name: string;
    kind: SourceKind;
    type: SourceType;
    config: SourceConfig;
    notify: InboxNotify;
    intervalSeconds: number;
  }) {
    const id = randomUUID();
    const now = Date.now();
    const secret =
      value.type === 'webhook'
        ? randomBytes(32).toString('base64url')
        : undefined;
    await this.db.run(
      sql`INSERT INTO inbox_sources (id, name, kind, type, config, enabled, notify, interval_seconds, secret_hash, next_poll_at, created_at, updated_at) VALUES (${id}, ${value.name}, ${value.kind}, ${value.type}, ${JSON.stringify(value.config)}, true, ${value.notify}, ${value.intervalSeconds}, ${secret ? hash(secret) : null}, ${value.type === 'webhook' ? null : now}, ${now}, ${now})`,
    );
    return { source: (await this.source(id))!, secret };
  }
  update(
    id: string,
    patch: Partial<
      Pick<SourceRecord, 'name' | 'enabled' | 'notify' | 'intervalSeconds'>
    > & { config?: McpSourceConfig | AccountSourceConfig },
  ) {
    return this.db.transaction(async () => {
      const current = await this.source(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      const clearError = !!(patch.config || patch.enabled);
      await this.db.run(
        sql`UPDATE inbox_sources SET name=${next.name}, enabled=${next.enabled}, notify=${next.notify}, interval_seconds=${next.intervalSeconds}, config=${JSON.stringify(next.config)}, last_error=CASE WHEN ${clearError}::boolean THEN NULL ELSE last_error END, updated_at=${Date.now()} WHERE id=${id}`,
      );
      return this.source(id);
    });
  }
  remove(id: string) {
    return this.db.transaction(async () => {
      await this.discovery.forgetSource(id);
      await this.memory.forgetSource(id);
      await this.db.run(
        sql`DELETE FROM discovery_findings WHERE event_id IN (SELECT id FROM inbox_events WHERE source_id=${id})`,
      );
      await this.db.run(sql`DELETE FROM inbox_events WHERE source_id=${id}`);
      return (
        (await this.db.run(sql`DELETE FROM inbox_sources WHERE id=${id}`)) > 0
      );
    });
  }
  async rotateSecret(id: string) {
    const row = await this.row(id);
    if (!row || row.type !== 'webhook') return undefined;
    const secret = randomBytes(32).toString('base64url');
    await this.db.run(
      sql`UPDATE inbox_sources SET secret_hash=${hash(secret)}, updated_at=${Date.now()} WHERE id=${id}`,
    );
    return secret;
  }
  /** Constant-time check of a webhook secret. */
  async verifySecret(id: string, secret: string) {
    const row = await this.row(id);
    if (!row?.secretHash || !row.enabled || !secret) return false;
    const expected = Buffer.from(row.secretHash, 'hex');
    const supplied = Buffer.from(hash(secret), 'hex');
    return timingSafeEqual(expected, supplied);
  }
  async pollNow(id: string) {
    return (
      (await this.db.run(
        sql`UPDATE inbox_sources SET next_poll_at=${Date.now()} WHERE id=${id} AND ${POLLED}`,
      )) > 0
    );
  }
  /**
   * Claims one due polling source under a lease, like scheduled tasks, so two
   * workers never poll the same source at once.
   */
  claimDue(
    now = Date.now(),
    leaseMs = 120_000,
  ): Promise<SourceClaim | undefined> {
    return this.db.transaction(async () => {
      const row = await this.db.row<SourceRow>(
        sql`SELECT * FROM inbox_sources WHERE ${POLLED} AND enabled AND COALESCE(next_poll_at, 0)<=${now} AND (lease IS NULL OR lease_until<=${now}) ORDER BY COALESCE(next_poll_at, 0), seq LIMIT 1`,
      );
      if (!row) return undefined;
      const lease = randomUUID();
      await this.db.run(
        sql`UPDATE inbox_sources SET lease=${lease}, lease_until=${now + leaseMs} WHERE id=${row.id}`,
      );
      return { source: this.record(row), lease };
    });
  }
  async owns(claim: SourceClaim) {
    return (await this.row(claim.source.id))?.lease === claim.lease;
  }
  /** Releases the lease and schedules the next poll. Ignored if the lease moved on. */
  async finishPoll(
    claim: SourceClaim,
    outcome: { cursor?: string; error?: string },
    now = Date.now(),
  ) {
    return (
      (await this.db.run(
        sql`UPDATE inbox_sources SET lease=NULL, lease_until=NULL, last_polled_at=${now}, next_poll_at=${now}::bigint + interval_seconds::bigint * 1000, cursor=COALESCE(${outcome.cursor ?? null}::text, cursor), last_error=${outcome.error ?? null} WHERE id=${claim.source.id} AND lease=${claim.lease}`,
      )) > 0
    );
  }
  /** Writes events, skipping ones already seen. Returns only the new ones. */
  async ingest(
    events: InboxEvent[],
    now = Date.now(),
  ): Promise<InboxEventView[]> {
    const inserted: string[] = [];
    await this.db.transaction(async () => {
      for (const event of events) {
        const id = randomUUID();
        let payload: string;
        try {
          payload = JSON.stringify(event.raw ?? null) ?? 'null';
        } catch {
          payload = 'null';
        }
        const url =
          event.url && isWebUrl(event.url) ? clip(event.url, 2048) : null;
        const changes = await this.db.run(
          sql`INSERT INTO inbox_events (id, source_id, external_id, kind, title, summary, priority, sender, url, payload, occurred_at, received_at) VALUES (${id}, ${event.sourceId}, ${clip(event.externalId, 300)}, ${clip(event.kind, 80)}, ${clip(event.title || '(untitled)', 300)}, ${clip(event.summary ?? '')}, ${event.priority ?? 'normal'}, ${event.from ? clip(event.from, 200) : null}, ${url}, ${clip(payload, 50_000)}, ${event.occurredAt}, ${now}) ON CONFLICT (source_id, external_id) DO NOTHING`,
        );
        if (changes) inserted.push(id);
      }
      // A cap behind the daily prune, for a source that floods; it too only
      // removes what memory has kept.
      for (const sourceId of new Set(events.map((event) => event.sourceId)))
        await this.drop(
          sql`e.source_id=${sourceId} AND e.id NOT IN (SELECT id FROM inbox_events WHERE source_id=${sourceId} ORDER BY received_at DESC, seq DESC LIMIT ${MAX_EVENTS_PER_SOURCE})`,
        );
    });
    const views: InboxEventView[] = [];
    for (const id of inserted) {
      const event = await this.event(id);
      if (event) views.push(event);
    }
    return views;
  }
  /**
   * Removes items received before `before` whose facts are in their
   * entities, with their links and findings. Items still
   * waiting on the owner stay. Returns how many went.
   */
  prune(before: number) {
    return this.db.transaction(() => this.drop(sql`e.received_at<${before}`));
  }
  private async drop(where: ReturnType<typeof sql>) {
    const ids = (
      await this.db.rows<{ id: string }>(
        sql`SELECT e.id FROM inbox_events e WHERE ${where} AND ${PRUNABLE}`,
      )
    ).map((row) => row.id);
    if (!ids.length) return 0;
    const findings = sql`SELECT id FROM discovery_findings WHERE event_id = ANY(${ids})`;
    await this.db.run(
      sql`DELETE FROM event_links WHERE event_id = ANY(${ids}) OR other_event_id = ANY(${ids})`,
    );
    await this.db.run(
      sql`DELETE FROM event_entity_links WHERE event_id = ANY(${ids})`,
    );
    await this.db.run(
      sql`DELETE FROM discovery_pushes WHERE finding_id IN (${findings})`,
    );
    await this.db.run(
      sql`DELETE FROM discovery_findings WHERE event_id = ANY(${ids})`,
    );
    await this.db.run(sql`DELETE FROM inbox_events WHERE id = ANY(${ids})`);
    return ids.length;
  }
  /**
   * The owner's entities seen in the last `days` and the items that mention
   * them, for the links view. Items still stored are read live; pruned ones
   * from the facts their entities keep. Plain names are noisy one at a
   * time, so only names found in two or more items are kept.
   */
  async links(
    ownerId: string,
    days = 90,
    now = Date.now(),
  ): Promise<LinksState> {
    const since = now - days * 86_400_000;
    const rows = await this.db.rows<{
      id: string;
      kind: string;
      name: string;
      key: string | null;
      facts: string;
    }>(
      sql`SELECT e.id, e.kind, e.name, e.facts,
          (SELECT min(a.normalized) FROM entity_aliases a WHERE a.entity_id=e.id AND a.family=(CASE e.kind WHEN 'company' THEN 'domain' WHEN 'project' THEN 'name' WHEN 'place' THEN 'name' ELSE e.kind END)) AS key
        FROM entities e WHERE e.owner_id=${ownerId} AND e.last_seen_at>=${since}
        ORDER BY e.last_seen_at DESC LIMIT 400`,
    );
    const facts = new Map<string, Fact>();
    const tags: LinksState['tags'] = [];
    for (const row of rows) {
      const ids = new Set<string>();
      for (const fact of JSON.parse(row.facts) as Fact[])
        if (fact.at >= since) {
          ids.add(fact.eventId);
          if (!facts.has(fact.eventId)) facts.set(fact.eventId, fact);
        }
      const kind = (row.kind === 'company' ? 'domain' : row.kind) as TagKind;
      if (!ids.size || (NAME_KINDS.has(kind) && ids.size < 2)) continue;
      tags.push({
        kind,
        normalized: row.key ?? row.name.toLowerCase(),
        value: row.name,
        itemIds: [...ids],
      });
    }
    const recent = [...facts.values()]
      .sort((a, b) => b.at - a.at)
      .slice(0, 400);
    if (!recent.length) return { items: [], tags: [], similar: [] };
    const live = new Map(
      (
        await this.db.rows<LinksState['items'][number]>(
          sql`SELECT e.id, e.source_id, COALESCE(s.name, 'Removed source') AS source_name, s.kind AS source_kind, e.title, e.sender AS "from", e.occurred_at, COALESCE(f.attention, false) AS flagged
            FROM inbox_events e LEFT JOIN inbox_sources s ON s.id=e.source_id LEFT JOIN discovery_findings f ON f.event_id=e.id
            WHERE e.id = ANY(${recent.map((fact) => fact.eventId)})`,
        )
      ).map((item) => [item.id, item]),
    );
    const kinds = new Map(
      (
        await this.db.rows<{ id: string; kind: SourceKind }>(
          sql`SELECT id, kind FROM inbox_sources`,
        )
      ).map((source) => [source.id, source.kind]),
    );
    const items = recent.map(
      (fact) =>
        live.get(fact.eventId) ?? {
          id: fact.eventId,
          sourceId: fact.sourceId,
          sourceName: fact.app,
          sourceKind: kinds.get(fact.sourceId) ?? null,
          title: fact.title,
          from: fact.from,
          occurredAt: fact.at,
          flagged: false,
        },
    );
    const shown = new Set(items.map((item) => item.id));
    const kept = tags
      .map((tag) => ({
        ...tag,
        itemIds: tag.itemIds.filter((id) => shown.has(id)),
      }))
      .filter((tag) => tag.itemIds.length)
      .sort(
        (a, b) =>
          b.itemIds.length - a.itemIds.length ||
          a.kind.localeCompare(b.kind) ||
          a.normalized.localeCompare(b.normalized),
      );
    const similar = await this.alike(kept);
    return { items, tags: kept, similar };
  }
  /** Pairs of shown entities of one kind spelled alike. */
  private async alike(tags: LinksState['tags']) {
    const keys = tags.filter((tag) => ALIKE_KINDS.has(tag.kind));
    if (keys.length < 2) return [];
    return this.db.rows<LinksState['similar'][number]>(
      sql`WITH keys AS (SELECT * FROM unnest(${keys.map((tag) => tag.kind)}::text[], ${keys.map((tag) => tag.normalized)}::text[]) AS k(kind, normalized))
        SELECT a.kind, a.normalized AS a, b.normalized AS b, round(public.similarity(a.normalized, b.normalized)::numeric, 2) AS similarity
        FROM keys a JOIN keys b ON a.kind=b.kind AND a.normalized<b.normalized
        WHERE public.similarity(a.normalized, b.normalized)>=0.4
        ORDER BY similarity DESC LIMIT 100`,
    );
  }
  private async toEvent({
    findingId,
    ...row
  }: EventRow): Promise<InboxEventView> {
    return {
      ...row,
      finding: findingId ? ((await this.finding(findingId)) ?? null) : null,
    };
  }
  private async toEvents(rows: EventRow[]) {
    const views: InboxEventView[] = [];
    for (const row of rows) views.push(await this.toEvent(row));
    return views;
  }
  async event(id: string) {
    const row = await this.db.row<EventRow>(
      sql`${EVENT_QUERY} WHERE e.id=${id}`,
    );
    return row ? this.toEvent(row) : undefined;
  }
  /** The stored raw payload, as untrusted data. */
  async payload(id: string): Promise<unknown> {
    const row = await this.db.row<{ payload: string }>(
      sql`SELECT payload FROM inbox_events WHERE id=${id}`,
    );
    return row ? JSON.parse(row.payload) : undefined;
  }
  async events(
    filter: {
      sourceId?: string;
      state?: InboxEventState;
      includeDismissed?: boolean;
      limit?: number;
    } = {},
  ): Promise<InboxEventView[]> {
    const where = [];
    if (filter.sourceId) where.push(sql`e.source_id=${filter.sourceId}`);
    if (filter.state) where.push(sql`e.state=${filter.state}`);
    else if (!filter.includeDismissed) where.push(sql`e.state<>'dismissed'`);
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    return this.toEvents(
      await this.db.rows<EventRow>(
        sql`${EVENT_QUERY} ${where.length ? sql`WHERE ${sql.join(where, ' AND ')}` : sql``} ORDER BY CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, e.received_at DESC LIMIT ${limit}`,
      ),
    );
  }
  /**
   * Items matching every word of `query` in their title, text or sender,
   * newest first; for a Dot looking up something the owner mentions.
   */
  async search(
    filter: {
      query?: string;
      since?: number;
      flaggedOnly?: boolean;
      /**
       * Only items still waiting on the owner: flagged, not resolved or
       * dismissed, and with no choice made that settled them.
       */
      waitingOnly?: boolean;
      limit?: number;
    } = {},
  ): Promise<InboxEventView[]> {
    const where = [];
    for (const word of (filter.query ?? '')
      .split(/\s+/)
      .map((part) => part.replace(/[%_\\]/g, '').trim())
      .filter((part) => part.length > 1)
      .slice(0, 8)) {
      const like = `%${word}%`;
      where.push(
        sql`(e.title ILIKE ${like} OR e.summary ILIKE ${like} OR e.sender ILIKE ${like})`,
      );
    }
    if (filter.since) where.push(sql`e.occurred_at>=${filter.since}`);
    if (filter.flaggedOnly || filter.waitingOnly) where.push(sql`f.attention`);
    if (filter.waitingOnly)
      where.push(
        sql`f.state<>'resolved' AND e.state<>'dismissed' AND NOT EXISTS (SELECT 1 FROM proposals p WHERE p.finding_id=f.id AND p.state IN ('handled', 'dismissed', 'closed', 'preparing', 'handling'))`,
      );
    const limit = Math.min(Math.max(filter.limit ?? 20, 1), 50);
    return this.toEvents(
      await this.db.rows<EventRow>(
        sql`${EVENT_QUERY} ${where.length ? sql`WHERE ${sql.join(where, ' AND ')}` : sql``} ORDER BY e.occurred_at DESC LIMIT ${limit}`,
      ),
    );
  }
  async setState(id: string, state: InboxEventState) {
    const changed = await this.db.run(
      sql`UPDATE inbox_events SET state=${state} WHERE id=${id}`,
    );
    return changed > 0 ? this.event(id) : undefined;
  }
  /** The discovery source for a connected account, if there is one. */
  async accountSource(accountId: string) {
    const row = await this.db.row<SourceRow>(
      sql`SELECT * FROM inbox_sources WHERE type='account' AND config::jsonb->>'accountId'=${accountId} ORDER BY created_at LIMIT 1`,
    );
    return row ? this.record(row) : undefined;
  }
  async accountSources() {
    return (
      await this.db.rows<SourceRow>(
        sql`SELECT * FROM inbox_sources WHERE type='account' ORDER BY created_at`,
      )
    ).map((row) => this.record(row));
  }
  finding(id: string) {
    return this.db.row<FindingView>(
      sql`SELECT ${FINDING} FROM discovery_findings WHERE id=${id}`,
    );
  }
  findingForEvent(eventId: string) {
    return this.db.row<FindingView>(
      sql`SELECT ${FINDING} FROM discovery_findings WHERE event_id=${eventId}`,
    );
  }
  findings(state: FindingState) {
    return this.db.rows<FindingView>(
      sql`SELECT ${FINDING} FROM discovery_findings WHERE state=${state} ORDER BY created_at, seq`,
    );
  }
  /** Records the discovery model's verdict on an event, once per event. */
  async saveFinding(value: {
    eventId: string;
    attention: boolean;
    category: string;
    confidence: number;
    reason: string;
    judgedBy: string;
    dotId: string | null;
    referencedEventId?: string | null;
    urgency?: Urgency | null;
    asked?: Asked | null;
    injection?: boolean;
    route?: Route | null;
    /** Jev's raw answers, kept so thresholds can be retuned later. */
    answers?: unknown;
  }) {
    const now = Date.now();
    await this.db.run(
      sql`INSERT INTO discovery_findings (id, event_id, attention, category, confidence, reason, judged_by, state, dot_id, referenced_event_id, urgency, asked, injection, route, answers, created_at, updated_at) VALUES (${randomUUID()}, ${value.eventId}, ${value.attention}, ${clip(value.category, 40)}, ${Math.min(Math.max(value.confidence, 0), 1)}, ${clip(value.reason, 500)}, ${clip(value.judgedBy, 120)}, ${value.attention ? 'flagged' : 'ignored'}, ${value.dotId}, ${value.referencedEventId ?? null}, ${value.urgency ?? null}, ${value.asked ?? null}, ${value.injection ?? false}, ${value.route ?? null}, ${value.answers === undefined ? null : JSON.stringify(value.answers)}, ${now}, ${now}) ON CONFLICT (event_id) DO NOTHING`,
    );
    return (await this.findingForEvent(value.eventId))!;
  }
  async updateFinding(
    id: string,
    patch: {
      state?: FindingState;
      threadId?: string;
      error?: string | null;
      attention?: boolean;
      urgency?: Urgency;
      route?: Route;
      delivery?: Delivery;
      note?: string;
      /** The later item that said this one no longer needs the owner. */
      resolvedBy?: string;
    },
  ) {
    const sets = [sql`updated_at=${Date.now()}`];
    if (patch.state) {
      sets.push(sql`state=${patch.state}`);
      // A new state clears the previous error unless one is given.
      sets.push(sql`error=${patch.error ? clip(patch.error, 500) : null}`);
    } else if (patch.error !== undefined)
      sets.push(sql`error=${patch.error ? clip(patch.error, 500) : null}`);
    if (patch.threadId) sets.push(sql`thread_id=${patch.threadId}`);
    if (patch.attention !== undefined)
      sets.push(sql`attention=${patch.attention}`);
    if (patch.urgency) sets.push(sql`urgency=${patch.urgency}`);
    if (patch.route) sets.push(sql`route=${patch.route}`);
    if (patch.delivery) sets.push(sql`delivery=${patch.delivery}`);
    if (patch.note) sets.push(sql`note=${clip(patch.note, 500)}`);
    if (patch.resolvedBy) sets.push(sql`resolved_by=${patch.resolvedBy}`);
    await this.db.run(
      sql`UPDATE discovery_findings SET ${sql.join(sets, ', ')} WHERE id=${id}`,
    );
    return this.finding(id);
  }
  /** Jev's stored answers for a finding, as saved. */
  async findingAnswers(id: string): Promise<unknown> {
    const row = await this.db.row<{ answers: string | null }>(
      sql`SELECT answers FROM discovery_findings WHERE id=${id}`,
    );
    return row?.answers ? (JSON.parse(row.answers) as unknown) : null;
  }
}
