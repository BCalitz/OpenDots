import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  reportChannelFailure,
  safeFailure,
  type ChannelAdapter,
  type ChannelMessage,
} from './adapter.js';

export const PAUSED_NOTICE =
  'OpenDots is paused. Resume it in the app before asking me to continue.';
export const FAILED_NOTICE =
  'I couldn’t complete that request. Please check OpenDots and send a new message when you’re ready to try again.';

/**
 * Connects a channel to one Dot. Only allowlisted people in the allowed
 * workspace are answered. A conversation starts when someone addresses the
 * bot; after that, every message in that channel thread continues the same
 * OpenDots thread, one turn at a time. Replies never include error details.
 */
export class ChannelService {
  private db: DatabaseSync;
  private queues = new Map<string, Promise<void>>();
  private controller = new AbortController();
  constructor(
    private adapter: ChannelAdapter,
    private options: {
      database: string;
      tenantId: string;
      userIds: string[];
      dotId: string;
      paused: () => boolean;
      /** Creates the OpenDots thread for a new channel conversation. */
      createThread: (dotId: string, title: string) => Promise<string>;
      /** Runs one turn and returns the reply. */
      turn: (
        threadId: string,
        prompt: string,
        signal: AbortSignal,
      ) => Promise<string>;
    },
  ) {
    const { database } = options;
    if (database !== ':memory:')
      mkdirSync(dirname(database), { recursive: true });
    this.db = new DatabaseSync(database);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS channel_threads(channel TEXT NOT NULL, threadKey TEXT NOT NULL, threadId TEXT NOT NULL, createdAt INTEGER NOT NULL, PRIMARY KEY(channel, threadKey));`);
  }

  status() {
    return this.adapter.status();
  }
  start() {
    this.controller = new AbortController();
    return this.adapter.start((message) => this.receive(message));
  }
  async stop() {
    this.controller.abort();
    await this.adapter.stop();
    await Promise.allSettled(this.queues.values());
    this.db.close();
  }
  /** The OpenDots thread for a channel conversation, if it has one. */
  threadFor(threadKey: string) {
    const row = this.db
      .prepare(
        'SELECT threadId FROM channel_threads WHERE channel=? AND threadKey=?',
      )
      .get(this.adapter.name, threadKey) as { threadId: string } | undefined;
    return row?.threadId;
  }

  /** Handles one message; returns when it has been answered. */
  receive(message: ChannelMessage): Promise<void> {
    if (
      message.tenantId !== this.options.tenantId ||
      !this.options.userIds.includes(message.userId)
    )
      return Promise.resolve();
    // A follow-up continues a conversation, including one whose first
    // message is still being answered.
    if (
      !message.addressed &&
      !this.queues.has(message.threadKey) &&
      !this.threadFor(message.threadKey)
    )
      return Promise.resolve();
    // One turn at a time per channel conversation, in arrival order.
    const previous = this.queues.get(message.threadKey) ?? Promise.resolve();
    const next = previous.then(() => this.answer(message));
    this.queues.set(message.threadKey, next);
    void next.finally(() => {
      if (this.queues.get(message.threadKey) === next)
        this.queues.delete(message.threadKey);
    });
    return next;
  }

  private async answer(message: ChannelMessage) {
    if (this.controller.signal.aborted) return;
    try {
      if (this.options.paused()) {
        await this.adapter.reply(message.threadKey, PAUSED_NOTICE);
        return;
      }
      let threadId = this.threadFor(message.threadKey);
      if (!threadId) {
        threadId = await this.options.createThread(
          this.options.dotId,
          `Slack: ${message.text.replace(/\s+/g, ' ').slice(0, 60)}`,
        );
        this.db
          .prepare('INSERT OR IGNORE INTO channel_threads VALUES (?, ?, ?, ?)')
          .run(this.adapter.name, message.threadKey, threadId, Date.now());
        threadId = this.threadFor(message.threadKey)!;
      }
      let reply: string;
      try {
        reply = await this.options.turn(
          threadId,
          message.text,
          this.controller.signal,
        );
      } catch (error) {
        if (this.controller.signal.aborted) return;
        reportChannelFailure('Channel turn failed; error reply posted', [
          safeFailure(error),
        ]);
        reply = FAILED_NOTICE;
      }
      await this.adapter.reply(message.threadKey, reply);
    } catch (error) {
      reportChannelFailure(`${this.adapter.name} reply failed`, [
        safeFailure(error),
      ]);
    }
  }
}
