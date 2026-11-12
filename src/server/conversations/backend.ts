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
  async createThread({ threadId, dotId }: { threadId: string; dotId: string }) {
    await this.runner.createThread({ threadId, agentId: dotId });
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
    return this.runner.createThread({ threadId, agentId, name });
  }
  async getThreadMessages({ threadId }: { threadId: string; userId?: string }) {
    return { messages: await this.runner.messages(threadId) };
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
