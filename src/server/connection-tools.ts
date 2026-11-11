import type { JSONSchema } from '@tanstack/ai';
import type { Tool } from './engine/tools.js';
import { connectionActionTool } from '../shared/connection-types.js';
import type { ConnectionService } from './connections.js';
import type { UsageStore } from './usage-store.js';
// Connected MCP tools for one Dot. Tools that need approval never execute
// here: the model is told to request owner approval, and only the owner's
// approval route runs them.
export function connectionTools(
  connections: ConnectionService,
  dotId: string,
  threadId: string,
  check: () => void,
  signal: AbortSignal,
  approvals: boolean,
  log?: UsageStore,
) {
  return connections.tools(dotId).map((exposed): Tool => ({
    name: exposed.name,
    description:
      `[${exposed.connection.name}${exposed.tool.requiresApproval ? ', needs owner approval' : ''}] ${exposed.tool.title}: ${exposed.tool.description}`.slice(
        0,
        1024,
      ),
    parameters: exposed.tool.inputSchema as JSONSchema,
    execute: async (args: unknown) => {
      check();
      // Re-resolve so a tool the owner just disabled or gated is honored.
      const current = connections.resolve(dotId, exposed.name);
      const input = (args ?? {}) as Record<string, unknown>;
      if (current.tool.requiresApproval)
        return approvals
          ? {
              status: 'approval_required',
              approvalId: connections.store.createApproval({
                threadId,
                dotId,
                connectionId: current.connection.id,
                tool: current.tool.name,
                arguments: input,
              }),
              instruction: `Call ${connectionActionTool.name} with this approvalId and a one-sentence summary of what it will do. Then wait for the owner.`,
            }
          : {
              status: 'unavailable',
              message:
                'This action needs owner approval in the OpenDots web app. Ask the owner to continue there.',
            };
      // Approved actions keep their own receipts; ungated calls are logged here.
      const entry = log?.beginAction({
        dotId,
        threadId,
        kind: 'mcp',
        target: current.connection.name,
        action: current.tool.name,
        readOnly: current.tool.readOnly,
      });
      const result = await connections.call(current, input, signal);
      if (entry)
        log!.finishAction(entry, result.isError ? 'failed' : 'succeeded');
      check();
      return result;
    },
  }));
}
