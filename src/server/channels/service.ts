import { sql, type Db } from '../db/index.js';
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
  private db: Db;
  private queues = new Map<string, Promise<void>>();
  private controller = new AbortController();
  constructor(
    private adapter: ChannelAdapter,
    private options: {
      db: Db;
      tenantId: string;
      userIds: string[];
      dotId: string;
      paused: () => Promise<boolean>;
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
    this.db = options.db;
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
  }
  /** The OpenDots thread for a channel conversation, if it has one. */
  async threadFor(threadKey: string) {
    const row = await this.db.row<{ threadId: string }>(
      sql`SELECT thread_id FROM channel_threads WHERE channel=${this.adapter.name} AND thread_key=${threadKey}`,
    );
    return row?.threadId;
  }

  /** Handles one message; returns when it has been answered. */
  receive(message: ChannelMessage): Promise<void> {
    if (
      message.tenantId !== this.options.tenantId ||
      !this.options.userIds.includes(message.userId)
    )
      return Promise.resolve();
    // One turn at a time per channel conversation, in arrival order. A
    // follow-up continues a conversation, including one whose first message
    // is still being answered; anything else must address the bot.
    const queued = this.queues.has(message.threadKey);
    const previous = this.queues.get(message.threadKey) ?? Promise.resolve();
    const next = previous.then(async () => {
      if (
        !message.addressed &&
        !queued &&
        !(await this.threadFor(message.threadKey).catch(() => undefined))
      )
        return;
      await this.answer(message);
    });
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
      if (await this.options.paused()) {
        await this.adapter.reply(message.threadKey, PAUSED_NOTICE);
        return;
      }
      let threadId = await this.threadFor(message.threadKey);
      if (!threadId) {
        threadId = await this.options.createThread(
          this.options.dotId,
          `Slack: ${message.text.replace(/\s+/g, ' ').slice(0, 60)}`,
        );
        await this.db.run(
          sql`INSERT INTO channel_threads VALUES (${this.adapter.name}, ${message.threadKey}, ${threadId}, ${Date.now()}) ON CONFLICT DO NOTHING`,
        );
        threadId = (await this.threadFor(message.threadKey))!;
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
