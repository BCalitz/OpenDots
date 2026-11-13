import { sql, type Db } from '../db/index.js';

/** What a once-only tool call does. */
type ToolCallKind = 'connector' | 'page_review' | 'approval';

// Connector calls are bounded to 60 seconds. Keep a generous margin before treating
// a result-less claim as interrupted, so a slow but live call cannot be run twice.
export const INTERRUPTED_ACTION_THRESHOLD_MS = 5 * 60_000;

export interface ToolCallKey {
  threadId: string;
  toolCallId: string;
  kind: ToolCallKind;
  /** The tool's name, for receipts. */
  tool: string;
  /** Who ran it and against what, for receipts. */
  dotId?: string;
  accountId?: string;
  /** The approval that bound this call's exact request. */
  approvalId?: string;
}

/** What `once` found: the work ran now, or an earlier run's record. */
export type Once<T> =
  | { ran: true; result: T }
  | { ran: false; status: 'done'; result: T }
  | { ran: false; status: 'running' | 'interrupted'; result: null };

/**
 * One "run it exactly once" for every tool that must not repeat: a gated
 * connector call, saving a reviewed page, asking the owner. The first call
 * for a thread and tool call id claims it; a repeat gets the first call's
 * result, or learns that it is still running, and never runs the work again.
 */
export class ToolCalls {
  constructor(private db: Db) {}

  /**
   * Runs `work` at most once for this tool call.
   *
   * `atomic`: the claim, the work and its result commit together, so a
   * failure leaves nothing behind. Only for work inside this database.
   *
   * Otherwise the claim is written first and the result after. If the work
   * throws, `release` frees the claim so the call may be tried again (for
   * work with no outside effect); without it the claim stays, because an
   * outside call may have happened before it failed.
   */
  async once<T>(
    key: ToolCallKey,
    work: () => Promise<T>,
    options: { atomic?: boolean; release?: boolean } = {},
  ): Promise<Once<T>> {
    const attempt = async (): Promise<Once<T>> => {
      if (!(await this.claim(key))) return this.earlier<T>(key);
      let result: T;
      try {
        result = await work();
      } catch (error) {
        if (options.release && !options.atomic) await this.release(key);
        throw error;
      }
      await this.db.run(
        sql`UPDATE tool_calls SET status='done', result=${JSON.stringify(result ?? null)} WHERE thread_id=${key.threadId} AND tool_call_id=${key.toolCallId}`,
      );
      return { ran: true, result };
    };
    return options.atomic ? this.db.transaction(attempt) : attempt();
  }

  /** The record of a tool call, if it was claimed. */
  async get<T>(threadId: string, toolCallId: string) {
    const row = await this.db.row<{
      kind: ToolCallKind;
      status: 'running' | 'done';
      result: string | null;
      approvalId: string | null;
      createdAt: number;
      claimedAt: number | null;
    }>(
      sql`SELECT kind, status, result, approval_id, created_at, claimed_at FROM tool_calls WHERE thread_id=${threadId} AND tool_call_id=${toolCallId}`,
    );
    if (!row) return undefined;
    const claimedAt = row.claimedAt ?? row.createdAt;
    return {
      kind: row.kind,
      approvalId: row.approvalId,
      status:
        row.status === 'running' &&
        row.result === null &&
        Date.now() - claimedAt >= INTERRUPTED_ACTION_THRESHOLD_MS
          ? ('interrupted' as const)
          : row.status,
      result:
        typeof row.result === 'string' ? (JSON.parse(row.result) as T) : null,
    };
  }

  private async claim(key: ToolCallKey) {
    const now = Date.now();
    return (
      (await this.db.run(
        sql`INSERT INTO tool_calls (thread_id, tool_call_id, kind, tool, dot_id, account_id, approval_id, status, result, created_at, claimed_at) VALUES (${key.threadId}, ${key.toolCallId}, ${key.kind}, ${key.tool}, ${key.dotId ?? null}, ${key.accountId ?? null}, ${key.approvalId ?? null}, 'running', NULL, ${now}, ${now}) ON CONFLICT DO NOTHING`,
      )) > 0
    );
  }

  private async earlier<T>(key: ToolCallKey): Promise<Once<T>> {
    const found = await this.get<T>(key.threadId, key.toolCallId);
    if (found?.status === 'done' && found.result !== null)
      return { ran: false, status: 'done', result: found.result };
    return {
      ran: false,
      status: found?.status === 'interrupted' ? 'interrupted' : 'running',
      result: null,
    };
  }

  private async release(key: ToolCallKey) {
    await this.db.run(
      sql`DELETE FROM tool_calls WHERE thread_id=${key.threadId} AND tool_call_id=${key.toolCallId} AND status='running'`,
    );
  }
}
