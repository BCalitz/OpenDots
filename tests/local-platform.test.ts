import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import type { Db } from '../src/server/db/index.js';
import { testDb } from './fixtures/db.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  ThreadConnection,
  type ThreadState,
} from '../src/shared/thread-client.js';
import { completion } from './fixtures/model-stream.js';
import { chatTurn, json } from './fixtures/chat.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A server on `db`; a second start on the same db is a restart. */
async function start(db: Db) {
  const store = new Store(db);
  const workspace = await WorkspaceStore.open(db, 'owner');
  const platform = await Platform.create(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackUsers: [],
  });
  const config = {
    mode: 'live' as const,
    baseUrl: 'https://unused.invalid/v1',
  };
  const app = createApp({
    store,
    runner: new Runner(store, config),
    config,
    platform,
  });
  const stop = async () => {
    await platform.stop();
  };
  return { app, platform, workspace, store, stop };
}
/** Model replies stream; the naming call gets a plain completion. */
function fakeModel(reply: string) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
      };
      if (body.stream) return completion({ role: 'assistant', content: reply });
      return Response.json({
        choices: [{ message: { content: 'Greeting check' } }],
      });
    });
}
/** The shared web/mobile client, talking to the app in-process. */
function connect(
  app: Awaited<ReturnType<typeof start>>['app'],
  threadId: string,
) {
  const states: ThreadState[] = [];
  const connection = new ThreadConnection({
    url: `http://localhost/api/chat/${threadId}/events`,
    headers: () => ({}),
    onState: (state) => states.push(state),
    fetch: ((url: string, init?: RequestInit) =>
      app.request(url, init)) as typeof fetch,
    retryMs: [10],
  });
  connection.start();
  cleanup.push(() => connection.close());
  return { connection, states, latest: () => states.at(-1) };
}

it('chats over /api/chat, names the thread, survives a restart and replays', async () => {
  const database = await testDb();
  fakeModel('Hello there');
  let server = await start(database);
  expect(server.platform.setup()).toMatchObject({ missing: [] });
  const dot = (await server.workspace.dots())[0];
  const created = await server.app.request(
    '/api/conversations',
    json({ dotId: dot.id, title: 'A new thought' }),
  );
  expect(created.status).toBe(201);
  const { id: threadId } = (await created.json()) as { id: string };

  const turn = await chatTurn(
    server.app,
    server.platform,
    threadId,
    'Say hello',
  );
  expect(turn.status).toBe(202);
  expect(turn.text).toBe('Hello there');
  await vi.waitFor(async () =>
    expect((await server.platform.runner?.thread(threadId))?.name).toBe(
      'Greeting check',
    ),
  );
  await vi.waitFor(async () =>
    expect((await server.workspace.requireThread(threadId)).title).toBe(
      'Greeting check',
    ),
  );
  await server.stop();

  server = await start(database);
  const client = connect(server.app, threadId);
  await vi.waitFor(() => expect(client.latest()?.ready).toBe(true));
  expect(client.latest()?.messages.map((m) => m.content)).toEqual([
    'Say hello',
    'Hello there',
  ]);

  // A scheduled turn lands in the same thread and reaches an open client live.
  fakeModel('Your summary');
  expect(
    await server.platform.turn(
      threadId,
      'Daily summary',
      new AbortController().signal,
      { opendotsSource: 'scheduled_task' },
    ),
  ).toBe('Your summary');
  await vi.waitFor(() =>
    expect(client.latest()?.messages.at(-1)?.content).toBe('Your summary'),
  );
  expect(await server.platform.history(threadId)).toContain('Your summary');
  client.connection.close();
  await server.stop();
});

it('refuses a second message while answering, and stops on request', async () => {
  const server = await start(await testDb());
  cleanup.push(server.stop);
  const network = vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener(
            'abort',
            () => reject(init.signal?.reason),
            { once: true },
          ),
        ),
    );
  const dot = (await server.workspace.dots())[0];
  const { conversation } = await server.platform.dotConversation(dot.id);
  const client = connect(server.app, conversation.id);
  await vi.waitFor(() => expect(client.latest()?.ready).toBe(true));
  const first = await server.app.request(
    `/api/chat/${conversation.id}/messages`,
    json({ id: 'mine-1', content: 'Take your time' }),
  );
  expect(first.status).toBe(202);
  await vi.waitFor(() => expect(network).toHaveBeenCalled());
  await vi.waitFor(() => expect(client.latest()?.running).toBe(true));
  const second = await server.app.request(
    `/api/chat/${conversation.id}/messages`,
    json({ content: 'Hurry' }),
  );
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ code: 'thread_locked' });

  const stop = await server.app.request(
    `/api/chat/${conversation.id}/stop`,
    json({}),
  );
  expect(await stop.json()).toEqual({ stopped: true });
  await vi.waitFor(() => expect(client.latest()?.running).toBe(false));
  expect(client.latest()?.runError).toBe('');
  expect(client.latest()?.messages.map((m) => m.id)).toEqual(['mine-1']);
});

it('validates messages and refuses to chat while paused', async () => {
  const server = await start(await testDb());
  cleanup.push(server.stop);
  const dot = (await server.workspace.dots())[0];
  const { conversation } = await server.platform.dotConversation(dot.id);
  const path = `/api/chat/${conversation.id}/messages`;
  expect((await server.app.request(path, json({ content: '' }))).status).toBe(
    400,
  );
  expect(
    (await server.app.request(path, json({ content: 'x'.repeat(20_001) })))
      .status,
  ).toBe(400);
  expect(
    (await server.app.request(path, json({ content: 'Hi', role: 'system' })))
      .status,
  ).toBe(400);
  expect(
    (
      await server.app.request(
        '/api/chat/missing/messages',
        json({ content: 'Hi' }),
      )
    ).status,
  ).toBe(404);
  expect((await server.app.request('/api/chat/missing/events')).status).toBe(
    404,
  );
  await server.store.updateSettings({ paused: true });
  const paused = await server.app.request(path, json({ content: 'Hi' }));
  expect(paused.status).toBe(409);
  expect(await paused.json()).toMatchObject({ code: 'paused' });
});

it('answers Slack through the engine in a background thread of its own', async () => {
  const db = await testDb();
  const store = new Store(db);
  const workspace = await WorkspaceStore.open(db, 'owner');
  const platform = await Platform.create(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    voiceName: 'marin',
    slackBotToken: 'xoxb-fixture',
    slackAppToken: 'xapp-fixture',
    slackTeam: 'T1',
    slackUsers: ['U1'],
  });
  cleanup.push(() => platform.stop());
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (String(url).endsWith('/chat.postMessage')) {
      posted.push(body);
      return Response.json({ ok: true });
    }
    if (body.stream)
      return completion({ role: 'assistant', content: 'Here is **today**.' });
    return Response.json({ choices: [{ message: { content: 'Named' } }] });
  });
  expect(platform.setup().slack).toBe('connecting');
  await platform.channel!.receive({
    threadKey: 'T1:C1:100.1',
    tenantId: 'T1',
    userId: 'U1',
    text: 'What is on today?',
    addressed: true,
  });
  expect(posted).toEqual([
    expect.objectContaining({
      channel: 'C1',
      thread_ts: '100.1',
      text: 'Here is *today*.',
    }),
  ]);
  const threadId = (await platform.channel!.threadFor('T1:C1:100.1'))!;
  expect(await workspace.requireThread(threadId)).toMatchObject({
    source: 'slack',
  });
  // A Slack thread never becomes the Dot's main chat.
  expect(
    await workspace.mainConversation((await workspace.dots())[0].id),
  ).toBeUndefined();
  expect((await platform.runner.listRuns())[0]).toMatchObject({ threadId });
});
