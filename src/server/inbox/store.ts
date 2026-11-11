import type { DatabaseSync } from 'node:sqlite';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  ComposioSourceConfig,
  FindingState,
  FindingView,
  InboxEventState,
  InboxEventView,
  InboxNotify,
  InboxSourceView,
  McpSourceConfig,
  SourceConfig,
  SourceKind,
  SourceType,
} from '../../shared/inbox-types.js';
import type { InboxEvent } from './source.js';

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
type SourceRow = Omit<SourceRecord, 'config' | 'enabled'> & {
  config: string;
  enabled: number;
  secretHash: string | null;
  lease: string | null;
  leaseUntil: number | null;
};
const hash = (secret: string) =>
  createHash('sha256').update(secret).digest('hex');
const clip = (value: string, max = MAX_TEXT) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;
/** Sources the poller runs on a timer. */
const POLLED = "type IN ('mcp', 'composio')";
type FindingRow = Omit<FindingView, 'attention'> & { attention: number };
const findingView = (row: FindingRow): FindingView => ({
  ...row,
  attention: !!row.attention,
});
type EventRow = Omit<InboxEventView, 'finding'> & {
  findingId: string | null;
};

export class InboxStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS inbox_sources(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, notify TEXT NOT NULL DEFAULT 'urgent', intervalSeconds INTEGER NOT NULL DEFAULT 300, secretHash TEXT, cursor TEXT, lease TEXT, leaseUntil INTEGER, lastPolledAt INTEGER, nextPollAt INTEGER, lastError TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox_events(id TEXT PRIMARY KEY, sourceId TEXT NOT NULL, externalId TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, priority TEXT NOT NULL, sender TEXT, url TEXT, payload TEXT NOT NULL, occurredAt INTEGER NOT NULL, receivedAt INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'new', UNIQUE(sourceId, externalId));
      CREATE INDEX IF NOT EXISTS inbox_events_time ON inbox_events(receivedAt);
      CREATE TABLE IF NOT EXISTS discovery_findings(id TEXT PRIMARY KEY, eventId TEXT NOT NULL UNIQUE, attention INTEGER NOT NULL, category TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT NOT NULL, judgedBy TEXT NOT NULL, state TEXT NOT NULL, dotId TEXT, threadId TEXT, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS discovery_findings_state ON discovery_findings(state);`);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  private row(id: string) {
    return this.db.prepare('SELECT * FROM inbox_sources WHERE id=?').get(id) as
      SourceRow | undefined;
  }
  private record(row: SourceRow): SourceRecord {
    return {
      id: row.id,
      name: row.name,
      kind: row.kind,
      type: row.type,
      config: JSON.parse(row.config),
      enabled: !!row.enabled,
      notify: row.notify,
      intervalSeconds: row.intervalSeconds,
      cursor: row.cursor,
      lastPolledAt: row.lastPolledAt,
      nextPollAt: row.nextPollAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
    };
  }
  source(id: string) {
    const row = this.row(id);
    return row ? this.record(row) : undefined;
  }
  sources(): InboxSourceView[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM inbox_events e WHERE e.sourceId=s.id) AS eventCount,
          (SELECT COUNT(*) FROM inbox_events e WHERE e.sourceId=s.id AND e.state='new') AS newCount
        FROM inbox_sources s ORDER BY s.createdAt, s.rowid`,
      )
      .all() as unknown as (SourceRow & {
      eventCount: number;
      newCount: number;
    })[];
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
  create(value: {
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
    this.db
      .prepare(
        'INSERT INTO inbox_sources (id, name, kind, type, config, enabled, notify, intervalSeconds, secretHash, nextPollAt, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        value.name,
        value.kind,
        value.type,
        JSON.stringify(value.config),
        value.notify,
        value.intervalSeconds,
        secret ? hash(secret) : null,
        value.type === 'webhook' ? null : now,
        now,
        now,
      );
    return { source: this.source(id)!, secret };
  }
  update(
    id: string,
    patch: Partial<
      Pick<SourceRecord, 'name' | 'enabled' | 'notify' | 'intervalSeconds'>
    > & { config?: McpSourceConfig | ComposioSourceConfig },
  ) {
    const current = this.source(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        'UPDATE inbox_sources SET name=?, enabled=?, notify=?, intervalSeconds=?, config=?, lastError=CASE WHEN ? THEN NULL ELSE lastError END, updatedAt=? WHERE id=?',
      )
      .run(
        next.name,
        next.enabled ? 1 : 0,
        next.notify,
        next.intervalSeconds,
        JSON.stringify(next.config),
        patch.config || patch.enabled ? 1 : 0,
        Date.now(),
        id,
      );
    return this.source(id);
  }
  remove(id: string) {
    return this.transaction(() => {
      this.db
        .prepare(
          'DELETE FROM discovery_findings WHERE eventId IN (SELECT id FROM inbox_events WHERE sourceId=?)',
        )
        .run(id);
      this.db.prepare('DELETE FROM inbox_events WHERE sourceId=?').run(id);
      return (
        this.db.prepare('DELETE FROM inbox_sources WHERE id=?').run(id)
          .changes > 0
      );
    });
  }
  rotateSecret(id: string) {
    const row = this.row(id);
    if (!row || row.type !== 'webhook') return undefined;
    const secret = randomBytes(32).toString('base64url');
    this.db
      .prepare('UPDATE inbox_sources SET secretHash=?, updatedAt=? WHERE id=?')
      .run(hash(secret), Date.now(), id);
    return secret;
  }
  /** Constant-time check of a webhook secret. */
  verifySecret(id: string, secret: string) {
    const row = this.row(id);
    if (!row?.secretHash || !row.enabled || !secret) return false;
    const expected = Buffer.from(row.secretHash, 'hex');
    const supplied = Buffer.from(hash(secret), 'hex');
    return timingSafeEqual(expected, supplied);
  }
  pollNow(id: string) {
    return (
      this.db
        .prepare(
          `UPDATE inbox_sources SET nextPollAt=? WHERE id=? AND ${POLLED}`,
        )
        .run(Date.now(), id).changes > 0
    );
  }
  /**
   * Claims one due polling source under a lease, like scheduled tasks, so two
   * workers never poll the same source at once.
   */
  claimDue(now = Date.now(), leaseMs = 120_000): SourceClaim | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM inbox_sources WHERE ${POLLED} AND enabled=1 AND COALESCE(nextPollAt, 0)<=? AND (lease IS NULL OR leaseUntil<=?) ORDER BY COALESCE(nextPollAt, 0), rowid LIMIT 1`,
        )
        .get(now, now) as SourceRow | undefined;
      if (!row) return undefined;
      const lease = randomUUID();
      this.db
        .prepare('UPDATE inbox_sources SET lease=?, leaseUntil=? WHERE id=?')
        .run(lease, now + leaseMs, row.id);
      return { source: this.record(row), lease };
    });
  }
  owns(claim: SourceClaim) {
    return this.row(claim.source.id)?.lease === claim.lease;
  }
  /** Releases the lease and schedules the next poll. Ignored if the lease moved on. */
  finishPoll(
    claim: SourceClaim,
    outcome: { cursor?: string; error?: string },
    now = Date.now(),
  ) {
    const current = this.row(claim.source.id);
    return (
      this.db
        .prepare(
          'UPDATE inbox_sources SET lease=NULL, leaseUntil=NULL, lastPolledAt=?, nextPollAt=?, cursor=COALESCE(?, cursor), lastError=? WHERE id=? AND lease=?',
        )
        .run(
          now,
          now +
            (current?.intervalSeconds ?? claim.source.intervalSeconds) * 1000,
          outcome.cursor ?? null,
          outcome.error ?? null,
          claim.source.id,
          claim.lease,
        ).changes > 0
    );
  }
  /** Writes events, skipping ones already seen. Returns only the new ones. */
  ingest(events: InboxEvent[], now = Date.now()): InboxEventView[] {
    const inserted: string[] = [];
    this.transaction(() => {
      const insert = this.db.prepare(
        'INSERT INTO inbox_events (id, sourceId, externalId, kind, title, summary, priority, sender, url, payload, occurredAt, receivedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sourceId, externalId) DO NOTHING',
      );
      for (const event of events) {
        const id = randomUUID();
        let payload: string;
        try {
          payload = JSON.stringify(event.raw ?? null) ?? 'null';
        } catch {
          payload = 'null';
        }
        const changes = insert.run(
          id,
          event.sourceId,
          clip(event.externalId, 300),
          clip(event.kind, 80),
          clip(event.title || '(untitled)', 300),
          clip(event.summary ?? ''),
          event.priority ?? 'normal',
          event.from ? clip(event.from, 200) : null,
          event.url && /^https?:\/\//i.test(event.url)
            ? clip(event.url, 2048)
            : null,
          clip(payload, 50_000),
          event.occurredAt,
          now,
        ).changes;
        if (changes) inserted.push(id);
      }
      for (const sourceId of new Set(events.map((event) => event.sourceId)))
        this.db
          .prepare(
            `DELETE FROM inbox_events WHERE sourceId=? AND id NOT IN (SELECT id FROM inbox_events WHERE sourceId=? ORDER BY receivedAt DESC, rowid DESC LIMIT ${MAX_EVENTS_PER_SOURCE})`,
          )
          .run(sourceId, sourceId);
      this.db.exec(
        'DELETE FROM discovery_findings WHERE eventId NOT IN (SELECT id FROM inbox_events)',
      );
    });
    return inserted
      .map((id) => this.event(id))
      .filter((event): event is InboxEventView => !!event);
  }
  private eventQuery = `SELECT e.id, e.sourceId, COALESCE(s.name, 'Removed source') AS sourceName, e.externalId, e.kind, e.title, e.summary, e.priority, e.sender AS "from", e.url, e.occurredAt, e.receivedAt, e.state, f.id AS findingId FROM inbox_events e LEFT JOIN inbox_sources s ON s.id=e.sourceId LEFT JOIN discovery_findings f ON f.eventId=e.id`;
  private toEvent({ findingId, ...row }: EventRow): InboxEventView {
    return {
      ...row,
      finding: findingId ? (this.finding(findingId) ?? null) : null,
    };
  }
  event(id: string) {
    const row = this.db.prepare(`${this.eventQuery} WHERE e.id=?`).get(id) as
      EventRow | undefined;
    return row ? this.toEvent(row) : undefined;
  }
  /** The stored raw payload, as untrusted data. */
  payload(id: string): unknown {
    const row = this.db
      .prepare('SELECT payload FROM inbox_events WHERE id=?')
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  }
  events(
    filter: {
      sourceId?: string;
      state?: InboxEventState;
      includeDismissed?: boolean;
      limit?: number;
    } = {},
  ): InboxEventView[] {
    const where: string[] = [];
    const values: string[] = [];
    if (filter.sourceId) {
      where.push('e.sourceId=?');
      values.push(filter.sourceId);
    }
    if (filter.state) {
      where.push('e.state=?');
      values.push(filter.state);
    } else if (!filter.includeDismissed) where.push("e.state<>'dismissed'");
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(
        `${this.eventQuery} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY CASE e.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, e.receivedAt DESC LIMIT ${limit}`,
      )
      .all(...values) as unknown as EventRow[];
    return rows.map((row) => this.toEvent(row));
  }
  setState(id: string, state: InboxEventState) {
    return this.db
      .prepare('UPDATE inbox_events SET state=? WHERE id=?')
      .run(state, id).changes > 0
      ? this.event(id)
      : undefined;
  }
  /** The discovery source for a connected account, if there is one. */
  composioSource(accountId: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM inbox_sources WHERE type='composio' AND json_extract(config, '$.accountId')=? ORDER BY createdAt LIMIT 1",
      )
      .get(accountId) as SourceRow | undefined;
    return row ? this.record(row) : undefined;
  }
  composioSources() {
    return (
      this.db
        .prepare(
          "SELECT * FROM inbox_sources WHERE type='composio' ORDER BY createdAt",
        )
        .all() as unknown as SourceRow[]
    ).map((row) => this.record(row));
  }
  finding(id: string) {
    const row = this.db
      .prepare('SELECT * FROM discovery_findings WHERE id=?')
      .get(id) as FindingRow | undefined;
    return row ? findingView(row) : undefined;
  }
  findingForEvent(eventId: string) {
    const row = this.db
      .prepare('SELECT * FROM discovery_findings WHERE eventId=?')
      .get(eventId) as FindingRow | undefined;
    return row ? findingView(row) : undefined;
  }
  findings(state: FindingState) {
    return (
      this.db
        .prepare(
          'SELECT * FROM discovery_findings WHERE state=? ORDER BY createdAt, rowid',
        )
        .all(state) as unknown as FindingRow[]
    ).map(findingView);
  }
  /** Records the discovery model's verdict on an event, once per event. */
  saveFinding(value: {
    eventId: string;
    attention: boolean;
    category: string;
    confidence: number;
    reason: string;
    judgedBy: string;
    dotId: string | null;
  }) {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO discovery_findings (id, eventId, attention, category, confidence, reason, judgedBy, state, dotId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(eventId) DO NOTHING',
      )
      .run(
        randomUUID(),
        value.eventId,
        value.attention ? 1 : 0,
        clip(value.category, 40),
        Math.min(Math.max(value.confidence, 0), 1),
        clip(value.reason, 500),
        clip(value.judgedBy, 120),
        value.attention ? 'flagged' : 'ignored',
        value.dotId,
        now,
        now,
      );
    return this.findingForEvent(value.eventId)!;
  }
  updateFinding(
    id: string,
    patch: { state: FindingState; threadId?: string; error?: string | null },
  ) {
    this.db
      .prepare(
        'UPDATE discovery_findings SET state=?, threadId=COALESCE(?, threadId), error=?, updatedAt=? WHERE id=?',
      )
      .run(
        patch.state,
        patch.threadId ?? null,
        patch.error ? clip(patch.error, 500) : null,
        Date.now(),
        id,
      );
    return this.finding(id);
  }
}
