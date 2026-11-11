import type { ThreadRunner } from '../engine/thread-runner.js';
import type { DotEngine } from '../engine/index.js';

/**
 * Conversation storage and server-side turns, in the shape PageService and
 * the platform use. Threads live in this server's database.
 */
export class LocalConversationBackend {
  constructor(
    readonly runner: ThreadRunner,
    private engine: DotEngine,
  ) {}
  /** Chat threads start unnamed; a name is generated after the first answer. */
  createThread({ threadId, dotId }: { threadId: string; dotId: string }) {
    this.runner.createThread({ threadId, agentId: dotId });
    return Promise.resolve();
  }
  getOrCreateThread({
    threadId,
    agentId,
    name,
  }: {
    threadId: string;
    agentId: string;
    name: string;
  }) {
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
  }: {
    threadId: string;
    prompt: string;
    signal: AbortSignal;
    metadata?: Record<string, unknown>;
  }) {
    return this.engine.turn(threadId, prompt, signal, metadata);
  }
}
