import { sql, type Db } from './db/index.js';
import { randomUUID } from 'node:crypto';
import type {
  AuditEntry,
  DailyUsage,
  DotUsage,
  UsageReport,
} from '../shared/insight-types.js';

const DAY_MS = 86_400_000;
const MAX_AUDIT_ROWS = 5000;
/** First millisecond of the UTC calendar month containing `now`. */
export function monthStart(now = Date.now()) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

/**
 * Token usage per run and a log of outside actions that have no receipt
 * table of their own (ungated MCP calls and Composio tools). Usage is
 * recorded by the Dot as each run finishes, so it works with either
 * conversation backend.
 */
export class UsageStore {
  constructor(private db: Db) {}
  /** Adds a run's tokens. A resumed run with the same id adds to its row. */
  async record(entry: {
    runId: string;
    threadId: string;
    dotId: string;
    model?: string | null;
    inputTokens: number;
    outputTokens: number;
    at?: number;
  }) {
    if (entry.inputTokens <= 0 && entry.outputTokens <= 0) return;
    await this.db.run(
      sql`INSERT INTO usage_ledger VALUES (${entry.runId}, ${entry.threadId}, ${entry.dotId}, ${entry.model ?? null}, ${entry.inputTokens}, ${entry.outputTokens}, ${entry.at ?? Date.now()}) ON CONFLICT (run_id) DO UPDATE SET input_tokens=usage_ledger.input_tokens+excluded.input_tokens, output_tokens=usage_ledger.output_tokens+excluded.output_tokens`,
    );
  }
  /** Input plus output tokens this UTC month. */
  async monthTokens(dotId: string, now = Date.now()) {
    const row = await this.db.row<{ total: number }>(
      sql`SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM usage_ledger WHERE dot_id=${dotId} AND created_at>=${monthStart(now)}`,
    );
    return Number(row?.total ?? 0);
  }
  async report(
    dots: { id: string; monthlyTokenCap?: number | null }[],
    days = 30,
    now = Date.now(),
  ): Promise<UsageReport> {
    const since = monthStart(now);
    const monthly = new Map(
      (
        await this.db.rows<Omit<DotUsage, 'monthlyTokenCap' | 'capReached'>>(
          sql`SELECT dot_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, COUNT(*) AS runs FROM usage_ledger WHERE created_at>=${since} GROUP BY dot_id`,
        )
      ).map((row) => [row.dotId, row]),
    );
    const usage: DotUsage[] = dots.map((dot) => {
      const row = monthly.get(dot.id);
      const inputTokens = Number(row?.inputTokens ?? 0);
      const outputTokens = Number(row?.outputTokens ?? 0);
      const cap = dot.monthlyTokenCap ?? null;
      return {
        dotId: dot.id,
        inputTokens,
        outputTokens,
        runs: Number(row?.runs ?? 0),
        monthlyTokenCap: cap,
        capReached: cap !== null && inputTokens + outputTokens >= cap,
      };
    });
    const daily = await this.db.rows<DailyUsage>(
      sql`SELECT to_char(to_timestamp(created_at / 1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, dot_id, SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens, COUNT(*) AS runs FROM usage_ledger WHERE created_at>=${now - days * DAY_MS} GROUP BY day, dot_id ORDER BY day DESC, dot_id`,
    );
    return {
      month: new Date(since).toISOString().slice(0, 7),
      dots: usage,
      daily: daily.map((row) => ({
        ...row,
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        runs: Number(row.runs),
      })),
    };
  }
  /** Records an outside action that has started; finish it with the returned id. */
  async beginAction(entry: {
    dotId: string;
    threadId?: string | null;
    kind: 'mcp' | 'app';
    target: string;
    action: string;
    readOnly?: boolean;
  }) {
    const id = randomUUID();
    await this.db.run(
      sql`INSERT INTO action_log (id, dot_id, thread_id, kind, target, action, read_only, outcome, created_at) VALUES (${id}, ${entry.dotId}, ${entry.threadId ?? null}, ${entry.kind}, ${entry.target.slice(0, 120)}, ${entry.action.slice(0, 200)}, ${!!entry.readOnly}, 'pending', ${Date.now()})`,
    );
    return id;
  }
  async finishAction(id: string, outcome: 'succeeded' | 'failed') {
    await this.db.transaction(async () => {
      await this.db.run(
        sql`UPDATE action_log SET outcome=${outcome} WHERE id=${id}`,
      );
      await this.db.run(
        sql`DELETE FROM action_log WHERE id NOT IN (SELECT id FROM action_log ORDER BY created_at DESC, seq DESC LIMIT ${MAX_AUDIT_ROWS})`,
      );
    });
  }
  /**
   * Every action taken outside OpenDots, newest first: approved MCP actions,
   * ungated MCP calls, Composio tools and computer actions.
   */
  audit(
    filter: { dotId?: string; changesOnly?: boolean; limit?: number } = {},
  ): Promise<AuditEntry[]> {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const where = [];
    if (filter.dotId) where.push(sql`dot_id=${filter.dotId}`);
    if (filter.changesOnly) where.push(sql`NOT read_only`);
    // isError is truthy JSON in a failed MCP result.
    const failed = sql.raw(
      "COALESCE(a.result::jsonb->>'isError', 'false') NOT IN ('false', '0', '')",
    );
    return this.db.rows<AuditEntry>(
      sql`SELECT id, at, dot_id, thread_id, kind, target, action, actor, approved, outcome FROM (
          SELECT 'mcp:' || a.thread_id || ':' || a.tool_call_id AS id, a.created_at AS at, a.dot_id, a.thread_id, 'mcp' AS kind, COALESCE(c.name, 'Removed connection') AS target, a.tool AS action, 'agent' AS actor, true AS approved, false AS read_only,
            CASE WHEN a.status<>'done' THEN 'pending' WHEN ${failed} THEN 'failed' ELSE 'succeeded' END AS outcome
          FROM connector_actions a LEFT JOIN accounts c ON c.id=a.account_id
          UNION ALL
          SELECT 'log:' || id, created_at, dot_id, thread_id, kind, target, action, 'agent', false, read_only, outcome FROM action_log
          UNION ALL
          SELECT 'computer:' || id, created_at, dot_id, NULL, 'computer', 'Computer', action, actor, false, false, outcome FROM computer_audit
        ) entries ${where.length ? sql`WHERE ${sql.join(where, ' AND ')}` : sql``}
        ORDER BY at DESC LIMIT ${limit}`,
    );
  }
}
