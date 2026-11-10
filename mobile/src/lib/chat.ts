import { IntelligenceAgent } from '@copilotkit/core';
import type { Message } from '@ag-ui/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders, conversationPath, type PageContext } from './api';
import type { Session } from './session';
import { frontendTools, isFrontendTool, type FrontendToolName } from './tools';

type Status = 'connecting' | 'ready' | 'running' | 'failed';
export interface PendingTool {
  name: FrontendToolName;
  toolCallId: string;
  args: unknown;
}

// Same id prefix the server gives scheduled-task prompts.
export const isScheduledMessage = (message: Message) =>
  message.role === 'user' && message.id.startsWith('opendots:scheduled_task:');

const runInput = () => ({
  forwardedProps: {},
  tools: frontendTools,
  context: [],
});

// Matches the web app's contextualMessage(): page conversations prefix each
// message with a link to the page so the Dot knows which page you mean.
function contextual(text: string, page: PageContext | null) {
  return page
    ? `From [${page.title.replace(/[[\]\\\r\n]/g, '')}](/#/spaces/${page.spaceId}/pages/${page.id}):\n\n${text}`
    : text;
}

function parseArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// Human-in-the-loop tool calls the Dot is waiting on (no tool result yet).
export function pendingTools(messages: Message[]): PendingTool[] {
  const answered = new Set(
    messages.flatMap((m) => (m.role === 'tool' ? [m.toolCallId] : [])),
  );
  return messages.flatMap((message) =>
    message.role === 'assistant'
      ? (message.toolCalls ?? []).flatMap((call) =>
          isFrontendTool(call.function.name) && !answered.has(call.id)
            ? [
                {
                  name: call.function.name,
                  toolCallId: call.id,
                  args: parseArgs(call.function.arguments),
                },
              ]
            : [],
        )
      : [],
  );
}

// One conversation with a Dot, over the same CopilotKit Intelligence runtime
// the web app uses: REST to join, then a realtime socket for events.
export function useConversation(
  session: Session,
  threadId: string,
  dotId: string,
) {
  const agentRef = useRef<IntelligenceAgent | null>(null);
  const pageRef = useRef<PageContext | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [status, setStatus] = useState<Status>('connecting');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    let agent: IntelligenceAgent | null = null;
    let unsubscribe = () => {};
    setStatus('connecting');
    setError('');
    setMessages([]);
    void (async () => {
      try {
        const runtimeUrl = `${session.server}/api/copilotkit`;
        const headers = authHeaders(session);
        const [info, page] = await Promise.all([
          fetch(`${runtimeUrl}/info`, { headers }).then(async (response) => {
            if (!response.ok)
              throw new Error(
                response.status === 503
                  ? 'Conversations need CopilotKit Intelligence on the server.'
                  : `The runtime returned HTTP ${response.status}.`,
              );
            return (await response.json()) as {
              intelligence?: { wsUrl?: string };
              agents?: Record<string, unknown>;
            };
          }),
          api<PageContext | null>(
            session,
            `${conversationPath(threadId)}/page-context`,
          ),
        ]);
        const wsUrl = info.intelligence?.wsUrl;
        if (!wsUrl)
          throw new Error('The server is not using CopilotKit Intelligence.');
        if (!info.agents || !Object.hasOwn(info.agents, dotId))
          throw new Error('This Dot is not available on the server.');
        if (!active) return;
        pageRef.current = page;
        agent = new IntelligenceAgent({
          url: wsUrl,
          runtimeUrl,
          agentId: dotId,
          headers,
        });
        agent.threadId = threadId;
        agentRef.current = agent;
        const subscription = agent.subscribe({
          onMessagesChanged: ({ messages }) => {
            if (active) setMessages([...messages]);
          },
          onRunErrorEvent: ({ event }) => {
            if (active) setError(event.message);
          },
        });
        unsubscribe = () => subscription.unsubscribe();
        // Replays the saved history of this thread.
        await agent.connectAgent(runInput());
        if (!active) return;
        setMessages([...agent.messages]);
        setStatus('ready');
      } catch (cause) {
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : 'The conversation could not connect.',
        );
        setStatus('failed');
      }
    })();
    return () => {
      active = false;
      unsubscribe();
      agentRef.current = null;
      void agent?.detachActiveRun().catch(() => {});
    };
  }, [session, threadId, dotId, attempt]);

  const run = useCallback(async () => {
    const agent = agentRef.current;
    if (!agent) return;
    setStatus('running');
    setError('');
    try {
      await agent.detachActiveRun();
      const result = await agent.runAgent(runInput());
      setMessages([...agent.messages]);
      // A turn that only calls a review tool has no text yet; that's fine.
      if (!result.newMessages.some((message) => message.role === 'assistant'))
        throw new Error(
          'The turn returned no response. Check the server and retry.',
        );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'The turn failed. Your conversation is still saved.',
      );
    } finally {
      setStatus('ready');
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const agent = agentRef.current;
      if (!agent || !text.trim()) return;
      agent.addMessage({
        id: crypto.randomUUID(),
        role: 'user',
        content: contextual(text.trim(), pageRef.current),
      });
      await run();
    },
    [run],
  );

  // Answers a human-in-the-loop tool call and lets the Dot continue.
  const respond = useCallback(
    async (toolCallId: string, result: unknown) => {
      const agent = agentRef.current;
      if (!agent) return;
      if (
        agent.messages.some(
          (m) => m.role === 'tool' && m.toolCallId === toolCallId,
        )
      )
        return;
      agent.addMessage({
        id: crypto.randomUUID(),
        role: 'tool',
        toolCallId,
        content: JSON.stringify(result),
      });
      await run();
    },
    [run],
  );

  const stop = useCallback(() => agentRef.current?.abortRun(), []);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return { messages, status, error, send, respond, stop, retry };
}
