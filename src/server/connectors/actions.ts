import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';

/**
 * The record of what the user approved. An approval binds a gated call to its
 * exact account, tool and arguments; ToolCalls makes sure it then runs once.
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
}
