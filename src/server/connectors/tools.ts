import type { JSONSchema } from '@tanstack/ai';
import type { Tool, ToolContext } from '../engine/tools.js';
import type { ApprovalKind, ApprovalStatus } from '../../shared/approvals.js';
import type { GrantedTool } from '../../shared/connection-types.js';
import type { ConnectorService } from './service.js';
import type { UsageStore } from '../usage-store.js';
import type { ToolCalls } from '../engine/tool-calls.js';

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

// Connected tools for one Dot. A tool whose policy is "ask" waits for the
// owner's decision on the exact account, tool and arguments it was called
// with, then runs once. Without `approve` (schedules, voice, Slack) gated
// tools never run.
export async function connectorTools(
  connectors: ConnectorService,
  dotId: string,
  threadId: string,
  check: () => Promise<void>,
  signal: AbortSignal,
  approve: Approve | undefined,
  toolCalls: ToolCalls,
  log?: UsageStore,
  /** Only tools the service marks read-only and that run without asking. */
  readOnly = false,
) {
  const readable = (tool: GrantedTool) =>
    !readOnly || (tool.readOnly && tool.policy === 'allow');
  return (await connectors.tools(dotId))
    .filter((exposed) => readable(exposed.tool))
    .map((exposed): Tool => ({
      name: exposed.name,
      description:
        `[${exposed.account.name}${exposed.tool.policy === 'ask' ? ', needs owner approval' : ''}] ${exposed.tool.title}: ${exposed.tool.description}`.slice(
          0,
          1024,
        ),
      parameters: exposed.tool.inputSchema as JSONSchema,
      execute: async (args: unknown, context: ToolContext) => {
        await check();
        // Re-resolve so a tool the owner just blocked or gated is honored.
        const current = await connectors.resolve(dotId, exposed.name);
        const input = (args ?? {}) as Record<string, unknown>;
        if (!readable(current.tool))
          return {
            status: 'unavailable',
            message:
              'This turn is read-only and this tool can change things. Describe it in your proposal instead.',
          };
        if (current.tool.policy === 'ask') {
          if (!approve)
            return {
              status: 'unavailable',
              message:
                'This action needs owner approval in an OpenDots chat. Ask the owner to continue there.',
            };
          // The stored request is what runs, never arguments sent later.
          const approvalId = await connectors.actions.createApproval({
            threadId,
            dotId,
            accountId: current.account.id,
            tool: current.tool.name,
            arguments: input,
          });
          const decision = await approve(context, {
            kind: 'connection_action',
            payload: {
              connection: current.account.name,
              title: current.tool.title,
              description: current.tool.description,
              arguments: input,
            },
          });
          // A permission change while waiting stops the turn here.
          await check();
          if (decision !== 'approved') return notApproved(decision, 'action');
          // One run per tool call, even if the decision arrives twice. The
          // claim stays if the call fails: it may have reached the service.
          const once = await toolCalls.once(
            {
              threadId,
              toolCallId: context.toolCallId,
              kind: 'connector',
              tool: current.tool.name,
              dotId,
              accountId: current.account.id,
              approvalId,
            },
            () => connectors.call(current, input, signal),
          );
          if (!once.ran)
            return { approved: true, error: 'This action already ran.' };
          await check();
          return { approved: true, ...once.result };
        }
        // Approved actions keep their own receipts; ungated calls are logged here.
        const entry = await log?.beginAction({
          dotId,
          threadId,
          kind: 'mcp',
          target: current.account.name,
          action: current.tool.name,
          readOnly: current.tool.readOnly,
        });
        const result = await connectors.call(current, input, signal);
        if (entry)
          await log!.finishAction(
            entry,
            result.isError ? 'failed' : 'succeeded',
          );
        await check();
        return result;
      },
    }));
}
