import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type { Memory, MemoryKind } from '../../shared/types.js';

/** A focus lasts a week when the owner doesn't say. */
export const DEFAULT_FOCUS_MS = 7 * 86_400_000;

/**
 * The owner's focus, mute and away entries, kept in the preferences table.
 * Discovery reads only these kinds; free-form notes never reach it.
 */
export class AttentionStore {
  constructor(private db: Db) {}

  /** Entries in effect now, newest first. */
  async active(now = Date.now()): Promise<Memory[]> {
    return this.db.rows<Memory>(
      sql`SELECT * FROM memories WHERE kind IN ('focus','mute','away') AND (until IS NULL OR until > ${now}) ORDER BY created_at DESC`,
    );
  }
  /** Active entries and the owner's notes, for the chat Dot to list. */
  async list(now = Date.now()): Promise<Memory[]> {
    return this.db.rows<Memory>(
      sql`SELECT * FROM memories WHERE until IS NULL OR until > ${now} ORDER BY created_at DESC`,
    );
  }
  async save(entry: {
    kind: MemoryKind;
    text: string;
    subject?: string | null;
    until?: number | null;
  }): Promise<Memory> {
    const subject = entry.subject?.trim() || null;
    // Saying the same thing again renews it instead of adding a copy.
    if (subject && entry.kind !== 'note') {
      const same = await this.db.row<Memory>(
        sql`SELECT * FROM memories WHERE kind=${entry.kind} AND lower(subject)=${subject.toLowerCase()}`,
      );
      if (same) {
        return (await this.db.row<Memory>(
          sql`UPDATE memories SET text=${entry.text}, until=${entry.until ?? null} WHERE id=${same.id} RETURNING *`,
        ))!;
      }
    }
    return (await this.db.row<Memory>(
      sql`INSERT INTO memories (id, text, created_at, kind, subject, until) VALUES (${randomUUID()}, ${entry.text}, ${Date.now()}, ${entry.kind}, ${subject}, ${entry.until ?? null}) RETURNING *`,
    ))!;
  }
  async lift(id: string): Promise<boolean> {
    return (await this.db.run(sql`DELETE FROM memories WHERE id=${id}`)) > 0;
  }
  /** Whether an away entry ended in (since, now]: the owner is back. */
  async awayEndedBetween(since: number, now: number) {
    const row = await this.db.row<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM memories WHERE kind='away' AND until > ${since} AND until <= ${now}`,
    );
    return (row?.n ?? 0) > 0;
  }
}
