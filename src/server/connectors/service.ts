import type {
  Account,
  ConnectionActionResult,
  Grant,
  GrantedTool,
  ToolPolicy,
} from '../../shared/connection-types.js';
import type { AccountRecord, AccountStore, Access } from './accounts.js';
import type { ActionStore } from './actions.js';
import type { Connector } from './connector.js';
import { McpConnector } from './mcp.js';
import { isOAuth, type OAuthConnector } from './oauth.js';

// Model-facing names must match ^[a-zA-Z0-9_-]{1,64}$ and stay unique across
// every account a Dot has, so they are derived here, deterministically.
const slug = (value: string, max: number) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max) || 'tool';

export interface ExposedTool {
  name: string;
  account: AccountRecord;
  grant: Grant;
  tool: GrantedTool;
}
// Names are assigned over every tool, blocked or not, so blocking one tool
// never moves its name to another. Approvals do not rely on names: they
// bind to a stored account, tool, and arguments.
export function exposedTools(access: Access[]): ExposedTool[] {
  const used = new Set<string>();
  return access
    .flatMap(({ account, grant }) =>
      grant.tools.map((tool) => {
        const base = `${slug(account.name, 20)}__${slug(tool.name, 40)}`;
        let name = base;
        for (let n = 2; used.has(name); n++) name = `${base.slice(0, 60)}_${n}`;
        used.add(name);
        return { name, account, grant, tool };
      }),
    )
    .filter(({ tool }) => tool.policy !== 'block');
}

/**
 * Accounts, grants and calls, whatever kind of service is behind them. The
 * connector for an account's service does the talking; everything else here
 * is the same for all of them.
 */
export class ConnectorService {
  private connectors: Map<string, Connector>;
  constructor(
    readonly accounts: AccountStore,
    readonly actions: ActionStore,
    connectors: Connector[] = [new McpConnector()],
  ) {
    this.connectors = new Map(connectors.map((item) => [item.kind, item]));
  }
  private connector(kind: string) {
    const found = this.connectors.get(kind);
    if (!found) throw new Error('This kind of account is not supported.');
    return found;
  }
  /** What the API and the interface may see of an account. */
  view(record: AccountRecord): Account {
    const { config, ...account } = record;
    let detail = '';
    try {
      detail = this.connector(record.connector).describe(config);
    } catch {
      // An account of a kind this build no longer has still lists, and can be removed.
    }
    return { ...account, detail };
  }
  async list(userId: string) {
    return (await this.accounts.list(userId)).map((item) => this.view(item));
  }
  async add(userId: string, kind: string, input: unknown) {
    const connector = this.connector(kind);
    return this.addVerified(userId, kind, connector.parse(input));
  }
  /** Saves an account whose details are already checked, after listing what it offers. */
  async addVerified(
    userId: string,
    kind: string,
    value: { name: string; config: Record<string, unknown>; secret?: string },
  ) {
    const tools = await this.connector(kind).discover({
      config: value.config,
      secret: value.secret,
    });
    return this.view(
      await this.accounts.create(userId, { connector: kind, ...value }, tools),
    );
  }
  oauthConnectors(): OAuthConnector[] {
    return [...this.connectors.values()].filter(isOAuth);
  }
  oauthConnector(kind: string) {
    const found = this.connectors.get(kind);
    if (!found || !isOAuth(found))
      throw new Error('This kind of account does not use sign-in.');
    return found;
  }
  async refresh(userId: string, id: string) {
    const account = await this.accounts.get(userId, id);
    if (!account) throw new Error('Account not found.');
    try {
      const tools = await this.connector(account.connector).discover(
        await this.accounts.target(id),
      );
      return this.view(await this.accounts.saveCatalog(userId, id, tools));
    } catch (error) {
      return this.view(
        await this.accounts.setError(
          userId,
          id,
          error instanceof Error && error.message
            ? error.message
            : 'Could not reach the connected service.',
        ),
      );
    }
  }
  remove(userId: string, id: string) {
    return this.accounts.remove(userId, id);
  }

  /** The accounts a Dot may use, with what it may do with each tool. */
  async grants(dotId: string) {
    return (await this.accounts.access(dotId)).map(({ grant }) => grant);
  }
  grant(userId: string, dotId: string, accountId: string) {
    return this.accounts.grant(userId, dotId, accountId);
  }
  revoke(userId: string, dotId: string, accountId: string) {
    return this.accounts.revoke(userId, dotId, accountId);
  }
  setPolicy(
    userId: string,
    dotId: string,
    accountId: string,
    tool: string,
    policy: ToolPolicy,
  ) {
    return this.accounts.setPolicy(userId, dotId, accountId, tool, policy);
  }

  async tools(dotId: string) {
    return exposedTools(await this.accounts.access(dotId));
  }
  async resolve(dotId: string, name: string) {
    const match = (await this.tools(dotId)).find((tool) => tool.name === name);
    if (!match)
      throw new Error('Connection tool is not available to this Dot.');
    return match;
  }
  // The tool an approval was created for, by account and real tool name,
  // if the Dot still has it enabled.
  async bound(dotId: string, accountId: string, toolName: string) {
    const match = (await this.tools(dotId)).find(
      (item) => item.account.id === accountId && item.tool.name === toolName,
    );
    if (!match)
      throw new Error(
        'This tool is no longer enabled for this Dot. Nothing was run.',
      );
    return match;
  }
  async call(
    exposed: ExposedTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectionActionResult> {
    try {
      const target = await this.accounts.target(exposed.account.id);
      return await this.connector(target.connector).call(
        target,
        exposed.tool.name,
        args,
        signal,
      );
    } catch (error) {
      return {
        isError: true,
        text:
          error instanceof Error && error.message
            ? error.message
            : 'Could not reach the connected service.',
      };
    }
  }
}
