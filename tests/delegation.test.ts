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
import type { RunDetail, RunSummary } from '../src/shared/insight-types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function start() {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-delegation-'));
  const database = join(dir, 'opendots.sqlite');
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
  cleanup.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { app, workspace };
}
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const askDot = (dot: string, request: string) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: `call-${dot}`,
          type: 'function',
          function: {
            name: 'ask_dot',
            arguments: JSON.stringify({ dot, request }),
          },
        },
      ],
    },
    'tool_calls',
  );
type Body = {
  stream?: boolean;
  tools?: { function?: { name?: string } }[];
  messages: { role: string; content?: unknown }[];
};
const system = (body: Body) =>
  body.messages
    .filter((message) => message.role === 'system')
    .map((message) => String(message.content))
    .join('\n');
const toolNames = (body: Body) =>
  (body.tools ?? []).map((tool) => tool.function?.name);
const hasToolResult = (body: Body) =>
  body.messages.some((message) => message.role === 'tool');

it('lets a coordinator Dot hand work to a specialist and use its answer', async () => {
  const { app, workspace } = start();
  const coordinator = workspace.dots()[0];
  const space = workspace.spaces()[0];
  const researcher = (await (
    await app.request(
      '/api/dots',
      json({
        spaceId: space.id,
        name: 'Researcher',
        instructions: 'Find facts and cite sources.',
        researchAllowed: false,
        memoryAllowed: false,
      }),
    )
  ).json()) as { id: string };
  const updated = await app.request(
    `/api/dots/${coordinator.id}`,
    json(
      {
        name: coordinator.name,
        instructions: coordinator.instructions,
        researchAllowed: false,
        memoryAllowed: false,
        delegateDotIds: [researcher.id],
      },
      'PUT',
    ),
  );
  expect(await updated.json()).toMatchObject({
    delegateDotIds: [researcher.id],
  });

  const seen: Body[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    if (!body.stream)
      return Response.json({ choices: [{ message: { content: 'Named' } }] });
    seen.push(body);
    if (system(body).includes('You are Researcher'))
      return completion({ role: 'assistant', content: 'Revenue grew 12%.' });
    if (!hasToolResult(body))
      return askDot('researcher', 'How much did revenue grow?');
    return completion({
      role: 'assistant',
      content: 'Researcher found revenue grew 12%.',
    });
  });

  const created = await app.request(
    '/api/conversations',
    json({ dotId: coordinator.id, title: 'Plan' }),
  );
  const { id: threadId } = (await created.json()) as { id: string };
  const run = await app.request(
    `/api/copilotkit/agent/${coordinator.id}/run`,
    json({
      threadId,
      runId: 'coord-1',
      state: {},
      context: [],
      tools: [],
      forwardedProps: {},
      messages: [{ id: 'u1', role: 'user', content: 'Check revenue growth' }],
    }),
  );
  const stream = await run.text();
  expect(stream).toContain('Researcher found revenue grew 12%.');

  // The coordinator saw ask_dot; the specialist did not, so work cannot loop.
  const coordinatorCall = seen.find((body) =>
    system(body).includes('You coordinate'),
  );
  expect(toolNames(coordinatorCall!)).toContain('ask_dot');
  const specialistCall = seen.find((body) =>
    system(body).includes('You are Researcher'),
  );
  expect(toolNames(specialistCall!)).not.toContain('ask_dot');
  expect(JSON.stringify(specialistCall!.messages)).toContain(
    `${coordinator.name}, another of the owner's Dots, asks you:\\n\\nHow much did revenue grow?`,
  );

  // The specialist's work is a normal conversation the owner can open.
  const delegateThread = workspace.delegateThread(threadId, researcher.id)!;
  expect(workspace.requireThread(delegateThread, researcher.id).title).toMatch(
    /^(From Dot: How much did revenue grow\?|Named)$/,
  );
  const runs = (await (
    await app.request(`/api/runs?dotId=${researcher.id}`)
  ).json()) as RunSummary[];
  expect(runs).toHaveLength(1);
  const detail = (await (
    await app.request(`/api/runs/${runs[0].id}`)
  ).json()) as RunDetail;
  expect(detail.steps[0]).toMatchObject({
    kind: 'prompt',
    source: 'delegation',
  });
});

it('only lets a Dot direct other existing Dots', async () => {
  const { app, workspace } = start();
  const dot = workspace.dots()[0];
  const body = (ids: string[]) =>
    json(
      {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: true,
        memoryAllowed: true,
        delegateDotIds: ids,
      },
      'PUT',
    );
  expect(
    (await app.request(`/api/dots/${dot.id}`, body([dot.id]))).status,
  ).toBe(400);
  expect(
    (await app.request(`/api/dots/${dot.id}`, body(['missing']))).status,
  ).toBe(400);
  expect(workspace.dot(dot.id)?.delegateDotIds).toEqual([]);
});
