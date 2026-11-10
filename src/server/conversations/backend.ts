import { randomUUID } from 'node:crypto';
import type { AbstractAgent, Message } from '@ag-ui/client';
import { EventType, type BaseEvent } from '@ag-ui/core';
import type { CopilotKitIntelligence } from '@copilotkit/runtime/v2';
import { lastValueFrom, tap } from 'rxjs';
import { runThreadTurn } from '../headless.js';
import { voiceReceiptMessagePrefix } from '../../shared/voice-receipt.js';
import { scheduledTaskMessagePrefix } from '../../shared/scheduled-message.js';
import type { LocalAgentRunner } from './local-runner.js';

export type ConversationBackendKind = 'local' | 'intelligence';
interface ThreadMessage {
  role: string;
  content?: unknown;
}
/**
 * Where conversations are stored and how server-side turns (voice, schedules)
 * run. The shape of `getOrCreateThread` and `getThreadMessages` matches what
 * PageService already expects from the Intelligence SDK.
 */
export interface ConversationBackend {
  readonly kind: ConversationBackendKind;
  createThread(input: {
    threadId: string;
    dotId: string;
    name: string;
  }): Promise<void>;
  getOrCreateThread(input: {
    threadId: string;
    userId: string;
    agentId: string;
    name: string;
  }): Promise<unknown>;
  getThreadMessages(input: {
    threadId: string;
    userId: string;
  }): Promise<{ messages: ThreadMessage[] }>;
  turn(input: {
    threadId: string;
    dotId: string;
    prompt: string;
    signal: AbortSignal;
    metadata?: Record<string, unknown>;
  }): Promise<string>;
}

function messageIdPrefix(metadata?: Record<string, unknown>) {
  return metadata?.opendotsSource === 'voice_receipt'
    ? voiceReceiptMessagePrefix
    : metadata?.opendotsSource === 'scheduled_task'
      ? scheduledTaskMessagePrefix
      : '';
}

export class LocalConversationBackend implements ConversationBackend {
  readonly kind = 'local' as const;
  constructor(
    readonly runner: LocalAgentRunner,
    private agent: (dotId: string) => AbstractAgent,
  ) {}
  /** Chat threads start unnamed; a name is generated after the first answer. */
  createThread({
    threadId,
    dotId,
  }: Parameters<ConversationBackend['createThread']>[0]) {
    this.runner.createThread({ threadId, agentId: dotId });
    return Promise.resolve();
  }
  getOrCreateThread({
    threadId,
    agentId,
    name,
  }: Parameters<ConversationBackend['getOrCreateThread']>[0]) {
    return Promise.resolve(
      this.runner.createThread({ threadId, agentId, name }),
    );
  }
  getThreadMessages({ threadId }: { threadId: string; userId?: string }) {
    return Promise.resolve({
      messages: this.runner.getThreadMessages(threadId),
    });
  }
  /** Runs one turn in-process through the same runner the browser uses. */
  async turn({
    threadId,
    dotId,
    prompt,
    signal,
    metadata,
  }: Parameters<ConversationBackend['turn']>[0]) {
    signal.throwIfAborted();
    const agent = this.agent(dotId);
    const userMessage = {
      id: `${messageIdPrefix(metadata)}${randomUUID()}`,
      role: 'user',
      content: prompt,
      ...(metadata ? { metadata } : {}),
    } as Message;
    const runId = randomUUID();
    const events = this.runner.run({
      threadId,
      agent,
      input: {
        threadId,
        runId,
        messages: [userMessage],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
    });
    const stop = () => void this.runner.stop({ threadId, runId });
    signal.addEventListener('abort', stop, { once: true });
    let runError: string | undefined;
    try {
      await lastValueFrom(
        events.pipe(
          tap((event: BaseEvent) => {
            if (event.type === EventType.RUN_ERROR)
              runError = (event as { message?: string }).message;
          }),
        ),
        { defaultValue: undefined },
      );
    } finally {
      signal.removeEventListener('abort', stop);
    }
    signal.throwIfAborted();
    if (runError) throw new Error(runError);
    const reply = agent.messages
      .slice(agent.messages.findIndex((m) => m.id === userMessage.id) + 1)
      .filter((message) => message.role === 'assistant')
      .at(-1)?.content;
    if (typeof reply !== 'string' || !reply.trim())
      throw new Error(
        'The current compute turn returned no assistant response.',
      );
    return reply;
  }
}

export class IntelligenceConversationBackend implements ConversationBackend {
  readonly kind = 'intelligence' as const;
  constructor(
    private intelligence: CopilotKitIntelligence,
    private ownerId: string,
    private runtime: { url: string; ownerToken?: string },
  ) {}
  async createThread({
    threadId,
    dotId,
    name,
  }: Parameters<ConversationBackend['createThread']>[0]) {
    try {
      await this.intelligence.createThread({
        threadId,
        userId: this.ownerId,
        agentId: dotId,
        name,
      });
    } catch {
      throw new Error(
        'Intelligence could not create this conversation. Check the runtime key and connection.',
      );
    }
  }
  getOrCreateThread(
    input: Parameters<ConversationBackend['getOrCreateThread']>[0],
  ) {
    return this.intelligence.getOrCreateThread(input);
  }
  getThreadMessages(input: { threadId: string; userId: string }) {
    return this.intelligence.getThreadMessages(input);
  }
  turn({
    threadId,
    dotId,
    prompt,
    signal,
    metadata,
  }: Parameters<ConversationBackend['turn']>[0]) {
    return runThreadTurn(
      this.runtime.url,
      this.runtime.ownerToken
        ? { Authorization: `Bearer ${this.runtime.ownerToken}` }
        : {},
      dotId,
      threadId,
      prompt,
      signal,
      metadata,
    );
  }
}
