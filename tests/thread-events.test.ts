import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  applyEvent,
  compactEvents,
  reduceEvents,
  type BaseEvent,
} from '../src/shared/thread-events.js';
import { sseParser, type ChatFrame } from '../src/shared/chat-stream.js';
import {
  applyThreadEvent,
  ThreadConnection,
  type ThreadState,
} from '../src/shared/thread-client.js';

afterEach(() => vi.useRealTimers());

const e = (event: Record<string, unknown>) => event as unknown as BaseEvent;

it('rebuilds messages from the event shapes phase 1 threads stored', () => {
  // CopilotKit used one message id for a whole run, across tool calls.
  const events = [
    e({
      type: 'RUN_STARTED',
      input: { messages: [{ id: 'u1', role: 'user', content: 'Make notes' }] },
    }),
    e({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
    e({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'On it. ' }),
    e({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }),
    e({
      type: 'TOOL_CALL_START',
      toolCallId: 't1',
      toolCallName: 'create_space_page',
      parentMessageId: 'm1',
    }),
    e({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"title":' }),
    e({ type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '"Notes"}' }),
    e({ type: 'TOOL_CALL_END', toolCallId: 't1' }),
    e({
      type: 'TOOL_CALL_RESULT',
      messageId: 'r1',
      toolCallId: 't1',
      role: 'tool',
      content: '{"id":"p1"}',
    }),
    e({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
    e({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Done.' }),
    e({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm2', delta: 'Chunked' }),
    e({ type: 'RUN_FINISHED' }),
  ];
  expect(reduceEvents(events)).toEqual([
    { id: 'u1', role: 'user', content: 'Make notes' },
    {
      id: 'm1',
      role: 'assistant',
      content: 'On it. Done.',
      toolCalls: [
        {
          id: 't1',
          type: 'function',
          function: {
            name: 'create_space_page',
            arguments: '{"title":"Notes"}',
          },
        },
      ],
    },
    { id: 'r1', role: 'tool', toolCallId: 't1', content: '{"id":"p1"}' },
    { id: 'm2', role: 'assistant', content: 'Chunked' },
  ]);
  // Compaction changes the events, not the messages they build.
  const compacted = compactEvents(events);
  expect(compacted.length).toBeLessThan(events.length);
  expect(reduceEvents(compacted)).toEqual(reduceEvents(events));
});

it('never mutates the list it was given and ignores repeated events', () => {
  const start = [{ id: 'u1', role: 'user' as const, content: 'Hi' }];
  const frozen = Object.freeze([...start]) as unknown as typeof start;
  const started = e({
    type: 'RUN_STARTED',
    input: { messages: start },
  });
  expect(applyEvent(frozen, started)).toBe(frozen);
  const result = e({
    type: 'TOOL_CALL_RESULT',
    toolCallId: 'x',
    messageId: 'r',
    content: 'ok',
  });
  const once = applyEvent(frozen, result);
  expect(applyEvent(once, result)).toBe(once);
  expect(frozen).toHaveLength(1);
});

it('parses SSE frames split anywhere, skipping comments and bad data', () => {
  const parse = sseParser();
  const frames: ChatFrame[] = [];
  const body =
    ': ping\n\n' +
    'data: {"kind":"event","event":{"type":"RUN_STARTED"}}\n\n' +
    'data: not json\n\n' +
    'data: {"kind":"ready","running":true}\r\n\r\n';
  for (let i = 0; i < body.length; i += 7)
    frames.push(...parse(body.slice(i, i + 7)));
  expect(frames).toEqual([
    { kind: 'event', event: { type: 'RUN_STARTED' } },
    { kind: 'ready', running: true },
  ]);
});

it('shows run errors only from live turns', () => {
  const empty: ThreadState = {
    messages: [],
    approvals: {},
    ready: true,
    running: false,
    runError: '',
    connectionError: '',
  };
  const failed = e({ type: 'RUN_ERROR', message: 'Model down' });
  expect(applyThreadEvent(empty, failed, false).runError).toBe('');
  const live = applyThreadEvent(empty, failed, true);
  expect(live.runError).toBe('Model down');
  expect(
    applyThreadEvent(live, e({ type: 'RUN_STARTED' }), true),
  ).toMatchObject({ runError: '', running: true });
});

/** A server that replays history, then sends what the test pushes. */
function fakeServer() {
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
  const requests: string[] = [];
  const encode = (frame: ChatFrame) =>
    new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`);
  const fetch = vi.fn(async (url: string) => {
    requests.push(url);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streams.push(controller);
        controller.enqueue(
          encode({
            kind: 'event',
            event: e({
              type: 'RUN_STARTED',
              input: {
                messages: [{ id: 'u1', role: 'user', content: 'Saved' }],
              },
            }),
          }),
        );
        controller.enqueue(
          encode({ kind: 'event', event: e({ type: 'RUN_FINISHED' }) }),
        );
        controller.enqueue(encode({ kind: 'ready', running: false }));
      },
    });
    return new Response(body);
  });
  return { fetch, streams, requests, encode };
}

it('replays history, follows live events, reconnects and keeps optimistic messages', async () => {
  const server = fakeServer();
  const states: ThreadState[] = [];
  const events: BaseEvent[] = [];
  const connection = new ThreadConnection({
    url: '/api/chat/t/events',
    headers: () => ({ Authorization: 'Bearer token' }),
    onState: (state) => states.push(state),
    onEvent: (event) => events.push(event),
    fetch: server.fetch as unknown as typeof fetch,
    retryMs: [5],
  });
  connection.start();
  await vi.waitFor(() => expect(states.at(-1)?.ready).toBe(true));
  expect(states.at(-1)?.messages.map((m) => m.content)).toEqual(['Saved']);
  // History is applied in one step, not one render per replayed event.
  expect(states.filter((state) => state.ready)).toHaveLength(1);
  expect(events).toEqual([]);

  connection.addOptimistic({ id: 'u2', role: 'user', content: 'Mine' });
  expect(states.at(-1)?.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
  server.streams[0].enqueue(
    server.encode({
      kind: 'event',
      event: e({
        type: 'RUN_STARTED',
        input: { messages: [{ id: 'u2', role: 'user', content: 'Mine' }] },
      }),
    }),
  );
  await vi.waitFor(() => expect(states.at(-1)?.running).toBe(true));
  expect(states.at(-1)?.messages.map((m) => m.id)).toEqual(['u1', 'u2']);
  expect(events.map((event) => event.type)).toEqual(['RUN_STARTED']);

  // The server drops the stream; the client reconnects and replays again.
  server.streams[0].close();
  await vi.waitFor(() => expect(server.requests).toHaveLength(2));
  await vi.waitFor(() => expect(states.at(-1)?.ready).toBe(true));
  expect(states.some((state) => state.connectionError)).toBe(true);
  expect(states.at(-1)?.connectionError).toBe('');
  connection.close();
});

it('stops retrying when the server refuses the stream', async () => {
  const fetch = vi.fn(async () =>
    Response.json({ error: 'Enter your owner access token.' }, { status: 401 }),
  );
  const states: ThreadState[] = [];
  const connection = new ThreadConnection({
    url: '/api/chat/t/events',
    headers: () => ({}),
    onState: (state) => states.push(state),
    fetch: fetch as unknown as typeof globalThis.fetch,
    retryMs: [1],
  });
  connection.start();
  await vi.waitFor(() =>
    expect(states.at(-1)?.connectionError).toBe(
      'Enter your owner access token.',
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetch).toHaveBeenCalledOnce();
  connection.close();
});

it('keeps the mobile copies of the shared chat modules identical', () => {
  // Metro wants extensionless imports; otherwise the files must match.
  const normalize = (text: string) =>
    text.replace(/(from '\.\/[a-z-]+)\.js'/g, "$1'");
  for (const name of [
    'thread-events',
    'approvals',
    'chat-stream',
    'thread-client',
    'discovery-message',
  ]) {
    const shared = readFileSync(`src/shared/${name}.ts`, 'utf8');
    const mobile = readFileSync(`mobile/src/lib/${name}.ts`, 'utf8');
    expect(normalize(mobile), name).toBe(normalize(shared));
  }
});
