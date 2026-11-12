import type {
  ConnectionActionResult,
  ConnectorTool,
} from '../../shared/connection-types.js';

/** What a connector needs to reach one account: stored config and its secret. */
export interface ConnectorTarget {
  config: Record<string, unknown>;
  secret?: string;
}

/** A new account as entered by the user, split into what is safe to show and what is not. */
interface NewAccount {
  name: string;
  config: Record<string, unknown>;
  secret?: string;
}

/**
 * The code that talks to one kind of service. Everything above this
 * interface (accounts, grants, approvals, discovery) is the same whether the
 * connector runs in this process or reaches a remote MCP server, so adding a
 * service means adding one Connector and nothing else.
 */
export interface Connector {
  /** Stored on each account; never changes once accounts exist. */
  readonly kind: string;
  /** Checks what the user entered and splits it into config and secret. Throws a readable error. */
  parse(input: unknown): NewAccount;
  /** Where an account points, for display. Never includes the secret. */
  describe(config: Record<string, unknown>): string;
  /** Lists what the service offers. Throws a readable error when it cannot be reached. */
  discover(
    target: ConnectorTarget,
    signal?: AbortSignal,
  ): Promise<ConnectorTool[]>;
  /** Runs one tool. Failures are returned as results, not thrown. */
  call(
    target: ConnectorTarget,
    tool: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ConnectionActionResult>;
}
