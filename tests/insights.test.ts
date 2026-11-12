import { afterEach, expect, it, vi } from 'vitest';
import { EventType, type BaseEvent } from '@ag-ui/core';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { inspectRun } from '../src/server/conversations/inspect.js';
import { monthStart } from '../src/server/usage-store.js';
import { runTokens } from '../src/server/engine/thread-runner.js';
import { chatTurn } from './fixtures/chat.js';
import { testWorkspace } from './fixtures/db.js';
import type {
  AuditEntry,
  RunDetail,
  RunSummary,
  UsageReport,
} from '../src/shared/insight-types.js';

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
  cleanup.push(() => platform.stop());
  return { app, platform, workspace };
}
const json = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
/** A streamed answer whose last chunk reports token usage. */
function usageStream(reply: string, prompt: number, completion: number) {
  const chunk = (body: object) => `data: ${JSON.stringify(body)}\n\n`;
  const base = {
    id: 'c',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'custom-model',
  };
  return new Response(
    chunk({
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: 'assistant', content: reply },
          finish_reason: null,
        },
      ],
    }) +
      chunk({
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      }) +
      chunk({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
        },
      }) +
      'data: [DONE]\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
function fakeModel(reply: string, prompt = 1200, completion = 300) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        stream?: boolean;
      };
      if (body.stream) return usageStream(reply, prompt, completion);
      return Response.json({ choices: [{ message: { content: 'Named' } }] });
    });
}

it('inspects runs, meters tokens per Dot and stops a Dot at its monthly cap', async () => {
  const { app, workspace, platform } = await start();
  fakeModel('Hello there');
  const dot = (await workspace.dots())[0];
  const created = await app.request(
    '/api/conversations',
    json({ dotId: dot.id, title: 'Thread' }),
  );
  const { id: threadId } = (await created.json()) as { id: string };
  const run = await chatTurn(app, platform, threadId, 'Say hello');
  expect(run.text).toContain('Hello there');

  await vi.waitFor(async () => {
    const runs = (await (
      await app.request('/api/runs')
    ).json()) as RunSummary[];
    expect(runs[0]).toMatchObject({
      id: run.runId,
      threadId,
      agentId: dot.id,
      status: 'finished',
      inputTokens: 1200,
      outputTokens: 300,
      prompt: 'Say hello',
    });
  });
  const detail = (await (
    await app.request(`/api/runs/${run.runId}`)
  ).json()) as RunDetail;
  expect(detail.steps.map((step) => step.kind)).toEqual([
    'prompt',
    'message',
    'finished',
  ]);
  expect(detail.steps[1]).toMatchObject({ text: 'Hello there' });
  expect(detail.steps.every((step) => step.at > 0)).toBe(true);
  expect((await app.request('/api/runs/missing')).status).toBe(404);

  const usage = (await (await app.request('/api/usage')).json()) as UsageReport;
  expect(usage.dots).toEqual([
    expect.objectContaining({
      dotId: dot.id,
      inputTokens: 1200,
      outputTokens: 300,
      runs: 1,
      capReached: false,
    }),
  ]);
  expect(usage.daily).toHaveLength(1);

  // A cap at or below this month's usage stops new turns with a clear reason.
  const updated = await app.request(
    `/api/dots/${dot.id}`,
    json(
      {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        monthlyTokenCap: 1500,
      },
      'PUT',
    ),
  );
  expect(await updated.json()).toMatchObject({ monthlyTokenCap: 1500 });
  const blocked = await chatTurn(app, platform, threadId, 'Again');
  expect(blocked.error).toContain('reached its monthly limit of 1,500 tokens');
  const capped = (await (
    await app.request('/api/usage')
  ).json()) as UsageReport;
  expect(capped.dots[0]).toMatchObject({
    capReached: true,
    monthlyTokenCap: 1500,
  });

  // Removing the cap lets the Dot answer again.
  await app.request(
    `/api/dots/${dot.id}`,
    json(
      {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: dot.researchAllowed,
        memoryAllowed: dot.memoryAllowed,
        monthlyTokenCap: null,
      },
      'PUT',
    ),
  );
  const again = await chatTurn(app, platform, threadId, 'Again');
  expect(again.text).toContain('Hello there');
});

it('rejects caps below a thousand tokens', async () => {
  const { app, workspace } = await start();
  const dot = (await workspace.dots())[0];
  const response = await app.request(
    `/api/dots/${dot.id}`,
    json(
      {
        name: dot.name,
        instructions: dot.instructions,
        researchAllowed: true,
        memoryAllowed: true,
        monthlyTokenCap: 10,
      },
      'PUT',
    ),
  );
  expect(response.status).toBe(400);
});

it('counts usage per UTC calendar month', async () => {
  const { workspace } = await testWorkspace();
  const dot = (await workspace.dots())[0];
  const now = Date.UTC(2026, 10, 10, 12);
  await workspace.usage.record({
    runId: 'old',
    threadId: 't',
    dotId: dot.id,
    inputTokens: 900,
    outputTokens: 100,
    at: Date.UTC(2026, 9, 31, 23, 59),
  });
  await workspace.usage.record({
    runId: 'new',
    threadId: 't',
    dotId: dot.id,
    inputTokens: 40,
    outputTokens: 2,
    at: monthStart(now),
  });
  // A resumed run adds to its own row.
  await workspace.usage.record({
    runId: 'new',
    threadId: 't',
    dotId: dot.id,
    inputTokens: 10,
    outputTokens: 0,
    at: now,
  });
  expect(await workspace.usage.monthTokens(dot.id, now)).toBe(52);
  expect(
    (await workspace.usage.report(await workspace.dots(), 30, now)).month,
  ).toBe('2026-11');
});

it('lists every outside action in one audit trail', async () => {
  const { app, workspace } = await start();
  const dot = (await workspace.dots())[0];
  const account = await workspace.accounts.create(
    workspace.ownerId,
    {
      connector: 'mcp',
      name: 'Tickets',
      config: { url: 'https://tickets.invalid/mcp' },
    },
    [],
  );
  await workspace.actions.claimAction({
    threadId: 'thread',
    toolCallId: 'call-1',
    approvalId: 'approval',
    accountId: account.id,
    dotId: dot.id,
    tool: 'close_ticket',
  });
  await workspace.actions.finishAction('thread', 'call-1', {
    isError: false,
    text: 'ok',
  });
  const read = await workspace.usage.beginAction({
    dotId: dot.id,
    threadId: 'thread',
    kind: 'mcp',
    target: 'Tickets',
    action: 'list_tickets',
    readOnly: true,
  });
  await workspace.usage.finishAction(read, 'succeeded');
  const send = await workspace.usage.beginAction({
    dotId: dot.id,
    kind: 'app',
    target: 'gmail',
    action: 'GMAIL_SEND_EMAIL',
  });
  await workspace.usage.finishAction(send, 'failed');
  const computer = await workspace.computers.begin(dot.id, 'shell', 'agent');
  await workspace.computers.finish(computer, 'succeeded');

  const all = (await (await app.request('/api/audit')).json()) as AuditEntry[];
  expect(all).toHaveLength(4);
  expect(all).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'mcp',
        target: 'Tickets',
        action: 'close_ticket',
        approved: true,
        outcome: 'succeeded',
      }),
      expect.objectContaining({
        kind: 'mcp',
        action: 'list_tickets',
        approved: false,
      }),
      expect.objectContaining({
        kind: 'app',
        target: 'gmail',
        outcome: 'failed',
      }),
      expect.objectContaining({
        kind: 'computer',
        action: 'shell',
        actor: 'agent',
      }),
    ]),
  );
  const changes = (await (
    await app.request('/api/audit?changes=1')
  ).json()) as AuditEntry[];
  expect(changes.map((entry) => entry.action).sort()).toEqual([
    'GMAIL_SEND_EMAIL',
    'close_ticket',
    'shell',
  ]);
});

it('builds an inspector timeline from tool calls, approvals and errors', () => {
  const events = [
    {
      type: EventType.RUN_STARTED,
      timestamp: 1,
      input: {
        messages: [
          { id: 'scheduled-task-1', role: 'user', content: 'Check tickets' },
          {
            id: 't',
            role: 'tool',
            toolCallId: 'a1',
            content: '{"approved":true}',
          },
        ],
      },
    },
    {
      type: EventType.TOOL_CALL_START,
      timestamp: 2,
      toolCallId: 'c1',
      toolCallName: 'tickets__list',
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      timestamp: 2,
      toolCallId: 'c1',
      delta: '{"q":1}',
    },
    { type: EventType.TOOL_CALL_END, timestamp: 3, toolCallId: 'c1' },
    {
      type: EventType.TOOL_CALL_RESULT,
      timestamp: 5,
      toolCallId: 'c1',
      messageId: 'm',
      content: '[]',
    },
    {
      type: EventType.TOOL_CALL_START,
      timestamp: 6,
      toolCallId: 'c2',
      toolCallName: 'request_connection_action',
    },
    { type: EventType.RUN_ERROR, timestamp: 7, message: 'boom' },
  ] as unknown as BaseEvent[];
  const steps = inspectRun(events);
  expect(steps[0]).toMatchObject({ kind: 'prompt', text: 'Check tickets' });
  expect(steps[1]).toMatchObject({ kind: 'decision', toolCallId: 'a1' });
  expect(steps[2]).toMatchObject({
    kind: 'tool',
    name: 'tickets__list',
    args: '{"q":1}',
    result: '[]',
    at: 2,
    endedAt: 5,
    approval: false,
  });
  expect(steps[3]).toMatchObject({
    kind: 'tool',
    approval: true,
    result: null,
  });
  expect(steps[4]).toMatchObject({ kind: 'error', message: 'boom' });
  expect(
    runTokens([
      {
        type: EventType.RUN_FINISHED,
        usage: [
          { model: 'a', inputTokens: 3, outputTokens: 1 },
          { model: 'b', inputTokens: 2 },
        ],
      } as unknown as BaseEvent,
    ]),
  ).toEqual({ inputTokens: 5, outputTokens: 1 });
});
