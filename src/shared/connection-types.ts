/**
 * What a user decides for one tool a Dot may use:
 * - allow: runs on its own.
 * - ask: the user approves each call first.
 * - block: the Dot cannot use it.
 */
export type ToolPolicy = 'allow' | 'ask' | 'block';

/**
 * Tools that send, pay, delete or otherwise cannot be taken back. Letting one
 * run without asking needs a typed confirmation, in the app and on the server.
 */
const RISKY =
  /send|reply|forward|delete|remove|trash|purge|pay|transfer|purchase|buy|charge|refund|cancel|decline|invite|post|publish/i;
export const isRiskyTool = (tool: {
  name: string;
  title: string;
  readOnly: boolean;
}) => !tool.readOnly && (RISKY.test(tool.name) || RISKY.test(tool.title));
/** The word the owner types to let a risky tool run without asking. */
export const ALLOW_CONFIRMATION = 'allow';

/** One thing a connected service offers, as the service describes it. */
export interface ConnectorTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // The service's readOnlyHint. A hint only: approval is the user's call.
  readOnly: boolean;
}

/**
 * One login to one outside service, belonging to one user. It says what the
 * service offers, never who may use it: that is a Grant.
 */
export interface Account {
  id: string;
  userId: string;
  /** Which connector talks to the service, such as "mcp". */
  connector: string;
  name: string;
  /** Where it points, for display, such as a host. Never a secret. */
  detail: string;
  hasSecret: boolean;
  tools: ConnectorTool[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GrantedTool extends ConnectorTool {
  policy: ToolPolicy;
}

/** Lets one Dot use one Account, with a policy for each of its tools. */
export interface Grant {
  id: string;
  accountId: string;
  dotId: string;
  tools: GrantedTool[];
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionActionResult {
  isError: boolean;
  text: string;
}
/**
 * The tool threads used to ask for approval before approvals moved to the
 * server. Kept so those threads still show their approval cards.
 */
export const legacyConnectionActionTool = 'request_connection_action';
