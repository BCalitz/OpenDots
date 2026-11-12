import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import type { ConnectionActionResult } from '../../shared/connection-types.js';

// Connector calls are bounded to 60 seconds. Keep a generous margin before treating
// a result-less claim as interrupted, so a slow but live call cannot be run twice.
export const INTERRUPTED_ACTION_THRESHOLD_MS = 5 * 60_000;

/**
 * The record of what the user approved and what then ran. An approval binds a
 * gated call to its exact account, tool and arguments; a claim makes sure an
 * approved call runs once, however many times its decision arrives.
 */
export class ActionStore {
  constructor(private db: Db) {}
  // Binds a gated call to its exact account, tool, and arguments, so a
  // later approval runs that call and nothing else.
  async createApproval(value: {
    threadId: string;
    dotId: string;
    accountId: string;
    tool: string;
    arguments: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await this.db.run(
      sql`INSERT INTO connector_approvals (id, thread_id, dot_id, account_id, tool, arguments, created_at) VALUES (${id}, ${value.threadId}, ${value.dotId}, ${value.accountId}, ${value.tool}, ${JSON.stringify(value.arguments)}, ${Date.now()})`,
    );
    return id;
  }
  async approval(id: string) {
    const row = await this.db.row<{
      id: string;
      threadId: string;
      dotId: string;
      accountId: string;
      tool: string;
      arguments: string;
      createdAt: number;
    }>(sql`SELECT * FROM connector_approvals WHERE id=${id}`);
    if (!row) return undefined;
    return {
      id: row.id,
      threadId: row.threadId,
      dotId: row.dotId,
      accountId: row.accountId,
      tool: row.tool,
      arguments: JSON.parse(row.arguments) as Record<string, unknown>,
      createdAt: row.createdAt,
    };
  }
  async action(threadId: string, toolCallId: string) {
    const row = await this.db.row<{
      status: 'running' | 'done';
      result: string | null;
      approvalId: string | null;
      createdAt: number;
      claimedAt: number | null;
    }>(
      sql`SELECT status, result, approval_id, created_at, claimed_at FROM connector_actions WHERE thread_id=${threadId} AND tool_call_id=${toolCallId}`,
    );
    if (!row) return undefined;
    const claimedAt = row.claimedAt ?? row.createdAt;
    return {
      approvalId: row.approvalId,
      status:
        row.status === 'running' &&
        row.result === null &&
        Date.now() - claimedAt >= INTERRUPTED_ACTION_THRESHOLD_MS
          ? ('interrupted' as const)
          : row.status,
      result:
        typeof row.result === 'string'
          ? (JSON.parse(row.result) as ConnectionActionResult)
          : null,
    };
  }
  // Looks up what an approval was already claimed for, so one approval can
  // never run its stored request twice under different tool call ids.
  actionForApproval(approvalId: string) {
    return this.db.row<{ threadId: string; toolCallId: string }>(
      sql`SELECT thread_id, tool_call_id FROM connector_actions WHERE approval_id=${approvalId}`,
    );
  }
  // Claim an approved action once. Returns false if it was already claimed,
  // so a double click or a retried request never executes twice.
  async claimAction(value: {
    threadId: string;
    toolCallId: string;
    approvalId: string;
    accountId: string;
    dotId: string;
    tool: string;
  }) {
    const now = Date.now();
    return (
      (await this.db.run(
        sql`INSERT INTO connector_actions (thread_id, tool_call_id, account_id, dot_id, tool, status, result, created_at, claimed_at, approval_id) VALUES (${value.threadId}, ${value.toolCallId}, ${value.accountId}, ${value.dotId}, ${value.tool}, 'running', NULL, ${now}, ${now}, ${value.approvalId}) ON CONFLICT DO NOTHING`,
      )) > 0
    );
  }
  // Reclaim only this approval's stale, result-less claim. The conditional
  // update makes concurrent retries race safely: only one can refresh claimedAt.
  async reclaimInterruptedAction(
    threadId: string,
    toolCallId: string,
    approvalId: string,
  ) {
    const now = Date.now();
    return (
      (await this.db.run(
        sql`UPDATE connector_actions SET claimed_at=${now} WHERE thread_id=${threadId} AND tool_call_id=${toolCallId} AND approval_id=${approvalId} AND status='running' AND result IS NULL AND COALESCE(claimed_at, created_at)<=${now - INTERRUPTED_ACTION_THRESHOLD_MS}`,
      )) > 0
    );
  }
  async finishAction(
    threadId: string,
    toolCallId: string,
    result: ConnectionActionResult,
  ) {
    await this.db.run(
      sql`UPDATE connector_actions SET status='done', result=${JSON.stringify(result)} WHERE thread_id=${threadId} AND tool_call_id=${toolCallId}`,
    );
  }
}
