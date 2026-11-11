import { EventType, type BaseEvent, type Message } from '@ag-ui/core';
import { connectionActionTool } from '../../shared/connection-types.js';
import { pageReviewTool } from '../../shared/page-review.js';
import { voiceReceiptMessagePrefix } from '../../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../../shared/scheduled-message.js';
import { delegationMessagePrefix } from '../../shared/delegation.js';
import type { RunStep } from '../../shared/insight-types.js';

const MAX_TEXT = 4000;
const clip = (value: string) =>
  value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n[truncated]` : value;
const text = (content: unknown) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part && typeof part === 'object' && 'text' in part
              ? String((part as { text?: unknown }).text ?? '')
              : '',
          )
          .join(' ')
      : content == null
        ? ''
        : JSON.stringify(content);
const sourceOf = (
  message: Message,
): 'chat' | 'voice' | 'schedule' | 'delegation' =>
  message.id.startsWith(voiceReceiptMessagePrefix)
    ? 'voice'
    : message.id.startsWith(scheduledTaskMessagePrefix)
      ? 'schedule'
      : message.id.startsWith(delegationMessagePrefix)
        ? 'delegation'
        : 'chat';
const approvalTools = new Set([connectionActionTool.name, pageReviewTool.name]);

/**
 * Turns one run's stored AG-UI events into the steps the run inspector shows:
 * what started it, what the Dot said, each tool call with its arguments and
 * result, owner approvals, errors and token usage. Content is shown as data,
 * clipped, and never interpreted.
 */
export function inspectRun(events: BaseEvent[]): RunStep[] {
  const steps: RunStep[] = [];
  const tools = new Map<string, Extract<RunStep, { kind: 'tool' }>>();
  const messages = new Map<string, Extract<RunStep, { kind: 'message' }>>();
  for (const event of events) {
    const at = event.timestamp ?? 0;
    const data = event as BaseEvent & Record<string, unknown>;
    switch (event.type) {
      case EventType.RUN_STARTED: {
        const input = data.input as { messages?: Message[] } | undefined;
        for (const message of input?.messages ?? []) {
          if (message.role === 'user')
            steps.push({
              kind: 'prompt',
              at,
              source: sourceOf(message),
              text: clip(text(message.content)),
            });
          else if (message.role === 'tool')
            steps.push({
              kind: 'decision',
              at,
              toolCallId: String(
                (message as { toolCallId?: unknown }).toolCallId ?? '',
              ),
              text: clip(text(message.content)),
            });
        }
        break;
      }
      case EventType.TEXT_MESSAGE_START: {
        const step: Extract<RunStep, { kind: 'message' }> = {
          kind: 'message',
          at,
          text: '',
        };
        messages.set(String(data.messageId), step);
        steps.push(step);
        break;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const id = String(data.messageId);
        let step = messages.get(id);
        if (!step) {
          step = { kind: 'message', at, text: '' };
          messages.set(id, step);
          steps.push(step);
        }
        step.text = clip(step.text + String(data.delta ?? ''));
        break;
      }
      case EventType.TEXT_MESSAGE_CHUNK: {
        const id = String(data.messageId ?? '');
        let step = messages.get(id);
        if (!step) {
          step = { kind: 'message', at, text: '' };
          messages.set(id, step);
          steps.push(step);
        }
        step.text = clip(step.text + String(data.delta ?? ''));
        break;
      }
      case EventType.TOOL_CALL_START:
      case EventType.TOOL_CALL_CHUNK: {
        const id = String(data.toolCallId ?? '');
        let step = tools.get(id);
        if (!step) {
          const name = String(data.toolCallName ?? 'tool');
          step = {
            kind: 'tool',
            at,
            endedAt: null,
            toolCallId: id,
            name,
            approval: approvalTools.has(name),
            args: '',
            result: null,
          };
          tools.set(id, step);
          steps.push(step);
        }
        if (event.type === EventType.TOOL_CALL_CHUNK && data.delta)
          step.args = clip(step.args + String(data.delta));
        break;
      }
      case EventType.TOOL_CALL_ARGS: {
        const step = tools.get(String(data.toolCallId));
        if (step) step.args = clip(step.args + String(data.delta ?? ''));
        break;
      }
      case EventType.TOOL_CALL_END: {
        const step = tools.get(String(data.toolCallId));
        if (step) step.endedAt ??= at;
        break;
      }
      case EventType.TOOL_CALL_RESULT: {
        const step = tools.get(String(data.toolCallId));
        if (step) {
          step.result = clip(text(data.content));
          step.endedAt = at;
        }
        break;
      }
      case EventType.RUN_ERROR:
        steps.push({
          kind: 'error',
          at,
          message: clip(String(data.message ?? 'The run failed.')),
        });
        break;
      case EventType.RUN_FINISHED: {
        const usage = Array.isArray(data.usage)
          ? (data.usage as Record<string, unknown>[])
          : [];
        steps.push({
          kind: 'finished',
          at,
          usage: usage.map((entry) => ({
            model: typeof entry.model === 'string' ? entry.model : null,
            inputTokens:
              typeof entry.inputTokens === 'number' ? entry.inputTokens : 0,
            outputTokens:
              typeof entry.outputTokens === 'number' ? entry.outputTokens : 0,
          })),
        });
        break;
      }
    }
  }
  return steps.filter((step) => step.kind !== 'message' || step.text.trim());
}
