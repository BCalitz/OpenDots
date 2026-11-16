import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type { WaitingView } from '../../shared/inbox-types.js';

/** Days before the Dot offers a follow-up on something nobody answered. */
export const NUDGE_AFTER_MS = 3 * 86_400_000;

/**
 * Things the owner sent that ask for something back. "They owe you": kept
 * apart from what the owner owes, so the Dot never nags about it.
 */
export class WaitingStore {
  constructor(private db: Db) {}

  async add(entry: {
    eventId: string;
    who: string | null;
    title: string;
    dotId: string | null;
    since: number;
  }) {
    const now = Date.now();
    await this.db.run(
      sql`INSERT INTO waiting_on (id, event_id, who, title, dot_id, state, since, created_at, updated_at)
        VALUES (${randomUUID()}, ${entry.eventId}, ${entry.who}, ${entry.title.slice(0, 300)}, ${entry.dotId}, 'waiting', ${entry.since}, ${now}, ${now})
        ON CONFLICT (event_id) DO NOTHING`,
    );
  }
  list(state: WaitingView['state'] = 'waiting', limit = 100) {
    return this.db.rows<WaitingView>(
      sql`SELECT id, event_id, who, title, dot_id, state, since, nudged_at, answered_by FROM waiting_on WHERE state=${state} ORDER BY since ASC LIMIT ${limit}`,
    );
  }
  async get(id: string) {
    return this.db.row<WaitingView>(
      sql`SELECT id, event_id, who, title, dot_id, state, since, nudged_at, answered_by FROM waiting_on WHERE id=${id}`,
    );
  }
  /** A later item answered the one the owner sent. */
  async answer(eventId: string, byEventId: string) {
    return (
      (await this.db.run(
        sql`UPDATE waiting_on SET state='answered', answered_by=${byEventId}, updated_at=${Date.now()} WHERE event_id=${eventId} AND state='waiting'`,
      )) > 0
    );
  }
  async dismiss(id: string) {
    return (
      (await this.db.run(
        sql`UPDATE waiting_on SET state='dismissed', updated_at=${Date.now()} WHERE id=${id} AND state='waiting'`,
      )) > 0
    );
  }
  /** Overdue and not yet mentioned. */
  due(now: number) {
    return this.db.rows<WaitingView>(
      sql`SELECT id, event_id, who, title, dot_id, state, since, nudged_at, answered_by FROM waiting_on WHERE state='waiting' AND nudged_at IS NULL AND since <= ${now - NUDGE_AFTER_MS} ORDER BY since LIMIT 20`,
    );
  }
  async markNudged(id: string, at: number) {
    await this.db.run(
      sql`UPDATE waiting_on SET nudged_at=${at} WHERE id=${id}`,
    );
  }
}
