import { randomUUID } from 'node:crypto';
import { sql, type Db } from './db/index.js';
import type {
  ComputerAudit,
  ComputerPermissions,
} from '../shared/computer-types.js';
export class ComputerStore {
  constructor(private db: Db) {}
  async permissions(id: string): Promise<ComputerPermissions> {
    const row = await this.db.row<{ value: string }>(
      sql`SELECT value FROM computer_permissions WHERE dot_id=${id}`,
    );
    return row
      ? JSON.parse(row.value)
      : { enabled: false, browser: false, files: false, shell: false };
  }
  patch(id: string, patch: Partial<ComputerPermissions>) {
    return this.db.transaction(async () => {
      const value = { ...(await this.permissions(id)), ...patch };
      await this.db.run(
        sql`INSERT INTO computer_permissions VALUES (${id}, ${JSON.stringify(value)}) ON CONFLICT (dot_id) DO UPDATE SET value=excluded.value`,
      );
      return value;
    });
  }
  async begin(dotId: string, action: string, actor: 'owner' | 'agent') {
    const id = randomUUID();
    await this.db.run(
      sql`INSERT INTO computer_audit (id, dot_id, action, actor, outcome, created_at) VALUES (${id}, ${dotId}, ${action}, ${actor}, 'pending', ${Date.now()})`,
    );
    return id;
  }
  async finish(id: string, outcome: 'succeeded' | 'failed') {
    await this.db.transaction(async () => {
      const row = await this.db.row<{ dotId: string }>(
        sql`UPDATE computer_audit SET outcome=${outcome} WHERE id=${id} RETURNING dot_id`,
      );
      if (!row) return;
      // Keep the latest 1,000 finished actions per Dot.
      await this.db.run(
        sql`DELETE FROM computer_audit WHERE dot_id=${row.dotId} AND outcome<>'pending' AND id NOT IN (SELECT id FROM computer_audit WHERE dot_id=${row.dotId} AND outcome<>'pending' ORDER BY created_at DESC, seq DESC LIMIT 1000)`,
      );
    });
  }
  audit(id: string): Promise<ComputerAudit[]> {
    return this.db.rows<ComputerAudit>(
      sql`SELECT id, action, actor, outcome, created_at FROM computer_audit WHERE dot_id=${id} ORDER BY created_at DESC, seq DESC LIMIT 50`,
    );
  }
}
