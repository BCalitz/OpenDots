import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { completion } from './fixtures/model-stream.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function start(database: string) {
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'owner');
  const platform = new Platform(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      runtimeUrl: '',
      voiceName: 'marin',
      slackUsers: [],
    },
    { databasePath: database },
  );
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
    store.close();
    workspace.close();
  };
  return { app, platform, workspace, stop };
}
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
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
const runInput = (threadId: string, runId: string, text: string) => ({
  threadId,
  runId,
  state: {},
  context: [],
  tools: [],
  forwardedProps: {},
  messages: [{ id: `user-${runId}`, role: 'user', content: text }],
});

it('chats, names, survives a restart and replays without Intelligence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-local-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'opendots.sqlite');
  fakeModel('Hello there');

  let server = start(database);
  expect(server.platform.setup()).toMatchObject({
    conversations: 'local',
    intelligence: false,
    missing: [],
  });
  const info = await (await server.app.request('/api/copilotkit/info')).json();
  expect(info.mode).toBe('sse');
  const dot = server.workspace.dots()[0];
  const created = await server.app.request(
    '/api/conversations',
    json({ dotId: dot.id, title: 'A new thought' }),
  );
  expect(created.status).toBe(201);
  const { id: threadId } = (await created.json()) as { id: string };

  const run = await server.app.request(
    `/api/copilotkit/agent/${dot.id}/run`,
    json(runInput(threadId, 'run-1', 'Say hello')),
  );
  expect(run.status).toBe(200);
  const stream = await run.text();
  expect(stream).toContain('Hello there');
  expect(stream).toContain('RUN_FINISHED');
  await vi.waitFor(() =>
    expect(server.platform.localRunner?.thread(threadId)?.name).toBe(
      'Greeting check',
    ),
  );
  expect(server.workspace.requireThread(threadId).title).toBe('Greeting check');
  await server.stop();

  server = start(database);
  const connect = await server.app.request(
    `/api/copilotkit/agent/${dot.id}/connect`,
    json({ ...runInput(threadId, 'connect-1', ''), messages: [] }),
  );
  const replay = await connect.text();
  expect(replay).toContain('Say hello');
  expect(replay).toContain('Hello there');

  // A scheduled turn lands in the same thread.
  fakeModel('Your summary');
  expect(
    await server.platform.turn(
      threadId,
      'Daily summary',
      new AbortController().signal,
      { opendotsSource: 'scheduled_task' },
    ),
  ).toBe('Your summary');
  expect(await server.platform.history(threadId)).toContain('Your summary');

  const listed = await (
    await server.app.request(`/api/copilotkit/threads?agentId=${dot.id}`)
  ).json();
  expect(listed.threads).toMatchObject([
    { id: threadId, name: 'Greeting check' },
  ]);
  const renamed = await server.app.request(
    `/api/copilotkit/threads/${threadId}`,
    {
      ...json({ agentId: dot.id, name: 'Renamed' }),
      method: 'PATCH',
    },
  );
  expect(await renamed.json()).toMatchObject({ id: threadId, name: 'Renamed' });
  await server.stop();
});

it('still asks for Intelligence when it is the chosen backend', () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    workspace.close();
  });
  const platform = new Platform(store, workspace, {
    conversationBackend: 'intelligence',
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  expect(platform.localRunner).toBeUndefined();
  expect(() => platform.requireReady()).toThrow(/CONVERSATION_BACKEND=local/);
});
