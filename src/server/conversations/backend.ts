import type { CopilotKitIntelligence } from '@copilotkit/runtime/v2';
import { runThreadTurn } from '../headless.js';
import type { ThreadRunner } from '../engine/thread-runner.js';
import type { DotEngine } from '../engine/index.js';

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

export class LocalConversationBackend implements ConversationBackend {
  readonly kind = 'local' as const;
  constructor(
    readonly runner: ThreadRunner,
    private engine: DotEngine,
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
    return Promise.resolve({ messages: this.runner.messages(threadId) });
  }
  /** Runs one turn in-process through the same engine the apps use. */
  turn({
    threadId,
    prompt,
    signal,
    metadata,
  }: Parameters<ConversationBackend['turn']>[0]) {
    return this.engine.turn(threadId, prompt, signal, metadata);
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
