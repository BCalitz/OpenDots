import { randomUUID } from 'node:crypto';
import { sql, type Db } from './db/index.js';
import type {
  Connection,
  ConnectionActionResult,
  ConnectionTool,
} from '../shared/connection-types.js';
type Row = Omit<Connection, 'hasToken' | 'tools'> & {
  token: string | null;
  tools: string;
};
// MCP calls are bounded to 60 seconds. Keep a generous margin before treating
// a result-less claim as interrupted, so a slow but live call cannot be run twice.
export const INTERRUPTED_ACTION_THRESHOLD_MS = 5 * 60_000;
const CONNECTION = sql.raw(
  'id, dot_id, name, url, token, tools, error, created_at, updated_at',
);

export class ConnectionStore {
  constructor(private db: Db) {}
  private rows(dotId?: string) {
    return this.db.rows<Row>(
      sql`SELECT ${CONNECTION} FROM mcp_connections ${dotId ? sql`WHERE dot_id=${dotId}` : sql``} ORDER BY created_at, seq`,
    );
  }
  private row(id: string) {
    return this.db.row<Row>(
      sql`SELECT ${CONNECTION} FROM mcp_connections WHERE id=${id}`,
    );
  }
  private view({ token, tools, ...row }: Row): Connection {
    return { ...row, hasToken: !!token, tools: JSON.parse(tools) };
  }
  async list(dotId: string): Promise<Connection[]> {
    return (await this.rows(dotId)).map((row) => this.view(row));
  }
  async get(id: string): Promise<Connection | undefined> {
    const row = await this.row(id);
    return row && this.view(row);
  }
  // Secrets never leave the server: only the MCP transport reads them.
  async credentials(id: string) {
    const row = await this.row(id);
    if (!row) throw new Error('Connection not found.');
    return { url: row.url, token: row.token ?? undefined };
  }
  async create(
    dotId: string,
    value: { name: string; url: string; token?: string },
    tools: ConnectionTool[],
  ): Promise<Connection> {
    const id = randomUUID();
    const now = Date.now();
    await this.db.run(
      sql`INSERT INTO mcp_connections (id, dot_id, name, url, token, tools, error, created_at, updated_at) VALUES (${id}, ${dotId}, ${value.name}, ${value.url}, ${value.token || null}, ${JSON.stringify(tools)}, NULL, ${now}, ${now})`,
    );
    return (await this.get(id))!;
  }
  // updated_at only moves forward, so rapid edits always change the fingerprint.
  async saveTools(
    id: string,
    tools: ConnectionTool[],
    error: string | null = null,
  ) {
    await this.db.run(
      sql`UPDATE mcp_connections SET tools=${JSON.stringify(tools)}, error=${error}, updated_at=GREATEST(updated_at + 1, ${Date.now()}) WHERE id=${id}`,
    );
    return (await this.get(id))!;
  }
  async setError(id: string, error: string) {
    await this.db.run(
      sql`UPDATE mcp_connections SET error=${error}, updated_at=GREATEST(updated_at + 1, ${Date.now()}) WHERE id=${id}`,
    );
    return (await this.get(id))!;
  }
  async remove(id: string) {
    return (
      (await this.db.run(sql`DELETE FROM mcp_connections WHERE id=${id}`)) > 0
    );
  }
  // Running turns compare this to stop as soon as the owner changes access.
  async fingerprint(dotId: string) {
    return (await this.rows(dotId))
      .map((row) => `${row.id}:${row.updatedAt}`)
      .join(',');
  }
  // Binds a gated call to its exact connection, tool, and arguments, so a
  // later approval runs that call and nothing else.
  async createApproval(value: {
    threadId: string;
    dotId: string;
    connectionId: string;
    tool: string;
    arguments: Record<string, unknown>;
  }) {
    const id = randomUUID();
    await this.db.run(
      sql`INSERT INTO mcp_approvals VALUES (${id}, ${value.threadId}, ${value.dotId}, ${value.connectionId}, ${value.tool}, ${JSON.stringify(value.arguments)}, ${Date.now()})`,
    );
    return id;
  }
  async approval(id: string) {
    const row = await this.db.row<{
      id: string;
      threadId: string;
      dotId: string;
      connectionId: string;
      tool: string;
      arguments: string;
      createdAt: number;
    }>(sql`SELECT * FROM mcp_approvals WHERE id=${id}`);
    if (!row) return undefined;
    return {
      id: row.id,
      threadId: row.threadId,
      dotId: row.dotId,
      connectionId: row.connectionId,
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
      sql`SELECT status, result, approval_id, created_at, claimed_at FROM mcp_actions WHERE thread_id=${threadId} AND tool_call_id=${toolCallId}`,
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
      sql`SELECT thread_id, tool_call_id FROM mcp_actions WHERE approval_id=${approvalId}`,
    );
  }
  // Claim an approved action once. Returns false if it was already claimed,
  // so a double click or a retried request never executes twice.
  async claimAction(
    threadId: string,
    toolCallId: string,
    approvalId: string,
    connectionId: string,
    tool: string,
  ) {
    const now = Date.now();
    return (
      (await this.db.run(
        sql`INSERT INTO mcp_actions (thread_id, tool_call_id, connection_id, tool, status, result, created_at, claimed_at, approval_id) VALUES (${threadId}, ${toolCallId}, ${connectionId}, ${tool}, 'running', NULL, ${now}, ${now}, ${approvalId}) ON CONFLICT DO NOTHING`,
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
        sql`UPDATE mcp_actions SET claimed_at=${now} WHERE thread_id=${threadId} AND tool_call_id=${toolCallId} AND approval_id=${approvalId} AND status='running' AND result IS NULL AND COALESCE(claimed_at, created_at)<=${now - INTERRUPTED_ACTION_THRESHOLD_MS}`,
      )) > 0
    );
  }
  async finishAction(
    threadId: string,
    toolCallId: string,
    result: ConnectionActionResult,
  ) {
    await this.db.run(
      sql`UPDATE mcp_actions SET status='done', result=${JSON.stringify(result)} WHERE thread_id=${threadId} AND tool_call_id=${toolCallId}`,
    );
  }
}
