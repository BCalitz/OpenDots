import {
  ALLOW_CONFIRMATION,
  isRiskyTool,
  type ConnectorTool,
  type ToolPolicy,
} from '../shared/connection-types';

export const POLICIES: { value: ToolPolicy; label: string }[] = [
  { value: 'allow', label: 'Allow' },
  { value: 'ask', label: 'Ask first' },
  { value: 'block', label: 'Block' },
];

/**
 * The request body for changing a tool's policy. Letting a tool that can send,
 * pay or delete run unasked needs the owner to type a word; undefined means
 * they backed out and nothing should change.
 */
export function policyChange(
  tool: ConnectorTool,
  policy: ToolPolicy,
): { policy: ToolPolicy; confirm?: string } | undefined {
  if (policy !== 'allow' || !isRiskyTool(tool)) return { policy };
  const typed = window.prompt(
    `“${tool.title}” can send, pay or delete. It will run without asking you. Type “${ALLOW_CONFIRMATION}” to confirm.`,
  );
  if (typed === null) return;
  return { policy, confirm: typed };
}
