import { randomUUID } from 'node:crypto';
import { sql, type Db } from '../db/index.js';
import { Sealer } from './secrets.js';
import type {
  Account,
  ConnectorTool,
  Grant,
  ToolPolicy,
} from '../../shared/connection-types.js';

/** An account as stored: the connector's config instead of a display line. */
export type AccountRecord = Omit<Account, 'detail'> & {
  config: Record<string, unknown>;
};
/** A Dot's grant, with the account it opens. */
export interface Access {
  account: AccountRecord;
  grant: Grant;
}
interface AccountRow extends Omit<
  AccountRecord,
  'hasSecret' | 'config' | 'tools'
> {
  config: string;
  secret: string | null;
  tools: string;
}
const ACCOUNT = sql.raw(
  'a.id, a.user_id, a.connector, a.name, a.config, a.secret, a.tools, a.error, a.created_at, a.updated_at',
);
const view = ({
  secret,
  config,
  tools,
  ...row
}: AccountRow): AccountRecord => ({
  ...row,
  hasSecret: !!secret,
  config: JSON.parse(config),
  tools: JSON.parse(tools),
});
/**
 * What a tool starts as: the service's own hint decides, and only a tool it
 * calls read-only runs without asking. The choice is stored, so a service
 * cannot later lift the approval on a tool by changing its hint.
 */
const defaultPolicy = (tool: ConnectorTool): ToolPolicy =>
  tool.readOnly ? 'allow' : 'ask';

/**
 * Accounts and the grants that let Dots use them. Every method that reads or
 * changes a user's data takes that user's id, so scoping to a user is the
 * store's job and not something callers remember to filter.
 */
export class AccountStore {
  constructor(
    private db: Db,
    private sealer = new Sealer(),
  ) {}
  /** Encrypts secrets saved before a key was set. Safe to run on every start. */
  async sealStored() {
    if (!this.sealer.enabled) return;
    for (const row of await this.db.rows<{ id: string; secret: string }>(
      sql`SELECT id, secret FROM accounts WHERE secret IS NOT NULL AND secret NOT LIKE 'enc:v1:%'`,
    ))
      await this.db.run(
        sql`UPDATE accounts SET secret=${this.sealer.seal(row.secret)} WHERE id=${row.id}`,
      );
  }
  async list(userId: string): Promise<AccountRecord[]> {
    return (
      await this.db.rows<AccountRow>(
        sql`SELECT ${ACCOUNT} FROM accounts a WHERE a.user_id=${userId} ORDER BY a.created_at, a.seq`,
      )
    ).map(view);
  }
  async get(userId: string, id: string): Promise<AccountRecord | undefined> {
    const row = await this.db.row<AccountRow>(
      sql`SELECT ${ACCOUNT} FROM accounts a WHERE a.id=${id} AND a.user_id=${userId}`,
    );
    return row && view(row);
  }
  /**
   * What a connector needs to reach an account. Secrets never leave the
   * server: only connector code reads them. The caller has already shown the
   * account is theirs, either as its user or through a Dot's grant.
   */
  async target(id: string) {
    const row = await this.db.row<AccountRow>(
      sql`SELECT ${ACCOUNT} FROM accounts a WHERE a.id=${id}`,
    );
    if (!row) throw new Error('Account not found.');
    return {
      connector: row.connector,
      config: JSON.parse(row.config) as Record<string, unknown>,
      secret: row.secret ? this.sealer.open(row.secret) : undefined,
    };
  }
  async create(
    userId: string,
    value: {
      connector: string;
      name: string;
      config: Record<string, unknown>;
      secret?: string;
    },
    tools: ConnectorTool[],
  ): Promise<AccountRecord> {
    const id = randomUUID();
    const now = Date.now();
    await this.db.run(
      sql`INSERT INTO accounts (id, user_id, connector, name, config, secret, tools, error, created_at, updated_at) VALUES (${id}, ${userId}, ${value.connector}, ${value.name}, ${JSON.stringify(value.config)}, ${value.secret ? this.sealer.seal(value.secret) : null}, ${JSON.stringify(tools)}, NULL, ${now}, ${now})`,
    );
    return (await this.get(userId, id))!;
  }
  /**
   * Replaces what an account offers. Tools that are new get the default
   * policy on every grant; policies the user already chose are untouched, so
   * refreshing can never undo a decision.
   */
  async saveCatalog(userId: string, id: string, tools: ConnectorTool[]) {
    await this.db.transaction(async () => {
      if (!(await this.get(userId, id))) throw new Error('Account not found.');
      await this.db.run(
        sql`UPDATE accounts SET tools=${JSON.stringify(tools)}, error=NULL, updated_at=GREATEST(updated_at + 1, ${Date.now()}) WHERE id=${id}`,
      );
      for (const tool of tools)
        await this.db.run(
          sql`INSERT INTO grant_policies (grant_id, tool, policy) SELECT g.id, ${tool.name}, ${defaultPolicy(tool)} FROM grants g WHERE g.account_id=${id} ON CONFLICT DO NOTHING`,
        );
    });
    return (await this.get(userId, id))!;
  }
  // updated_at only moves forward, so rapid edits always change the fingerprint.
  async setError(userId: string, id: string, error: string) {
    await this.db.run(
      sql`UPDATE accounts SET error=${error}, updated_at=GREATEST(updated_at + 1, ${Date.now()}) WHERE id=${id} AND user_id=${userId}`,
    );
    const account = await this.get(userId, id);
    if (!account) throw new Error('Account not found.');
    return account;
  }
  async remove(userId: string, id: string) {
    return (
      (await this.db.run(
        sql`DELETE FROM accounts WHERE id=${id} AND user_id=${userId}`,
      )) > 0
    );
  }

  /** Builds grants from their rows, with each tool's policy filled in. */
  private async grants(
    rows: (AccountRow & {
      grantId: string;
      dotId: string;
      grantCreatedAt: number;
      grantUpdatedAt: number;
    })[],
  ): Promise<Access[]> {
    const policies = new Map<string, ToolPolicy>();
    if (rows.length)
      for (const row of await this.db.rows<{
        grantId: string;
        tool: string;
        policy: ToolPolicy;
      }>(
        sql`SELECT grant_id, tool, policy FROM grant_policies WHERE grant_id = ANY(${rows.map((row) => row.grantId)})`,
      ))
        policies.set(`${row.grantId}\u0000${row.tool}`, row.policy);
    return rows.map((row) => {
      const account = view(row);
      return {
        account,
        grant: {
          id: row.grantId,
          accountId: account.id,
          dotId: row.dotId,
          createdAt: row.grantCreatedAt,
          updatedAt: row.grantUpdatedAt,
          tools: account.tools.map((tool) => ({
            ...tool,
            // A tool with no stored choice asks: the safe default.
            policy: policies.get(`${row.grantId}\u0000${tool.name}`) ?? 'ask',
          })),
        },
      };
    });
  }
  private select(where: ReturnType<typeof sql>) {
    return this.db.rows<
      AccountRow & {
        grantId: string;
        dotId: string;
        grantCreatedAt: number;
        grantUpdatedAt: number;
      }
    >(
      sql`SELECT ${ACCOUNT}, g.id AS grant_id, g.dot_id, g.created_at AS grant_created_at, g.updated_at AS grant_updated_at
        FROM grants g JOIN accounts a ON a.id=g.account_id WHERE ${where} ORDER BY g.created_at, g.seq`,
    );
  }
  /** Every account a Dot may use, with its grant. */
  async access(dotId: string): Promise<Access[]> {
    return this.grants(await this.select(sql`g.dot_id=${dotId}`));
  }
  /** Lets a Dot use one of the user's accounts. Granting twice changes nothing. */
  async grant(userId: string, dotId: string, accountId: string) {
    await this.db.transaction(async () => {
      const account = await this.get(userId, accountId);
      if (!account) throw new Error('Account not found.');
      const now = Date.now();
      const id = randomUUID();
      const created = await this.db.run(
        sql`INSERT INTO grants (id, account_id, dot_id, created_at, updated_at) VALUES (${id}, ${accountId}, ${dotId}, ${now}, ${now}) ON CONFLICT (account_id, dot_id) DO NOTHING`,
      );
      if (!created) return;
      for (const tool of account.tools)
        await this.db.run(
          sql`INSERT INTO grant_policies (grant_id, tool, policy) VALUES (${id}, ${tool.name}, ${defaultPolicy(tool)})`,
        );
    });
    return (await this.access(dotId)).find(
      (item) => item.account.id === accountId,
    )!.grant;
  }
  /** Takes an account away from a Dot. Its policies go with the grant. */
  async revoke(userId: string, dotId: string, accountId: string) {
    return (
      (await this.db.run(
        sql`DELETE FROM grants g USING accounts a WHERE a.id=g.account_id AND g.account_id=${accountId} AND g.dot_id=${dotId} AND a.user_id=${userId}`,
      )) > 0
    );
  }
  async setPolicy(
    userId: string,
    dotId: string,
    accountId: string,
    tool: string,
    policy: ToolPolicy,
  ) {
    await this.db.transaction(async () => {
      const account = await this.get(userId, accountId);
      if (!account) throw new Error('Account not found.');
      if (!account.tools.some((item) => item.name === tool))
        throw new Error('Connection tool not found.');
      const grant = await this.db.row<{ id: string }>(
        sql`SELECT id FROM grants WHERE account_id=${accountId} AND dot_id=${dotId}`,
      );
      if (!grant) throw new Error('This Dot does not use that account.');
      await this.db.run(
        sql`INSERT INTO grant_policies (grant_id, tool, policy) VALUES (${grant.id}, ${tool}, ${policy}) ON CONFLICT (grant_id, tool) DO UPDATE SET policy=EXCLUDED.policy`,
      );
      await this.db.run(
        sql`UPDATE grants SET updated_at=GREATEST(updated_at + 1, ${Date.now()}) WHERE id=${grant.id}`,
      );
    });
    return (await this.access(dotId)).find(
      (item) => item.account.id === accountId,
    )!.grant;
  }
  /**
   * Changes whenever what a Dot may do through its accounts changes: a grant
   * added or taken away, a policy edited, or an account refreshed. Running
   * turns compare it to stop as soon as the user changes access.
   */
  async fingerprint(dotId: string) {
    return (
      await this.db.rows<{ id: string; grantAt: number; accountAt: number }>(
        sql`SELECT g.id, g.updated_at AS grant_at, a.updated_at AS account_at FROM grants g JOIN accounts a ON a.id=g.account_id WHERE g.dot_id=${dotId} ORDER BY g.created_at, g.seq`,
      )
    )
      .map((row) => `${row.id}:${row.grantAt}:${row.accountAt}`)
      .join(',');
  }
}
