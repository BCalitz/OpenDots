import { randomUUID } from 'node:crypto';
import type { ModelMessage, StreamChunk } from '@tanstack/ai';
import {
  messageText,
  type BaseEvent,
  type Message,
} from '../../shared/thread-events.js';
import type { TokenUsage } from './thread-runner.js';

/**
 * How much history goes to the model. Each Dot is one continuing chat, so
 * without a window a busy Dot would eventually overflow the model's context
 * and grow every turn's cost. The window starts at a user message so tool
 * calls and their results are never split.
 */
const HISTORY_LIMIT = { messages: 80, characters: 120_000 };

function size(message: Message) {
  const calls =
    message.role === 'assistant'
      ? (message.toolCalls ?? []).reduce(
          (sum, call) => sum + call.function.arguments.length,
          0,
        )
      : 0;
  return messageText(message).length + calls;
}

/** The recent part of a thread that fits the window. */
export function historyWindow(messages: Message[], limit = HISTORY_LIMIT) {
  const chat = messages.filter((message) =>
    ['user', 'assistant', 'tool'].includes(message.role),
  );
  let start = chat.length;
  let characters = 0;
  while (start > 0 && chat.length - start < limit.messages) {
    characters += size(chat[start - 1]);
    if (characters > limit.characters && start < chat.length) break;
    start--;
  }
  // Begin at a user message; if none fits, keep only the newest one.
  while (start < chat.length && chat[start].role !== 'user') start++;
  if (start === chat.length) {
    const last = chat.findLastIndex((message) => message.role === 'user');
    return last >= 0 ? chat.slice(last) : [];
  }
  return chat.slice(start);
}

/** Thread messages in the shape TanStack AI sends to the model. */
export function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((message): ModelMessage => {
    if (message.role === 'tool')
      return {
        role: 'tool',
        content: messageText(message),
        toolCallId: message.toolCallId,
      };
    if (message.role === 'assistant')
      return {
        role: 'assistant',
        content: messageText(message) || null,
        ...(message.toolCalls?.length
          ? {
              toolCalls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: {
                  name: call.function.name,
                  arguments: call.function.arguments,
                },
              })),
            }
          : {}),
      };
    return { role: 'user', content: messageText(message) };
  });
}

type Raw = StreamChunk & Record<string, unknown>;
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;

/** Token usage from one TanStack RUN_FINISHED chunk, in either shape. */
function chunkUsage(chunk: Raw): TokenUsage[] {
  const model = str(chunk.model) || null;
  const usage = chunk.usage as unknown;
  if (Array.isArray(usage))
    return usage.flatMap((entry: Record<string, unknown>) =>
      entry && typeof entry === 'object'
        ? [
            {
              model: str(entry.model) || model,
              inputTokens: count(entry.inputTokens),
              outputTokens: count(entry.outputTokens),
              totalTokens: count(entry.totalTokens),
            },
          ]
        : [],
    );
  if (!usage || typeof usage !== 'object') return [];
  const record = usage as Record<string, unknown>;
  const entry = {
    model,
    inputTokens: count(record.promptTokens ?? record.inputTokens),
    outputTokens: count(record.completionTokens ?? record.outputTokens),
    totalTokens: count(record.totalTokens),
  };
  return entry.inputTokens === undefined && entry.outputTokens === undefined
    ? []
    : [entry];
}

/**
 * Turns TanStack AI's stream into the thread's events. Each model step gets
 * its own assistant message: text first, then the tool calls it made, then
 * one tool message per result. That is the order the model API expects when
 * the history is sent back.
 */
export async function streamEvents(
  stream: AsyncIterable<StreamChunk>,
  out: { emit(event: BaseEvent): void; usage(entries: TokenUsage[]): void },
  signal: AbortSignal,
) {
  let messageId: string | undefined;
  let textOpen = false;
  let resultsSeen = false;
  const started = new Set<string>();
  const ended = new Set<string>();
  const closeText = () => {
    if (!textOpen || !messageId) return;
    out.emit({ type: 'TEXT_MESSAGE_END', messageId } as BaseEvent);
    textOpen = false;
  };
  /** The assistant message for the current model step. */
  const current = () => {
    if (!messageId || resultsSeen) {
      closeText();
      messageId = randomUUID();
      resultsSeen = false;
    }
    return messageId;
  };
  for await (const chunk of stream as AsyncIterable<Raw>) {
    if (signal.aborted) break;
    switch (chunk.type) {
      case 'TEXT_MESSAGE_CONTENT': {
        const delta = str(chunk.delta);
        if (!delta) break;
        const id = current();
        if (!textOpen) {
          out.emit({
            type: 'TEXT_MESSAGE_START',
            messageId: id,
            role: 'assistant',
          } as BaseEvent);
          textOpen = true;
        }
        out.emit({
          type: 'TEXT_MESSAGE_CONTENT',
          messageId: id,
          delta,
        } as BaseEvent);
        break;
      }
      case 'TOOL_CALL_START': {
        const toolCallId = str(chunk.toolCallId);
        if (!toolCallId || started.has(toolCallId)) break;
        started.add(toolCallId);
        const parentMessageId = current();
        closeText();
        out.emit({
          type: 'TOOL_CALL_START',
          toolCallId,
          toolCallName: str(chunk.toolCallName ?? chunk.toolName),
          parentMessageId,
        } as BaseEvent);
        break;
      }
      case 'TOOL_CALL_ARGS': {
        const toolCallId = str(chunk.toolCallId);
        const delta = str(chunk.delta);
        if (!started.has(toolCallId) || ended.has(toolCallId) || !delta) break;
        out.emit({ type: 'TOOL_CALL_ARGS', toolCallId, delta } as BaseEvent);
        break;
      }
      case 'TOOL_CALL_END': {
        const toolCallId = str(chunk.toolCallId);
        if (!started.has(toolCallId) || ended.has(toolCallId)) break;
        ended.add(toolCallId);
        out.emit({ type: 'TOOL_CALL_END', toolCallId } as BaseEvent);
        break;
      }
      case 'TOOL_CALL_RESULT': {
        const toolCallId = str(chunk.toolCallId);
        if (!toolCallId) break;
        closeText();
        resultsSeen = true;
        const payload = chunk.content ?? chunk.result;
        let content: string;
        try {
          content =
            typeof payload === 'string'
              ? payload
              : JSON.stringify(payload ?? null);
        } catch {
          content = '[Unserializable tool result]';
        }
        out.emit({
          type: 'TOOL_CALL_RESULT',
          messageId: randomUUID(),
          toolCallId,
          role: 'tool',
          content,
        } as BaseEvent);
        break;
      }
      case 'RUN_FINISHED':
        out.usage(chunkUsage(chunk));
        break;
      case 'RUN_ERROR':
        throw new Error(
          str(chunk.message) ||
            str((chunk.error as { message?: unknown } | undefined)?.message) ||
            'The model returned an error.',
        );
      default:
        break;
    }
  }
  closeText();
}
