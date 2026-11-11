export interface ConnectionTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  // The server's readOnlyHint. A hint only: approval is the owner's call.
  readOnly: boolean;
  enabled: boolean;
  requiresApproval: boolean;
}
export interface Connection {
  id: string;
  dotId: string;
  name: string;
  url: string;
  hasToken: boolean;
  tools: ConnectionTool[];
  error: string | null;
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
