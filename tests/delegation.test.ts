import { afterEach, expect, it, vi } from 'vitest';
import { testWorkspace } from './fixtures/db.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { completion } from './fixtures/model-stream.js';
import { chatTurn } from './fixtures/chat.js';
import type { RunDetail, RunSummary } from '../src/shared/insight-types.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function start() {
  const { store, workspace } = await testWorkspace();
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
  cleanup.push(async () => {
    await platform.stop();
  });
  return { app, workspace, platform };
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
  const { app, workspace, platform } = await start();
  const coordinator = (await workspace.dots())[0];
  const space = (await workspace.spaces())[0];
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
  const run = await chatTurn(app, platform, threadId, 'Check revenue growth');
  expect(run.text).toContain('Researcher found revenue grew 12%.');

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
  const delegateThread = (await workspace.delegateThread(
    threadId,
    researcher.id,
  ))!;
  expect(
    (await workspace.requireThread(delegateThread, researcher.id)).title,
  ).toMatch(/^(From Dot: How much did revenue grow\?|Named)$/);
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

it('keeps one continuing conversation per Dot', async () => {
  const { app, workspace } = await start();
  const dot = (await workspace.dots())[0];
  const first = await app.request(
    '/api/conversations',
    json({ dotId: dot.id, title: 'Hello' }),
  );
  expect(first.status).toBe(201);
  const { id } = (await first.json()) as { id: string };
  const again = await app.request(
    '/api/conversations',
    json({ dotId: dot.id }),
  );
  expect(again.status).toBe(200);
  expect(await again.json()).toMatchObject({ id, dotId: dot.id });
  const state = (await (await app.request('/api/workspace')).json()) as {
    mainConversations: Record<string, string>;
  };
  expect(state.mainConversations[dot.id]).toBe(id);
});

it('only lets a Dot direct other existing Dots', async () => {
  const { app, workspace } = await start();
  const dot = (await workspace.dots())[0];
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
  expect((await workspace.dot(dot.id))?.delegateDotIds).toEqual([]);
});
