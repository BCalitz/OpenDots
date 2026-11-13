import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import { ProposalStore } from './proposal-store.js';
import type {
  BriefEntry,
  DiscoverySettings,
  EventLinkView,
} from '../../shared/inbox-types.js';

export const DEFAULT_DISCOVERY_SETTINGS: DiscoverySettings = {
  briefTime: '07:30',
  quietHours: { start: '22:00', end: '07:00' },
  holdMinutes: 5,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  trusted: [],
  allowedApps: [],
  retentionDays: 14,
};

export interface QueuedPush {
  id: string;
  findingId: string | null;
  /** Set when the push carries the three choices. */
  proposalId: string | null;
  kind: 'finding' | 'correction' | 'brief' | 'proposal';
  title: string;
  body: string;
  threadId: string | null;
  section: BriefEntry['section'] | null;
  urgent: boolean;
  dueAt: number | null;
  /** brief: waiting for the next brief; briefed: in a brief already sent. */
  state: 'queued' | 'brief' | 'briefed' | 'sent' | 'cancelled';
  createdAt: number;
  sentAt: number | null;
}

const PUSH = sql.raw(
  'id, finding_id, proposal_id, kind, title, body, thread_id, section, urgent, due_at, state, created_at, sent_at',
);

/**
 * Discovery with history: links between items, pushes waiting to go out,
 * and the owner's delivery settings. Earlier items come from memory.
 */
export class DiscoveryStore {
  /** Proposals: flagged items with the owner's three choices. */
  readonly proposals: ProposalStore;
  constructor(private db: Db) {
    this.proposals = new ProposalStore(db);
  }

  async settings(): Promise<DiscoverySettings> {
    const row = await this.db.row<{ value: string }>(
      sql`SELECT value FROM discovery_settings WHERE id=1`,
    );
    return {
      ...DEFAULT_DISCOVERY_SETTINGS,
      ...(row ? (JSON.parse(row.value) as Partial<DiscoverySettings>) : {}),
    };
  }
  async updateSettings(patch: Partial<DiscoverySettings>) {
    return this.db.transaction(async () => {
      const settings = { ...(await this.settings()), ...patch };
      await this.db.run(
        sql`INSERT INTO discovery_settings VALUES (1, ${JSON.stringify(settings)}) ON CONFLICT (id) DO UPDATE SET value=excluded.value`,
      );
      return settings;
    });
  }

  /** Called before a source's items are removed. */
  async forgetSource(sourceId: string) {
    const events = sql`SELECT id FROM inbox_events WHERE source_id=${sourceId}`;
    await this.db.run(
      sql`DELETE FROM event_links WHERE event_id IN (${events}) OR other_event_id IN (${events})`,
    );
    await this.db.run(
      sql`DELETE FROM discovery_pushes WHERE finding_id IN (SELECT f.id FROM discovery_findings f WHERE f.event_id IN (${events}))`,
    );
  }

  /** Saves a link; the owner's own confirmations and rejections stay. */
  async link(
    eventId: string,
    otherEventId: string,
    score: number,
    status: 'linked' | 'review',
  ) {
    await this.db.run(
      sql`INSERT INTO event_links VALUES (${eventId}, ${otherEventId}, ${score}, ${status}, ${Date.now()}, NULL)
        ON CONFLICT (event_id, other_event_id) DO UPDATE SET score=excluded.score, status=excluded.status
        WHERE event_links.status IN ('linked','review')`,
    );
  }
  /** Links to and from an item, with the other item's title. */
  links(eventId: string): Promise<EventLinkView[]> {
    return this.linkRows(
      sql`WHERE l.event_id=${eventId} OR l.other_event_id=${eventId}`,
      eventId,
    );
  }
  /** Links Jev wasn't sure of, for the owner to confirm or reject. */
  reviewQueue(limit = 50): Promise<EventLinkView[]> {
    return this.linkRows(
      sql`WHERE l.status='review' ORDER BY l.created_at DESC LIMIT ${limit}`,
    );
  }
  private async linkRows(
    where: ReturnType<typeof sql>,
    viewFrom?: string,
  ): Promise<EventLinkView[]> {
    const rows = await this.db.rows<
      Omit<EventLinkView, 'other' | 'item'> & {
        otherTitle: string | null;
        otherFrom: string | null;
        otherAt: number | null;
        itemTitle: string | null;
        itemFrom: string | null;
        itemAt: number | null;
      }
    >(
      sql`SELECT l.event_id, l.other_event_id, l.score, l.status, l.created_at, o.title AS other_title, o.sender AS other_from, o.occurred_at AS other_at,
          n.title AS item_title, n.sender AS item_from, n.occurred_at AS item_at
        FROM event_links l
        LEFT JOIN inbox_events o ON o.id = ${viewFrom ? sql`CASE WHEN l.event_id=${viewFrom} THEN l.other_event_id ELSE l.event_id END` : sql`l.other_event_id`}
        LEFT JOIN inbox_events n ON n.id = ${viewFrom ? sql`CASE WHEN l.event_id=${viewFrom} THEN l.event_id ELSE l.other_event_id END` : sql`l.event_id`} ${where}`,
    );
    const brief = (
      title: string | null,
      from: string | null,
      at: number | null,
    ) => (title === null ? null : { title, from, occurredAt: at! });
    return rows.map(
      ({
        otherTitle,
        otherFrom,
        otherAt,
        itemTitle,
        itemFrom,
        itemAt,
        ...link
      }) => {
        // Seen from the item asked about, the other item is the other end.
        const flipped = viewFrom !== undefined && link.eventId !== viewFrom;
        return {
          ...link,
          ...(flipped
            ? { eventId: link.otherEventId, otherEventId: link.eventId }
            : {}),
          item: brief(itemTitle, itemFrom, itemAt),
          other: brief(otherTitle, otherFrom, otherAt),
        };
      },
    );
  }
  /** The owner confirms or rejects a link; returns whether it existed. */
  async decideLink(
    eventId: string,
    otherEventId: string,
    status: 'confirmed' | 'rejected',
  ) {
    return (
      (await this.db.run(
        sql`UPDATE event_links SET status=${status}, decided_at=${Date.now()}
          WHERE (event_id=${eventId} AND other_event_id=${otherEventId}) OR (event_id=${otherEventId} AND other_event_id=${eventId})`,
      )) > 0
    );
  }
  /** Pairs the owner rejected, so they are never linked again. */
  async rejected(eventId: string) {
    return new Set(
      (
        await this.db.rows<{ other: string }>(
          sql`SELECT CASE WHEN event_id=${eventId} THEN other_event_id ELSE event_id END AS other
            FROM event_links WHERE status='rejected' AND (event_id=${eventId} OR other_event_id=${eventId})`,
        )
      ).map((row) => row.other),
    );
  }

  async queuePush(
    push: Omit<QueuedPush, 'id' | 'createdAt' | 'sentAt'>,
    at = Date.now(),
  ): Promise<QueuedPush> {
    const id = randomUUID();
    await this.db.run(
      sql`INSERT INTO discovery_pushes (id, finding_id, proposal_id, kind, title, body, thread_id, section, urgent, due_at, state, created_at)
        VALUES (${id}, ${push.findingId}, ${push.proposalId}, ${push.kind}, ${push.title.slice(0, 200)}, ${push.body.slice(0, 500)}, ${push.threadId}, ${push.section}, ${push.urgent}, ${push.dueAt}, ${push.state}, ${at})`,
    );
    return (await this.push(id))!;
  }
  push(id: string) {
    return this.db.row<QueuedPush>(
      sql`SELECT ${PUSH} FROM discovery_pushes WHERE id=${id}`,
    );
  }
  pushes(state: QueuedPush['state']) {
    return this.db.rows<QueuedPush>(
      sql`SELECT ${PUSH} FROM discovery_pushes WHERE state=${state} ORDER BY created_at, seq`,
    );
  }
  pushesFor(findingId: string) {
    return this.db.rows<QueuedPush>(
      sql`SELECT ${PUSH} FROM discovery_pushes WHERE finding_id=${findingId} ORDER BY created_at, seq`,
    );
  }
  due(now: number) {
    return this.db.rows<QueuedPush>(
      sql`SELECT ${PUSH} FROM discovery_pushes WHERE state='queued' AND due_at<=${now} ORDER BY due_at, seq`,
    );
  }
  async setPushState(id: string, state: QueuedPush['state'], now = Date.now()) {
    await this.db.run(
      sql`UPDATE discovery_pushes SET state=${state}, sent_at=${state === 'sent' || state === 'briefed' ? now : null} WHERE id=${id}`,
    );
  }
  /** Cancels a finding's waiting pushes; returns whether one already went out. */
  async cancelPushes(findingId: string) {
    await this.db.run(
      sql`UPDATE discovery_pushes SET state='cancelled' WHERE finding_id=${findingId} AND state IN ('queued','brief')`,
    );
    return !!(await this.db.row(
      sql`SELECT 1 FROM discovery_pushes WHERE finding_id=${findingId} AND kind='finding' AND state IN ('sent','briefed')`,
    ));
  }
  /** When the last morning brief went out. */
  async lastBriefAt() {
    return (
      (
        await this.db.row<{ at: number | null }>(
          sql`SELECT max(sent_at) AS at FROM discovery_pushes WHERE kind='brief' AND state='sent'`,
        )
      )?.at ?? null
    );
  }
  /**
   * The morning brief: what the next one will hold, or what the brief sent
   * at `sentAt` held, leaving out items resolved since.
   */
  async brief(sentAt?: number): Promise<BriefEntry[]> {
    const which =
      sentAt === undefined
        ? sql`p.state='brief'`
        : sql`p.state='briefed' AND p.sent_at=${sentAt}`;
    const rows = await this.db.rows<QueuedPush & { eventId: string | null }>(
      sql`SELECT p.finding_id, p.proposal_id, p.title, p.body, p.thread_id, p.section, p.created_at, f.event_id
        FROM discovery_pushes p LEFT JOIN discovery_findings f ON f.id=p.finding_id
        WHERE ${which} AND (f.state IS NULL OR f.state<>'resolved')
        ORDER BY p.created_at, p.seq`,
    );
    return rows.map((row) => ({
      findingId: row.findingId,
      proposalId: row.proposalId,
      eventId: row.eventId,
      title: row.title,
      body: row.body,
      threadId: row.threadId,
      section: row.section ?? 'updates',
      createdAt: row.createdAt,
    }));
  }
}
