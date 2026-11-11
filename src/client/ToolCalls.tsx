import { Wrench } from 'lucide-react';
import type { Message } from '../shared/thread-events';
import type { ApprovalView } from '../shared/approvals';
import { pageReviewTool } from '../shared/page-review';
import { legacyConnectionActionTool } from '../shared/connection-types';
import { ComputerToolCard, computerToolResult } from './ComputerToolCard';
import { PageReviewCard } from './PageReviewCard';
import { ConnectionActionCard } from './ConnectionActionCard';
import { ApprovalRequestCard } from './ApprovalRequestCard';
import { approvalRequestTool } from '../shared/approval-request';

type AssistantMessage = Extract<Message, { role: 'assistant' }>;

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Tool results in a thread, by tool call id. */
export function toolResults(messages: Message[]) {
  const results = new Map<string, unknown>();
  for (const message of messages)
    if (message.role === 'tool')
      results.set(message.toolCallId, message.content);
  return results;
}

/** Shown for any tool without its own card. */
function DefaultToolCard({
  name,
  result,
  running,
}: {
  name: string;
  result?: unknown;
  running: boolean;
}) {
  const data = result === undefined ? undefined : computerToolResult(result);
  const failed =
    !!data && (typeof data.error === 'string' || data.status === 'error');
  const label = name.replace(/[_-]+/g, ' ').trim();
  return (
    <section
      className="inline-computer tool-call"
      aria-label={`Tool: ${label}`}
    >
      <header>
        <Wrench size={15} aria-hidden="true" />
        <strong>{label}</strong>
        <span className={failed ? 'tool-state failed' : 'tool-state'}>
          {failed
            ? 'Needs attention'
            : data
              ? 'Finished'
              : running
                ? 'Working'
                : 'Interrupted'}
        </span>
      </header>
    </section>
  );
}

/** The cards for one assistant message's tool calls. */
export function ToolCalls({
  message,
  results,
  approvals,
  running,
  dot,
  latestBrowserCallId,
  onComputer,
  onDecide,
}: {
  message: AssistantMessage;
  results: Map<string, unknown>;
  approvals: Record<string, ApprovalView>;
  running: boolean;
  dot: { id: string; name: string };
  latestBrowserCallId?: string;
  onComputer?: () => void;
  onDecide: (approvalId: string, approved: boolean) => Promise<unknown>;
}) {
  return (
    <>
      {(message.toolCalls ?? []).map((call) => {
        const name = call.function.name;
        const args = parse(call.function.arguments);
        const result = results.get(call.id);
        const approval = approvals[call.id];
        if (approval?.kind === 'page_review' || name === pageReviewTool.name)
          return (
            <PageReviewCard
              key={call.id}
              args={args}
              result={result}
              approval={approval}
              running={running}
              onDecide={onDecide}
            />
          );
        if (approval?.kind === 'action' || name === approvalRequestTool.name)
          return (
            <ApprovalRequestCard
              key={call.id}
              result={result}
              approval={approval}
              running={running}
              onDecide={onDecide}
            />
          );
        if (
          approval?.kind === 'connection_action' ||
          name === legacyConnectionActionTool
        )
          return (
            <ConnectionActionCard
              key={call.id}
              args={args}
              result={result}
              approval={approval}
              running={running}
              onDecide={onDecide}
            />
          );
        if (name.startsWith('computer_'))
          return (
            <ComputerToolCard
              key={call.id}
              name={name}
              toolCallId={call.id}
              status={result === undefined ? 'executing' : 'complete'}
              args={args}
              result={result}
              dotId={dot.id}
              dotName={dot.name}
              running={running}
              showScreen={call.id === latestBrowserCallId}
              onExpand={onComputer}
            />
          );
        return (
          <DefaultToolCard
            key={call.id}
            name={name}
            result={result}
            running={running}
          />
        );
      })}
    </>
  );
}
