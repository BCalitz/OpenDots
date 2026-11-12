import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type {
  ProposalChoice,
  ProposalDecision,
  ProposalState,
  ProposalView,
  Route,
  TriageRuleView,
  Urgency,
} from '../../shared/inbox-types.js';

const COLUMNS = sql.raw(
  'id, finding_id, event_id, dot_id, thread_id, title, summary, options, state, decision, decided_at, snooze_until, importance, urgency, route, sender, error, created_at, updated_at',
);
type Row = Omit<ProposalView, 'options'> & { options: string };
const view = (row: Row): ProposalView => ({
  ...row,
  options: JSON.parse(row.options) as ProposalChoice[],
});
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** States a follow-up item reopens; running work is left alone. */
const REOPEN: ProposalState[] = [
  'open',
  'prepared',
  'handled',
  'snoozed',
  'dismissed',
  'failed',
  'closed',
];
/** How far back dismissals count toward a sender's triage rule. */
const RULE_WINDOW_MS = 90 * 24 * 60 * 60_000;

/** Proposals: one per conversation, with the owner's three choices. */
export class ProposalStore {
  constructor(private db: Db) {}

  /**
   * Records a proposal for a conversation, or updates the one already
   * there: a follow-up in the same thread brings it back to the owner.
   */
  async save(input: {
    findingId: string;
    eventId: string;
    dotId: string;
    threadId: string;
    title: string;
    summary: string;
    options: ProposalChoice[];
    importance: number;
    urgency: Urgency | null;
    route: Route | null;
    sender: string | null;
  }): Promise<ProposalView> {
    const now = Date.now();
    const title = clip(input.title, 200);
    const summary = clip(input.summary, 1200);
    const options = JSON.stringify(input.options);
    await this.db.run(
      sql`INSERT INTO proposals (id, finding_id, event_id, dot_id, thread_id, title, summary, options, state, importance, urgency, route, sender, created_at, updated_at)
        VALUES (${randomUUID()}, ${input.findingId}, ${input.eventId}, ${input.dotId}, ${input.threadId}, ${title}, ${summary}, ${options}, 'open', ${input.importance}, ${input.urgency}, ${input.route}, ${input.sender}, ${now}, ${now})
        ON CONFLICT (thread_id) DO UPDATE SET
          finding_id=excluded.finding_id, event_id=excluded.event_id, title=excluded.title,
          summary=excluded.summary, options=excluded.options,
          importance=GREATEST(proposals.importance, excluded.importance),
          urgency=excluded.urgency, route=excluded.route, sender=excluded.sender,
          state=CASE WHEN proposals.state = ANY(${REOPEN}) THEN 'open' ELSE proposals.state END,
          decision=CASE WHEN proposals.state = ANY(${REOPEN}) THEN NULL ELSE proposals.decision END,
          snooze_until=NULL, error=NULL, updated_at=excluded.updated_at`,
    );
    return (await this.forThread(input.threadId))!;
  }
  async get(id: string) {
    const row = await this.db.row<Row>(
      sql`SELECT ${COLUMNS} FROM proposals WHERE id=${id}`,
    );
    return row && view(row);
  }
  async forThread(threadId: string) {
    const row = await this.db.row<Row>(
      sql`SELECT ${COLUMNS} FROM proposals WHERE thread_id=${threadId}`,
    );
    return row && view(row);
  }
  async forFinding(findingId: string) {
    const row = await this.db.row<Row>(
      sql`SELECT ${COLUMNS} FROM proposals WHERE finding_id=${findingId}`,
    );
    return row && view(row);
  }
  /** Most important first. Without `all`, only what still needs the owner. */
  async list(options: { all?: boolean; limit?: number } = {}) {
    const which = options.all
      ? sql``
      : sql`WHERE state IN ('open','preparing','prepared','handling','failed','snoozed')`;
    return (
      await this.db.rows<Row>(
        sql`SELECT ${COLUMNS} FROM proposals ${which} ORDER BY importance DESC, created_at DESC, seq DESC LIMIT ${options.limit ?? 200}`,
      )
    ).map(view);
  }
  /**
   * Moves a proposal from one of `from` to `to`, so two decisions cannot
   * both win. Returns the proposal when it moved.
   */
  async transition(
    id: string,
    from: ProposalState[],
    to: ProposalState,
    patch: {
      decision?: ProposalDecision;
      snoozeUntil?: number | null;
      error?: string | null;
    } = {},
  ) {
    const now = Date.now();
    const sets = [sql`state=${to}`, sql`updated_at=${now}`];
    if (patch.decision)
      sets.push(sql`decision=${patch.decision}`, sql`decided_at=${now}`);
    if (patch.snoozeUntil !== undefined)
      sets.push(sql`snooze_until=${patch.snoozeUntil}`);
    sets.push(sql`error=${patch.error ? clip(patch.error, 500) : null}`);
    const moved = await this.db.run(
      sql`UPDATE proposals SET ${sql.join(sets, ', ')} WHERE id=${id} AND state = ANY(${from})`,
    );
    return moved ? this.get(id) : undefined;
  }
  /** Closes a finding's proposal when a later item says it is done. */
  async close(findingId: string) {
    await this.db.run(
      sql`UPDATE proposals SET state='closed', updated_at=${Date.now()} WHERE finding_id=${findingId} AND state IN ('open','snoozed','prepared','failed')`,
    );
  }
  /** Raises a proposal's importance when a later item escalates it. */
  async escalate(findingId: string, urgency: Urgency, importance: number) {
    await this.db.run(
      sql`UPDATE proposals SET urgency=${urgency}, importance=GREATEST(importance, ${importance}), updated_at=${Date.now()} WHERE finding_id=${findingId}`,
    );
  }
  /** Snoozed proposals whose time has come, reopened. */
  async wake(now: number) {
    const due = await this.db.rows<Row>(
      sql`SELECT ${COLUMNS} FROM proposals WHERE state='snoozed' AND snooze_until<=${now} ORDER BY snooze_until, seq`,
    );
    const woken: ProposalView[] = [];
    for (const row of due) {
      const moved = await this.transition(row.id, ['snoozed'], 'open', {
        snoozeUntil: null,
      });
      if (moved) woken.push(moved);
    }
    return woken;
  }
  /** Work interrupted by a restart can be chosen again. */
  async failRunning(message: string) {
    await this.db.run(
      sql`UPDATE proposals SET state='failed', error=${message}, updated_at=${Date.now()} WHERE state IN ('preparing','handling')`,
    );
  }

  /**
   * How often the owner dismissed this sender's items lately, and whether
   * they ever chose to prepare or handle one. Feeds the triage rule.
   */
  async senderHistory(sender: string, now = Date.now()) {
    const row = await this.db.row<{ dismissed: number; acted: number }>(
      sql`SELECT
          COUNT(*) FILTER (WHERE decision='dismiss' AND counted)::int AS dismissed,
          COUNT(*) FILTER (WHERE decision IN ('prepare','handle'))::int AS acted
        FROM proposals WHERE sender=${sender} AND decided_at>=${now - RULE_WINDOW_MS}`,
    );
    return { dismissed: row?.dismissed ?? 0, acted: row?.acted ?? 0 };
  }
  /** Senders the triage rule currently quiets. */
  async rules(minimum: number, now = Date.now()): Promise<TriageRuleView[]> {
    return this.db.rows<TriageRuleView>(
      sql`SELECT sender, COUNT(*) FILTER (WHERE decision='dismiss' AND counted)::int AS dismissed,
          MAX(decided_at) FILTER (WHERE decision='dismiss' AND counted) AS last_dismissed_at
        FROM proposals WHERE sender IS NOT NULL AND decided_at>=${now - RULE_WINDOW_MS}
        GROUP BY sender
        HAVING COUNT(*) FILTER (WHERE decision='dismiss' AND counted)>=${minimum}
          AND COUNT(*) FILTER (WHERE decision IN ('prepare','handle'))=0
        ORDER BY last_dismissed_at DESC`,
    );
  }
  /** Forgets a sender's dismissals, so their items are flagged again. */
  async forgetRule(sender: string) {
    return this.db.run(
      sql`UPDATE proposals SET counted=false WHERE sender=${sender} AND decision='dismiss' AND counted`,
    );
  }
}
