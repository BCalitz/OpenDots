import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type { Memory, MemoryKind } from '../../shared/types.js';

/** How the owner talks about each kind of item. Security and personal mail are never offered. */
const MUTABLE: Record<string, string> = {
  payment: 'payment notifications',
  invoice: 'invoices',
  bill: 'bills and statements',
  request: 'requests',
  question: 'questions',
  meeting: 'meeting invites',
  deadline: 'deadline reminders',
  newsletter: 'newsletters',
  notification: 'automatic notifications',
};
const SUGGEST_WINDOW_MS = 30 * 86_400_000;
/** Dismissals of one kind, with none acted on, before a mute is offered. */
const SUGGEST_AFTER = 3;
export interface MuteSuggestion {
  category: string;
  /** What the mute would be about, in the owner's words. */
  subject: string;
  dismissed: number;
  /** Why it is offered. */
  why: string;
}

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
  /**
   * Kinds of item the owner keeps dismissing and never acts on, as mutes to
   * offer. Never for security or personal mail; never for one already muted
   * or turned down.
   */
  async suggestions(now = Date.now()): Promise<MuteSuggestion[]> {
    const rows = await this.db.rows<{ category: string; dismissed: number }>(
      sql`SELECT f.category AS category,
          COUNT(*) FILTER (WHERE p.decision='dismiss' AND p.counted)::int AS dismissed
        FROM proposals p JOIN discovery_findings f ON f.id=p.finding_id
        WHERE p.decided_at>=${now - SUGGEST_WINDOW_MS}
          AND f.category NOT IN (SELECT category FROM attention_declined)
        GROUP BY f.category
        HAVING COUNT(*) FILTER (WHERE p.decision='dismiss' AND p.counted)>=${SUGGEST_AFTER}
          AND COUNT(*) FILTER (WHERE p.decision IN ('prepare','handle'))=0
        ORDER BY dismissed DESC`,
    );
    const muted = (await this.active(now))
      .filter((entry) => entry.kind === 'mute')
      .map((entry) => entry.subject?.toLowerCase() ?? '');
    return rows.flatMap((row) => {
      const subject = MUTABLE[row.category];
      if (!subject || muted.includes(subject)) return [];
      return [
        {
          category: row.category,
          subject,
          dismissed: row.dismissed,
          why: `You dismissed ${row.dismissed} of these in the last 30 days and acted on none.`,
        },
      ];
    });
  }
  /** Turns a suggestion into a mute. Fraud and urgent items still get through. */
  async acceptSuggestion(category: string) {
    const subject = MUTABLE[category];
    if (!subject) return undefined;
    return this.save({
      kind: 'mute',
      text: `Not flagging ${subject}`,
      subject,
    });
  }
  /** The owner said no: don't offer this kind again. */
  async declineSuggestion(category: string) {
    if (!MUTABLE[category]) return false;
    await this.db.run(
      sql`INSERT INTO attention_declined VALUES (${category}, ${Date.now()}) ON CONFLICT (category) DO NOTHING`,
    );
    return true;
  }
  /** Whether an away entry ended in (since, now]: the owner is back. */
  async awayEndedBetween(since: number, now: number) {
    const row = await this.db.row<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM memories WHERE kind='away' AND until > ${since} AND until <= ${now}`,
    );
    return (row?.n ?? 0) > 0;
  }
}
