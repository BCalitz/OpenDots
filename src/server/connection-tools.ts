import type { JSONSchema } from '@tanstack/ai';
import type { Tool, ToolContext } from './engine/tools.js';
import type { ApprovalKind, ApprovalStatus } from '../shared/approvals.js';
import type { ConnectionService } from './connections.js';
import type { UsageStore } from './usage-store.js';

/** Asks the owner to approve something and waits for the answer. */
export type Approve = (
  context: ToolContext,
  request: { kind: ApprovalKind; payload: unknown },
) => Promise<ApprovalStatus>;

/** What a gated tool tells the model when the owner did not approve. */
export function notApproved(status: ApprovalStatus, what: string) {
  return {
    approved: false,
    status,
    message:
      status === 'declined'
        ? `The owner declined this ${what}. Do not do it or try another way.`
        : `The owner did not answer in time, so the ${what} did not happen. Ask again if it is still needed.`,
  };
}

// Connected MCP tools for one Dot. A tool that needs approval waits for the
// owner's decision on the exact connection, tool and arguments it was called
// with, then runs once. Without `approve` (schedules, voice, Slack) gated
// tools never run.
export function connectionTools(
  connections: ConnectionService,
  dotId: string,
  threadId: string,
  check: () => void,
  signal: AbortSignal,
  approve: Approve | undefined,
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
    execute: async (args: unknown, context: ToolContext) => {
      check();
      // Re-resolve so a tool the owner just disabled or gated is honored.
      const current = connections.resolve(dotId, exposed.name);
      const input = (args ?? {}) as Record<string, unknown>;
      if (current.tool.requiresApproval) {
        if (!approve)
          return {
            status: 'unavailable',
            message:
              'This action needs owner approval in an OpenDots chat. Ask the owner to continue there.',
          };
        // The stored request is what runs, never arguments sent later.
        const approvalId = connections.store.createApproval({
          threadId,
          dotId,
          connectionId: current.connection.id,
          tool: current.tool.name,
          arguments: input,
        });
        const decision = await approve(context, {
          kind: 'connection_action',
          payload: {
            connection: current.connection.name,
            title: current.tool.title,
            description: current.tool.description,
            arguments: input,
          },
        });
        // A permission change while waiting stops the turn here.
        check();
        if (decision !== 'approved') return notApproved(decision, 'action');
        // One run per tool call, even if the decision arrives twice.
        if (
          !connections.store.claimAction(
            threadId,
            context.toolCallId,
            approvalId,
            current.connection.id,
            current.tool.name,
          )
        )
          return { approved: true, error: 'This action already ran.' };
        const result = await connections.call(current, input, signal);
        connections.store.finishAction(threadId, context.toolCallId, result);
        check();
        return { approved: true, ...result };
      }
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
