import type { DatabaseSync } from 'node:sqlite';
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
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS usage_ledger(runId TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, model TEXT, inputTokens INTEGER NOT NULL, outputTokens INTEGER NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS usage_ledger_dot ON usage_ledger(dotId, createdAt);
      CREATE TABLE IF NOT EXISTS action_log(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, threadId TEXT, kind TEXT NOT NULL, target TEXT NOT NULL, action TEXT NOT NULL, readOnly INTEGER NOT NULL DEFAULT 0, outcome TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS action_log_time ON action_log(createdAt);`);
  }
  /** Adds a run's tokens. A resumed run with the same id adds to its row. */
  record(entry: {
    runId: string;
    threadId: string;
    dotId: string;
    model?: string | null;
    inputTokens: number;
    outputTokens: number;
    at?: number;
  }) {
    if (entry.inputTokens <= 0 && entry.outputTokens <= 0) return;
    this.db
      .prepare(
        'INSERT INTO usage_ledger VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(runId) DO UPDATE SET inputTokens=inputTokens+excluded.inputTokens, outputTokens=outputTokens+excluded.outputTokens',
      )
      .run(
        entry.runId,
        entry.threadId,
        entry.dotId,
        entry.model ?? null,
        entry.inputTokens,
        entry.outputTokens,
        entry.at ?? Date.now(),
      );
  }
  /** Input plus output tokens this UTC month. */
  monthTokens(dotId: string, now = Date.now()) {
    const row = this.db
      .prepare(
        'SELECT COALESCE(SUM(inputTokens + outputTokens), 0) AS total FROM usage_ledger WHERE dotId=? AND createdAt>=?',
      )
      .get(dotId, monthStart(now)) as { total: number };
    return Number(row.total);
  }
  report(
    dots: { id: string; monthlyTokenCap?: number | null }[],
    days = 30,
    now = Date.now(),
  ): UsageReport {
    const since = monthStart(now);
    const monthly = new Map(
      (
        this.db
          .prepare(
            'SELECT dotId, SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens, COUNT(*) AS runs FROM usage_ledger WHERE createdAt>=? GROUP BY dotId',
          )
          .all(since) as unknown as Omit<
          DotUsage,
          'monthlyTokenCap' | 'capReached'
        >[]
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
    const daily = this.db
      .prepare(
        "SELECT strftime('%Y-%m-%d', createdAt / 1000, 'unixepoch') AS day, dotId, SUM(inputTokens) AS inputTokens, SUM(outputTokens) AS outputTokens, COUNT(*) AS runs FROM usage_ledger WHERE createdAt>=? GROUP BY day, dotId ORDER BY day DESC, dotId",
      )
      .all(now - days * DAY_MS) as unknown as DailyUsage[];
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
  beginAction(entry: {
    dotId: string;
    threadId?: string | null;
    kind: 'mcp' | 'app';
    target: string;
    action: string;
    readOnly?: boolean;
  }) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO action_log VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
      )
      .run(
        id,
        entry.dotId,
        entry.threadId ?? null,
        entry.kind,
        entry.target.slice(0, 120),
        entry.action.slice(0, 200),
        entry.readOnly ? 1 : 0,
        Date.now(),
      );
    return id;
  }
  finishAction(id: string, outcome: 'succeeded' | 'failed') {
    this.db
      .prepare('UPDATE action_log SET outcome=? WHERE id=?')
      .run(outcome, id);
    this.db
      .prepare(
        `DELETE FROM action_log WHERE id NOT IN (SELECT id FROM action_log ORDER BY createdAt DESC, rowid DESC LIMIT ${MAX_AUDIT_ROWS})`,
      )
      .run();
  }
  /**
   * Every action taken outside OpenDots, newest first: approved MCP actions,
   * ungated MCP calls, Composio tools and computer actions.
   */
  audit(
    filter: { dotId?: string; changesOnly?: boolean; limit?: number } = {},
  ): AuditEntry[] {
    const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
    const rows = this.db
      .prepare(
        `SELECT id, at, dotId, threadId, kind, target, action, actor, approved, outcome FROM (
          SELECT 'mcp:' || a.threadId || ':' || a.toolCallId AS id, a.createdAt AS at, c.dotId AS dotId, a.threadId AS threadId, 'mcp' AS kind, COALESCE(c.name, 'Removed connection') AS target, a.tool AS action, 'agent' AS actor, 1 AS approved, 0 AS readOnly,
            CASE WHEN a.status<>'done' THEN 'pending' WHEN json_extract(a.result, '$.isError') THEN 'failed' ELSE 'succeeded' END AS outcome
          FROM mcp_actions a LEFT JOIN mcp_connections c ON c.id=a.connectionId
          UNION ALL
          SELECT 'log:' || id, createdAt, dotId, threadId, kind, target, action, 'agent', 0, readOnly, outcome FROM action_log
          UNION ALL
          SELECT 'computer:' || id, createdAt, dotId, NULL, 'computer', 'Computer', action, actor, 0, 0, outcome FROM computer_audit
        ) WHERE (? IS NULL OR dotId=?) AND (?=0 OR readOnly=0)
        ORDER BY at DESC LIMIT ${limit}`,
      )
      .all(
        filter.dotId ?? null,
        filter.dotId ?? null,
        filter.changesOnly ? 1 : 0,
      ) as unknown as (Omit<AuditEntry, 'approved'> & { approved: number })[];
    return rows.map((row) => ({ ...row, approved: !!row.approved }));
  }
}
