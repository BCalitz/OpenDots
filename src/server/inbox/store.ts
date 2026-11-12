import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type {
  ComposioSourceConfig,
  FindingState,
  FindingView,
  InboxEventState,
  InboxEventView,
  InboxNotify,
  InboxSourceView,
  LinksState,
  McpSourceConfig,
  SourceConfig,
  SourceKind,
  SourceType,
} from '../../shared/inbox-types.js';
import type { InboxEvent } from './source.js';
import { extractTags } from './tags.js';

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
const POLLED = sql.raw("type IN ('mcp', 'composio')");
const FINDING = sql.raw(
  'id, event_id, attention, category, confidence, reason, judged_by, state, dot_id, thread_id, referenced_event_id, error, created_at, updated_at',
);
type EventRow = Omit<InboxEventView, 'finding'> & {
  findingId: string | null;
};
const EVENT_QUERY = sql`SELECT e.id, e.source_id, COALESCE(s.name, 'Removed source') AS source_name, e.external_id, e.kind, e.title, e.summary, e.priority, e.sender AS "from", e.url, e.occurred_at, e.received_at, e.state, f.id AS finding_id FROM inbox_events e LEFT JOIN inbox_sources s ON s.id=e.source_id LEFT JOIN discovery_findings f ON f.event_id=e.id`;

export class InboxStore {
  constructor(private db: Db) {}
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
    > & { config?: McpSourceConfig | ComposioSourceConfig },
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
      await this.db.run(
        sql`DELETE FROM discovery_findings WHERE event_id IN (SELECT id FROM inbox_events WHERE source_id=${id})`,
      );
      await this.db.run(sql`DELETE FROM inbox_events WHERE source_id=${id}`);
      // Removing a source removes what was learned from it.
      await this.db.run(sql`DELETE FROM event_tags WHERE source_id=${id}`);
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
        if (changes) {
          inserted.push(id);
          await this.tag({
            id,
            sourceId: event.sourceId,
            title: event.title,
            summary: event.summary,
            from: event.from,
            occurredAt: event.occurredAt,
          });
        }
      }
      for (const sourceId of new Set(events.map((event) => event.sourceId)))
        await this.db.run(
          sql`DELETE FROM inbox_events WHERE source_id=${sourceId} AND id NOT IN (SELECT id FROM inbox_events WHERE source_id=${sourceId} ORDER BY received_at DESC, seq DESC LIMIT ${MAX_EVENTS_PER_SOURCE})`,
        );
      await this.db.run(
        sql`DELETE FROM discovery_findings f WHERE NOT EXISTS (SELECT 1 FROM inbox_events e WHERE e.id=f.event_id)`,
      );
    });
    const views: InboxEventView[] = [];
    for (const id of inserted) {
      const event = await this.event(id);
      if (event) views.push(event);
    }
    return views;
  }
  /** Records an item's tags. They outlive the item itself. */
  private async tag(item: {
    id: string;
    sourceId: string;
    title: string;
    summary?: string;
    from?: string | null;
    occurredAt: number;
  }) {
    for (const tag of extractTags(item))
      await this.db.run(
        sql`INSERT INTO event_tags VALUES (${item.id}, ${item.sourceId}, ${tag.kind}, ${tag.normalized}, ${tag.value}, ${item.occurredAt}) ON CONFLICT DO NOTHING`,
      );
  }
  /** Tags stored items that have none, such as ones from before tags. */
  async backfillTags() {
    const rows = await this.db.rows<{
      id: string;
      sourceId: string;
      title: string;
      summary: string;
      from: string | null;
      occurredAt: number;
    }>(
      sql`SELECT e.id, e.source_id, e.title, e.summary, e.sender AS "from", e.occurred_at FROM inbox_events e WHERE NOT EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id=e.id)`,
    );
    for (const row of rows) await this.tag(row);
    return rows.length;
  }
  /**
   * Items from the last `days` and the tags they carry, plus tags of one
   * kind spelled alike (trigram similarity), for the links view.
   */
  async links(days = 90, now = Date.now()): Promise<LinksState> {
    const since = now - days * 86_400_000;
    const items = await this.db.rows<LinksState['items'][number]>(
      sql`SELECT ids.event_id AS id, ids.source_id, COALESCE(s.name, 'Removed source') AS source_name, s.kind AS source_kind, e.title, e.sender AS "from", ids.occurred_at, COALESCE(f.attention, false) AS flagged
        FROM (SELECT DISTINCT ON (event_id) event_id, source_id, occurred_at FROM event_tags WHERE occurred_at>=${since} ORDER BY event_id) ids
        LEFT JOIN inbox_events e ON e.id=ids.event_id
        LEFT JOIN inbox_sources s ON s.id=ids.source_id
        LEFT JOIN discovery_findings f ON f.event_id=ids.event_id
        ORDER BY ids.occurred_at DESC LIMIT 400`,
    );
    const ids = items.map((item) => item.id);
    if (!ids.length) return { items: [], tags: [], similar: [] };
    // Projects, places and plain names link on the name alone and take the
    // most specific kind any item gave it. They are noisy one at a time, so
    // only names found in two or more items are kept.
    const merged = sql`SELECT CASE WHEN family='name' THEN (array_agg(kind ORDER BY array_position(ARRAY['project','place','name']::text[], kind)))[1] ELSE family END AS kind,
        normalized, (array_agg(value ORDER BY occurred_at))[1] AS value, array_agg(DISTINCT event_id) AS item_ids, count(DISTINCT event_id) AS n
      FROM (SELECT event_id, kind, normalized, value, occurred_at, CASE WHEN kind IN ('project','place','name') THEN 'name' ELSE kind END AS family
        FROM event_tags WHERE event_id = ANY(${ids})) t
      GROUP BY family, normalized HAVING family<>'name' OR count(DISTINCT event_id)>=2`;
    const tags = await this.db.rows<LinksState['tags'][number]>(
      sql`SELECT kind, normalized, value, item_ids FROM (${merged}) m ORDER BY n DESC, kind, normalized`,
    );
    const similar = await this.db.rows<LinksState['similar'][number]>(
      sql`WITH keys AS (${merged})
        SELECT a.kind, a.normalized AS a, b.normalized AS b, round(public.similarity(a.normalized, b.normalized)::numeric, 2) AS similarity
        FROM keys a JOIN keys b ON a.kind=b.kind AND a.normalized<b.normalized
        WHERE a.kind IN ('invoice', 'order', 'person', 'project', 'place', 'name') AND public.similarity(a.normalized, b.normalized)>=0.4
        ORDER BY similarity DESC LIMIT 100`,
    );
    return { items, tags, similar };
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
  /**
   * Recent events from the same sender, looking backward from `beforeMs`
   * within `windowMs` — candidates for discovery's cross-item correlation.
   * No per-source-pair logic: any source that labels an event's `sender`
   * participates.
   */
  async recentFrom(
    from: string,
    beforeMs: number,
    windowMs: number,
    excludeId: string,
    limit = 10,
  ): Promise<InboxEventView[]> {
    return this.toEvents(
      await this.db.rows<EventRow>(
        sql`${EVENT_QUERY} WHERE e.sender=${from} AND e.id<>${excludeId} AND e.occurred_at BETWEEN ${beforeMs - windowMs} AND ${beforeMs} ORDER BY e.occurred_at DESC LIMIT ${limit}`,
      ),
    );
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
  async setState(id: string, state: InboxEventState) {
    const changed = await this.db.run(
      sql`UPDATE inbox_events SET state=${state} WHERE id=${id}`,
    );
    return changed > 0 ? this.event(id) : undefined;
  }
  /** The discovery source for a connected account, if there is one. */
  async composioSource(accountId: string) {
    const row = await this.db.row<SourceRow>(
      sql`SELECT * FROM inbox_sources WHERE type='composio' AND config::jsonb->>'accountId'=${accountId} ORDER BY created_at LIMIT 1`,
    );
    return row ? this.record(row) : undefined;
  }
  async composioSources() {
    return (
      await this.db.rows<SourceRow>(
        sql`SELECT * FROM inbox_sources WHERE type='composio' ORDER BY created_at`,
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
  }) {
    const now = Date.now();
    await this.db.run(
      sql`INSERT INTO discovery_findings (id, event_id, attention, category, confidence, reason, judged_by, state, dot_id, referenced_event_id, created_at, updated_at) VALUES (${randomUUID()}, ${value.eventId}, ${value.attention}, ${clip(value.category, 40)}, ${Math.min(Math.max(value.confidence, 0), 1)}, ${clip(value.reason, 500)}, ${clip(value.judgedBy, 120)}, ${value.attention ? 'flagged' : 'ignored'}, ${value.dotId}, ${value.referencedEventId ?? null}, ${now}, ${now}) ON CONFLICT (event_id) DO NOTHING`,
    );
    return (await this.findingForEvent(value.eventId))!;
  }
  async updateFinding(
    id: string,
    patch: { state: FindingState; threadId?: string; error?: string | null },
  ) {
    await this.db.run(
      sql`UPDATE discovery_findings SET state=${patch.state}, thread_id=COALESCE(${patch.threadId ?? null}::text, thread_id), error=${patch.error ? clip(patch.error, 500) : null}, updated_at=${Date.now()} WHERE id=${id}`,
    );
    return this.finding(id);
  }
}
