import {
  reportChannelFailure,
  safeFailure,
  type ChannelAdapter,
  type ChannelMessage,
  type ChannelStatus,
} from './adapter.js';

/** The parts of the WebSocket API the adapter uses, for tests. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown }) => void,
  ): void;
}
type SocketFactory = (url: string) => SocketLike;

interface SlackEvent {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  team?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
}
interface Envelope {
  type?: string;
  envelope_id?: string;
  reason?: string;
  payload?: { team_id?: string; event_id?: string; event?: SlackEvent };
}

const SLACK_API = 'https://slack.com/api';
const MAX_TEXT = 39_000;
const RETRY_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/** Slack writes bold, links and headings differently from Markdown. */
export function toSlackText(markdown: string) {
  const text = markdown
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/__(.+?)__/g, '_$1_')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>');
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * Slack over Socket Mode: OpenDots opens an outbound WebSocket to Slack, so
 * a self-hosted server needs no public address. Replies use the Web API.
 * Needs an app-level token (connections:write) and a bot token
 * (app_mentions:read, chat:write, channels:history, groups:history,
 * im:history).
 */
export class SlackAdapter implements ChannelAdapter {
  readonly name = 'slack';
  private state: ChannelStatus = 'connecting';
  private socket?: SocketLike;
  private stopped = false;
  private botUserId = '';
  private attempt = 0;
  private seen = new Set<string>();
  private retryTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private options: {
      botToken: string;
      appToken: string;
      fetch?: typeof fetch;
      socket?: SocketFactory;
      retryMs?: number[];
    },
  ) {}

  status() {
    return this.state;
  }

  async start(onMessage: (message: ChannelMessage) => void) {
    this.stopped = false;
    // Fails fast on a bad bot token, and tells us which mentions are ours.
    const auth = await this.call<{ user_id?: string }>(
      'auth.test',
      this.options.botToken,
    );
    this.botUserId = auth.user_id ?? '';
    await this.connect(onMessage);
  }

  async reply(threadKey: string, text: string) {
    const [, channel, threadTs] = threadKey.split(':');
    if (!channel || !threadTs) throw new Error('Unknown Slack thread.');
    await this.call('chat.postMessage', this.options.botToken, {
      channel,
      thread_ts: threadTs,
      text: toSlackText(text),
      unfurl_links: false,
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.socket?.close();
    this.socket = undefined;
  }

  private async connect(onMessage: (message: ChannelMessage) => void) {
    try {
      const { url } = await this.call<{ url?: string }>(
        'apps.connections.open',
        this.options.appToken,
      );
      if (!url) throw new Error('Slack returned no Socket Mode address.');
      if (this.stopped) return;
      const socket = (
        this.options.socket ?? ((address) => new WebSocket(address))
      )(url);
      this.socket = socket;
      socket.addEventListener('message', ({ data }) =>
        this.receive(socket, String(data ?? ''), onMessage),
      );
      socket.addEventListener('close', () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.retry(onMessage);
      });
      socket.addEventListener('error', () => socket.close());
    } catch (error) {
      if (this.attempt === 0 && this.state === 'connecting') {
        this.state = 'activation_failed';
        throw error;
      }
      reportChannelFailure('Slack reconnect failed', [safeFailure(error)]);
      this.retry(onMessage);
    }
  }

  private retry(onMessage: (message: ChannelMessage) => void) {
    if (this.stopped) return;
    if (this.state === 'online') this.state = 'connecting';
    const delays = this.options.retryMs ?? RETRY_MS;
    const wait = delays[Math.min(this.attempt++, delays.length - 1)];
    this.retryTimer = setTimeout(() => void this.connect(onMessage), wait);
  }

  private receive(
    socket: SocketLike,
    raw: string,
    onMessage: (message: ChannelMessage) => void,
  ) {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return;
    }
    if (envelope.type === 'hello') {
      this.state = 'online';
      this.attempt = 0;
      return;
    }
    // Slack asks clients to reconnect from time to time.
    if (envelope.type === 'disconnect') {
      socket.close();
      return;
    }
    // Acknowledge first: Slack retries anything not acknowledged in 3s.
    if (envelope.envelope_id)
      socket.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
    if (envelope.type !== 'events_api') return;
    const eventId = envelope.payload?.event_id;
    if (eventId) {
      if (this.seen.has(eventId)) return;
      this.seen.add(eventId);
      if (this.seen.size > 500)
        this.seen.delete(this.seen.values().next().value!);
    }
    const message = this.message(envelope);
    if (message) onMessage(message);
  }

  /** A person's new message, or nothing for edits, bots and our own posts. */
  private message(envelope: Envelope): ChannelMessage | undefined {
    const event = envelope.payload?.event;
    if (!event?.user || !event.channel || !event.ts) return;
    if (event.bot_id || event.subtype || event.user === this.botUserId) return;
    const mention = this.botUserId ? `<@${this.botUserId}>` : '';
    const direct = event.channel_type === 'im';
    if (event.type !== 'app_mention' && event.type !== 'message') return;
    // A mention in a channel also arrives as app_mention; answer it once.
    if (
      event.type === 'message' &&
      !direct &&
      mention &&
      event.text?.includes(mention)
    )
      return;
    const raw = event.text ?? '';
    const text = (mention ? raw.replaceAll(mention, '') : raw).trim();
    if (!text) return;
    const tenantId = envelope.payload?.team_id ?? event.team ?? '';
    return {
      threadKey: `${tenantId}:${event.channel}:${event.thread_ts ?? event.ts}`,
      tenantId,
      userId: event.user,
      text,
      addressed: event.type === 'app_mention' || direct,
    };
  }

  private async call<T>(
    method: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const response = await (this.options.fetch ?? fetch)(
      `${SLACK_API}/${method}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(body ?? {}),
      },
    );
    const data = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
    } & T;
    if (!response.ok || !data.ok)
      throw Object.assign(
        // Slack error codes (invalid_auth, not_in_channel) hold no secrets.
        new Error(`Slack ${method} failed: ${data.error ?? 'unknown_error'}`),
        { status: response.status },
      );
    return data;
  }
}
