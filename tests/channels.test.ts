import { afterEach, expect, it, vi } from 'vitest';
import {
  SlackAdapter,
  toSlackText,
  type SocketLike,
} from '../src/server/channels/slack.js';
import {
  ChannelService,
  FAILED_NOTICE,
  PAUSED_NOTICE,
} from '../src/server/channels/service.js';
import type {
  ChannelAdapter,
  ChannelMessage,
  ChannelStatus,
} from '../src/server/channels/adapter.js';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

class FakeSocket implements SocketLike {
  sent: unknown[] = [];
  closed = false;
  private listeners = new Map<
    string,
    ((event: { data?: unknown }) => void)[]
  >();
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
  addEventListener(
    type: string,
    listener: (event: { data?: unknown }) => void,
  ) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown) {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ data: data === undefined ? undefined : JSON.stringify(data) });
  }
}

function slack(options: { authOk?: boolean } = {}) {
  const sockets: FakeSocket[] = [];
  const calls: {
    method: string;
    token: string;
    body: Record<string, unknown>;
  }[] = [];
  const fetch = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split('/').pop()!;
      const token = String(
        (init?.headers as Record<string, string>).Authorization,
      ).replace('Bearer ', '');
      calls.push({
        method,
        token,
        body: JSON.parse(String(init?.body ?? '{}')),
      });
      if (method === 'auth.test')
        return Response.json(
          options.authOk === false
            ? { ok: false, error: 'invalid_auth' }
            : { ok: true, user_id: 'UBOT' },
        );
      if (method === 'apps.connections.open')
        return Response.json({
          ok: true,
          url: `wss://slack.test/${sockets.length}`,
        });
      return Response.json({ ok: true });
    },
  );
  const adapter = new SlackAdapter({
    botToken: 'xoxb-bot',
    appToken: 'xapp-app',
    fetch: fetch as unknown as typeof globalThis.fetch,
    socket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    retryMs: [1],
  });
  cleanup.push(() => adapter.stop());
  return { adapter, sockets, calls };
}
const envelope = (id: string, event: Record<string, unknown>) => ({
  type: 'events_api',
  envelope_id: `env-${id}`,
  payload: { team_id: 'T1', event_id: `ev-${id}`, event },
});

it('connects over Socket Mode, acknowledges events and passes on people’s new messages', async () => {
  const { adapter, sockets, calls } = slack();
  const received: ChannelMessage[] = [];
  await adapter.start((message) => received.push(message));
  expect(calls.map((call) => [call.method, call.token])).toEqual([
    ['auth.test', 'xoxb-bot'],
    ['apps.connections.open', 'xapp-app'],
  ]);
  expect(adapter.status()).toBe('connecting');
  const socket = sockets[0];
  socket.emit('message', { type: 'hello' });
  expect(adapter.status()).toBe('online');

  socket.emit(
    'message',
    envelope('1', {
      type: 'app_mention',
      user: 'U1',
      text: '<@UBOT> what is on today?',
      channel: 'C1',
      ts: '100.1',
    }),
  );
  // The same mention also arrives as a channel message; it is answered once.
  socket.emit(
    'message',
    envelope('2', {
      type: 'message',
      user: 'U1',
      text: '<@UBOT> what is on today?',
      channel: 'C1',
      ts: '100.1',
    }),
  );
  // Retries, edits, bots and our own posts are ignored.
  socket.emit(
    'message',
    envelope('1', {
      type: 'app_mention',
      user: 'U1',
      text: '<@UBOT> again',
      channel: 'C1',
      ts: '100.1',
    }),
  );
  socket.emit(
    'message',
    envelope('3', {
      type: 'message',
      subtype: 'message_changed',
      user: 'U1',
      text: 'edit',
      channel: 'C1',
      ts: '100.2',
    }),
  );
  socket.emit(
    'message',
    envelope('4', {
      type: 'message',
      bot_id: 'B1',
      user: 'U2',
      text: 'bot',
      channel: 'C1',
      ts: '100.3',
    }),
  );
  socket.emit(
    'message',
    envelope('5', {
      type: 'message',
      user: 'UBOT',
      text: 'mine',
      channel: 'C1',
      ts: '100.4',
    }),
  );
  // A reply in the thread, and a direct message.
  socket.emit(
    'message',
    envelope('6', {
      type: 'message',
      user: 'U1',
      text: 'and tomorrow?',
      channel: 'C1',
      ts: '100.5',
      thread_ts: '100.1',
    }),
  );
  socket.emit(
    'message',
    envelope('7', {
      type: 'message',
      channel_type: 'im',
      user: 'U1',
      text: 'hi',
      channel: 'D1',
      ts: '200.1',
    }),
  );

  expect(socket.sent).toContainEqual({ envelope_id: 'env-1' });
  expect(received).toEqual([
    {
      threadKey: 'T1:C1:100.1',
      tenantId: 'T1',
      userId: 'U1',
      text: 'what is on today?',
      addressed: true,
    },
    {
      threadKey: 'T1:C1:100.1',
      tenantId: 'T1',
      userId: 'U1',
      text: 'and tomorrow?',
      addressed: false,
    },
    {
      threadKey: 'T1:D1:200.1',
      tenantId: 'T1',
      userId: 'U1',
      text: 'hi',
      addressed: true,
    },
  ]);

  await adapter.reply('T1:C1:100.1', 'See **this** [doc](https://example.com)');
  expect(calls.at(-1)).toEqual({
    method: 'chat.postMessage',
    token: 'xoxb-bot',
    body: {
      channel: 'C1',
      thread_ts: '100.1',
      text: 'See *this* <https://example.com|doc>',
      unfurl_links: false,
    },
  });
});

it('reconnects when Slack asks, and reports a bad token at start', async () => {
  const { adapter, sockets } = slack();
  await adapter.start(() => {});
  sockets[0].emit('message', { type: 'hello' });
  sockets[0].emit('message', {
    type: 'disconnect',
    reason: 'refresh_requested',
  });
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  sockets[1].emit('message', { type: 'hello' });
  expect(adapter.status()).toBe('online');

  const bad = slack({ authOk: false });
  await expect(bad.adapter.start(() => {})).rejects.toThrow('invalid_auth');
});

it('formats Markdown for Slack and keeps replies under its limit', () => {
  expect(toSlackText('# Plan\n**Bold** and __it__')).toBe(
    '*Plan*\n*Bold* and _it_',
  );
  expect(toSlackText('x'.repeat(50_000)).length).toBeLessThanOrEqual(39_001);
});

/** An adapter the test drives by hand. */
function fakeAdapter() {
  const replies: [string, string][] = [];
  const adapter: ChannelAdapter = {
    name: 'slack',
    status: (): ChannelStatus => 'online',
    start: async () => {},
    reply: async (threadKey, text) => {
      replies.push([threadKey, text]);
    },
    stop: async () => {},
  };
  return { adapter, replies };
}
const msg = (overrides: Partial<ChannelMessage> = {}): ChannelMessage => ({
  threadKey: 'T1:C1:1',
  tenantId: 'T1',
  userId: 'U1',
  text: 'Hello',
  addressed: true,
  ...overrides,
});

it('answers allowlisted people, one OpenDots thread per channel thread', async () => {
  const { adapter, replies } = fakeAdapter();
  let paused = false;
  const created: string[] = [];
  const turns: [string, string][] = [];
  const service = new ChannelService(adapter, {
    database: ':memory:',
    tenantId: 'T1',
    userIds: ['U1'],
    dotId: 'dot',
    paused: () => paused,
    createThread: async (_dotId, title) => {
      created.push(title);
      return `thread-${created.length}`;
    },
    turn: async (threadId, prompt) => {
      turns.push([threadId, prompt]);
      if (prompt === 'explode') throw new Error('secret token sk-123 leaked');
      return `Reply to ${prompt}`;
    },
  });
  cleanup.push(() => service.stop());

  await service.receive(msg({ userId: 'U2' }));
  await service.receive(msg({ tenantId: 'T2' }));
  await service.receive(msg({ addressed: false }));
  expect(turns).toEqual([]);

  await service.receive(msg());
  await service.receive(msg({ text: 'More', addressed: false }));
  await service.receive(msg({ threadKey: 'T1:C1:2', text: 'Other' }));
  expect(created).toEqual(['Slack: Hello', 'Slack: Other']);
  expect(turns).toEqual([
    ['thread-1', 'Hello'],
    ['thread-1', 'More'],
    ['thread-2', 'Other'],
  ]);
  expect(replies.slice(0, 3)).toEqual([
    ['T1:C1:1', 'Reply to Hello'],
    ['T1:C1:1', 'Reply to More'],
    ['T1:C1:2', 'Reply to Other'],
  ]);

  await service.receive(msg({ text: 'explode' }));
  expect(replies.at(-1)).toEqual(['T1:C1:1', FAILED_NOTICE]);
  paused = true;
  await service.receive(msg({ text: 'Still there?' }));
  expect(replies.at(-1)).toEqual(['T1:C1:1', PAUSED_NOTICE]);
  expect(turns).toHaveLength(4);
});

it('runs turns in one channel thread in order', async () => {
  const { adapter, replies } = fakeAdapter();
  const order: string[] = [];
  const service = new ChannelService(adapter, {
    database: ':memory:',
    tenantId: 'T1',
    userIds: ['U1'],
    dotId: 'dot',
    paused: () => false,
    createThread: async () => 'thread',
    turn: async (_threadId, prompt) => {
      order.push(`start ${prompt}`);
      await new Promise((resolve) =>
        setTimeout(resolve, prompt === 'first' ? 20 : 1),
      );
      order.push(`end ${prompt}`);
      return prompt;
    },
  });
  cleanup.push(() => service.stop());
  await Promise.all([
    service.receive(msg({ text: 'first' })),
    service.receive(msg({ text: 'second', addressed: false })),
  ]);
  expect(order).toEqual([
    'start first',
    'end first',
    'start second',
    'end second',
  ]);
  expect(replies.map(([, text]) => text)).toEqual(['first', 'second']);
});
