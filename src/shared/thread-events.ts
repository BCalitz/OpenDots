/**
 * Conversation events and the messages they build. Shared by the server
 * (which stores events and keeps the message list for the model), the web
 * app and the mobile app (which follow the live stream).
 *
 * Events are AG-UI event shapes, the format phase 1 already stored in
 * `conv_events`, so older threads replay unchanged. Only `import type` is
 * used here so the browser bundle does not pull in the AG-UI schemas.
 *
 * Keep this file free of framework and Node imports. mobile/src/lib has a
 * copy; tests/thread-events.test.ts fails if the two drift apart.
 */
import type { BaseEvent, Message, ToolCall } from '@ag-ui/core';

export type { BaseEvent, Message };

/** A loosely typed event: every field we read is checked before use. */
type Loose = BaseEvent & Record<string, unknown>;

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Replaces one message, keeping the array and other messages shared. */
function replace(messages: Message[], index: number, message: Message) {
  const next = messages.slice();
  next[index] = message;
  return next;
}

/** The assistant message holding a tool call, and that call's position. */
function findToolCall(messages: Message[], toolCallId: string) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant') continue;
    const index = (message.toolCalls ?? []).findIndex(
      (call) => call.id === toolCallId,
    );
    if (index >= 0) return { messageIndex: i, callIndex: index };
  }
  return undefined;
}

/**
 * Applies one event to a message list and returns the new list. The input
 * is never mutated, so React can compare by reference. Unknown and
 * lifecycle events return the same array.
 */
export function applyEvent(messages: Message[], raw: BaseEvent): Message[] {
  const event = raw as Loose;
  switch (event.type) {
    case 'RUN_STARTED': {
      const input = event.input as { messages?: Message[] } | undefined;
      const added = (input?.messages ?? []).filter(
        (message) => !messages.some((known) => known.id === message.id),
      );
      return added.length ? [...messages, ...added] : messages;
    }
    case 'MESSAGES_SNAPSHOT':
      return Array.isArray(event.messages)
        ? (event.messages as Message[])
        : messages;
    case 'TEXT_MESSAGE_START':
    case 'TEXT_MESSAGE_CONTENT':
    case 'TEXT_MESSAGE_CHUNK': {
      const id = text(event.messageId);
      if (!id) return messages;
      const delta =
        event.type === 'TEXT_MESSAGE_START' ? '' : text(event.delta);
      const index = messages.findIndex((message) => message.id === id);
      if (index < 0)
        return [
          ...messages,
          {
            id,
            role: event.role === 'user' ? 'user' : 'assistant',
            content: delta,
          } as Message,
        ];
      if (!delta) return messages;
      const message = messages[index];
      return replace(messages, index, {
        ...message,
        content: text(message.content) + delta,
      } as Message);
    }
    case 'TOOL_CALL_START': {
      const toolCallId = text(event.toolCallId);
      if (!toolCallId || findToolCall(messages, toolCallId)) return messages;
      const call: ToolCall = {
        id: toolCallId,
        type: 'function',
        function: { name: text(event.toolCallName), arguments: '' },
      };
      const parentId = text(event.parentMessageId);
      const index = parentId
        ? messages.findIndex((message) => message.id === parentId)
        : -1;
      const parent = index >= 0 ? messages[index] : undefined;
      if (parent?.role === 'assistant')
        return replace(messages, index, {
          ...parent,
          toolCalls: [...(parent.toolCalls ?? []), call],
        });
      return [
        ...messages,
        { id: parentId || toolCallId, role: 'assistant', toolCalls: [call] },
      ];
    }
    case 'TOOL_CALL_ARGS': {
      const found = findToolCall(messages, text(event.toolCallId));
      const delta = text(event.delta);
      if (!found || !delta) return messages;
      const message = messages[found.messageIndex];
      if (message.role !== 'assistant') return messages;
      const toolCalls = (message.toolCalls ?? []).slice();
      const call = toolCalls[found.callIndex];
      toolCalls[found.callIndex] = {
        ...call,
        function: {
          ...call.function,
          arguments: call.function.arguments + delta,
        },
      };
      return replace(messages, found.messageIndex, { ...message, toolCalls });
    }
    case 'TOOL_CALL_RESULT': {
      const toolCallId = text(event.toolCallId);
      const id = text(event.messageId) || `${toolCallId}-result`;
      if (
        !toolCallId ||
        messages.some(
          (message) =>
            message.id === id ||
            (message.role === 'tool' && message.toolCallId === toolCallId),
        )
      )
        return messages;
      return [
        ...messages,
        {
          id,
          role: 'tool',
          toolCallId,
          content: text(event.content),
        } as Message,
      ];
    }
    default:
      return messages;
  }
}

/** Builds the message list from a sequence of events. */
export function reduceEvents(
  events: BaseEvent[],
  initial: Message[] = [],
): Message[] {
  return events.reduce(applyEvent, initial);
}

/**
 * Merges streamed text and tool-argument deltas so a finished run is stored
 * and replayed as one event per message instead of one per token. The
 * merged delta sits where the first one was, so order is preserved.
 */
export function compactEvents(events: BaseEvent[]): BaseEvent[] {
  const out: BaseEvent[] = [];
  const firstText = new Map<string, number>();
  const firstArgs = new Map<string, number>();
  for (const raw of events) {
    const event = raw as Loose;
    const key =
      event.type === 'TEXT_MESSAGE_CONTENT'
        ? text(event.messageId)
        : event.type === 'TOOL_CALL_ARGS'
          ? text(event.toolCallId)
          : '';
    const seen = event.type === 'TEXT_MESSAGE_CONTENT' ? firstText : firstArgs;
    if (!key) {
      out.push(raw);
      continue;
    }
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push({ ...raw });
      continue;
    }
    const first = out[at] as Loose;
    out[at] = { ...first, delta: text(first.delta) + text(event.delta) };
  }
  return out;
}

/** Text of a message, or '' when it has none (tool calls, attachments). */
export function messageText(message: Message): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && 'text' in part
        ? text((part as { text?: unknown }).text)
        : '',
    )
    .join(' ');
}
