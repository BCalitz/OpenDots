/**
 * A chat surface outside OpenDots (Slack today; Teams or WhatsApp later)
 * that people can talk to a Dot through. An adapter only moves messages;
 * ChannelService decides who may talk, which thread a message belongs to,
 * and runs the turn on the engine.
 */
export interface ChannelMessage {
  /** One conversation on the channel; maps to one OpenDots thread. */
  threadKey: string;
  /** The workspace or tenant the message came from. */
  tenantId: string;
  /** Who sent it, as the channel identifies them. */
  userId: string;
  /** The text, with the mention of the bot removed. */
  text: string;
  /** The message addressed the bot (a mention or a direct message). */
  addressed: boolean;
}

export type ChannelStatus =
  | 'not_configured'
  | 'setup_required'
  | 'connecting'
  | 'online'
  | 'activation_failed';

export interface ChannelAdapter {
  readonly name: string;
  status(): ChannelStatus;
  /** Connects and calls `onMessage` for each new message from a person. */
  start(onMessage: (message: ChannelMessage) => void): Promise<void>;
  /** Posts a reply in the conversation a message came from. */
  reply(threadKey: string, text: string): Promise<void>;
  stop(): Promise<void>;
}

type Report = (operation: string, errors: string[]) => void;

// Never pass provider messages or stacks to logs or chat: they can contain
// credentials.
export function safeFailure(error: unknown): string {
  const name =
    error instanceof Error &&
    ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
      ? error.name
      : 'Error';
  const status =
    error !== null && typeof error === 'object' && 'status' in error
      ? error.status
      : undefined;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? `${name} (HTTP ${status})`
    : name;
}
export const reportChannelFailure: Report = (operation, errors) =>
  console.error(`${operation}: ${errors.join('; ')}`);
