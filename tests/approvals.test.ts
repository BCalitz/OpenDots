import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import { Approvals } from '../src/server/engine/approvals.js';
import { detachedContext } from '../src/server/engine/tools.js';
import { approvalsFrom, type ApprovalView } from '../src/shared/approvals.js';
import type { BaseEvent } from '../src/shared/thread-events.js';
import { completion } from './fixtures/model-stream.js';
import { json } from './fixtures/chat.js';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function start(database = ':memory:', timeout?: number) {
  const store = new Store(database);
  const workspace = new WorkspaceStore(database, 'owner');
  const platform = new Platform(
    store,
    workspace,
    {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
      slackUsers: [],
      ...(timeout ? { agentRunTimeoutMs: timeout } : {}),
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
  cleanup.push(stop);
  return { app, platform, workspace, store, stop };
}

const reviewCall = (spaceId: string) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'review-1',
          type: 'function',
          function: {
            name: 'review_space_page',
            arguments: JSON.stringify({
              title: 'Plan',
              content: '# Plan',
              spaceId,
            }),
          },
        },
      ],
    },
    'tool_calls',
  );
/** Starts a chat turn whose model asks to save a reviewed page. */
async function reviewTurn(server: ReturnType<typeof start>) {
  const dot = server.workspace.dots()[0];
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (!body.stream)
      return Response.json({ choices: [{ message: { content: 'Named' } }] });
    bodies.push(body);
    return bodies.length === 1
      ? reviewCall(dot.spaceId)
      : completion({ role: 'assistant', content: 'Done.' });
  });
  const { conversation } = await server.platform.dotConversation(dot.id);
  const events: BaseEvent[] = [];
  const view = server.platform.engine!.watch(conversation.id, (event) =>
    events.push(event),
  );
  cleanup.push(view.unsubscribe);
  const sent = await server.app.request(
    `/api/chat/${conversation.id}/messages`,
    json({ content: 'Draft a plan for me to review' }),
  );
  expect(sent.status).toBe(202);
  const pending = async () => {
    let found: ApprovalView | undefined;
    await vi.waitFor(() => {
      found = approvalsFrom(events).get('review-1');
      expect(found?.status).toBe('pending');
    });
    return found!;
  };
  return { dot, conversation, events, bodies, pending };
}
const decide = (
  server: ReturnType<typeof start>,
  id: string,
  approved: boolean,
) => server.app.request(`/api/chat/approvals/${id}`, json({ approved }));

it('saves a reviewed page only after the owner approves, then continues the turn', async () => {
  const server = start();
  const turn = await reviewTurn(server);
  const approval = await turn.pending();
  expect(approval.payload).toEqual({
    title: 'Plan',
    content: '# Plan',
    spaceId: turn.dot.spaceId,
  });
  expect(server.workspace.pages.list(turn.dot.spaceId)).toHaveLength(0);
  const listed = await server.app.request(
    `/api/chat/${turn.conversation.id}/approvals`,
  );
  expect(await listed.json()).toEqual([
    expect.objectContaining({ id: approval.id }),
  ]);

  const decided = await decide(server, approval.id, true);
  expect(await decided.json()).toMatchObject({ status: 'approved' });
  await server.platform.runner!.done(turn.conversation.id);
  const pages = server.workspace.pages.list(turn.dot.spaceId);
  expect(pages).toEqual([expect.objectContaining({ title: 'Plan' })]);
  // The model got the saved page back and finished its answer.
  expect(JSON.stringify(turn.bodies[1].messages)).toContain(pages[0].id);
  expect(approvalsFrom(turn.events).get('review-1')?.status).toBe('approved');
  // A second decision is refused.
  const again = await decide(server, approval.id, true);
  expect(again.status).toBe(409);
});

it('saves nothing when the owner declines', async () => {
  const server = start();
  const turn = await reviewTurn(server);
  const approval = await turn.pending();
  await decide(server, approval.id, false);
  await server.platform.runner!.done(turn.conversation.id);
  expect(server.workspace.pages.list(turn.dot.spaceId)).toHaveLength(0);
  expect(JSON.stringify(turn.bodies[1].messages)).toContain('declined');
});

it('closes a waiting approval when the owner stops the turn', async () => {
  const server = start();
  const turn = await reviewTurn(server);
  const approval = await turn.pending();
  await server.app.request(`/api/chat/${turn.conversation.id}/stop`, json({}));
  await vi.waitFor(() =>
    expect(server.platform.runner!.isRunning(turn.conversation.id)).toBe(false),
  );
  expect((await decide(server, approval.id, true)).status).toBe(409);
  expect(server.workspace.pages.list(turn.dot.spaceId)).toHaveLength(0);
  expect(approvalsFrom(turn.events).get('review-1')?.status).toBe('expired');
});

it('does not count time spent waiting for the owner toward the turn limit', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const server = start(':memory:', 5_000);
  const turn = await reviewTurn(server);
  const approval = await turn.pending();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(server.platform.runner!.isRunning(turn.conversation.id)).toBe(true);
  await decide(server, approval.id, true);
  const run = await server.platform.runner!.done(turn.conversation.id);
  expect(run?.status).toBe('finished');
});

it('offers approvals only in chats, never to schedules', async () => {
  const server = start();
  const dot = server.workspace.dots()[0];
  const tools: string[][] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (!body.stream)
      return Response.json({ choices: [{ message: { content: 'Named' } }] });
    tools.push(
      (body.tools ?? []).map(
        (tool: { function: { name: string } }) => tool.function.name,
      ),
    );
    return completion({ role: 'assistant', content: 'Ok' });
  });
  const { conversation } = await server.platform.dotConversation(dot.id);
  await server.platform.turn(
    conversation.id,
    'Scheduled',
    AbortSignal.timeout(5000),
    {
      opendotsSource: 'scheduled_task',
    },
  );
  expect(tools[0]).not.toContain('review_space_page');
  expect(tools[0]).not.toContain('request_approval');
});

it('expires requests that were waiting when the server stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opendots-approvals-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const database = join(dir, 'opendots.sqlite');
  let approvals = new Approvals(database);
  const waiting = approvals.request(detachedContext(), {
    threadId: 'thread',
    kind: 'page_review',
    payload: {},
  });
  const [request] = approvals.pending('thread');
  expect(request.status).toBe('pending');
  approvals.close();
  await expect(waiting).resolves.toBe('expired');
  approvals = new Approvals(database);
  cleanup.push(() => approvals.close());
  expect(approvals.get(request.id)?.status).toBe('expired');
  expect(() => approvals.decide(request.id, true)).toThrow(/no longer waiting/);
});

it('gives up after the wait time and lets the turn carry on', async () => {
  vi.useFakeTimers();
  const approvals = new Approvals(':memory:', { waitMs: 1_000 });
  cleanup.push(() => approvals.close());
  const emitted: BaseEvent[] = [];
  const waiting = approvals.request(
    { ...detachedContext(), emit: (event) => emitted.push(event) },
    { threadId: 'thread', kind: 'connection_action', payload: {} },
  );
  await vi.advanceTimersByTimeAsync(1_001);
  await expect(waiting).resolves.toBe('expired');
  expect([...approvalsFrom(emitted).values()][0]?.status).toBe('expired');
});

const requestCall = (args: Record<string, unknown>) =>
  completion(
    {
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'ask-1',
          type: 'function',
          function: {
            name: 'request_approval',
            arguments: JSON.stringify(args),
          },
        },
      ],
    },
    'tool_calls',
  );
/** Starts a chat turn whose model asks the owner with request_approval. */
async function requestTurn(
  server: ReturnType<typeof start>,
  args: Record<string, unknown>,
) {
  const dot = server.workspace.dots()[0];
  const bodies: { messages: { role: string; content: unknown }[] }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (!body.stream)
      return Response.json({ choices: [{ message: { content: 'Named' } }] });
    bodies.push(body);
    return bodies.length === 1
      ? requestCall(args)
      : completion({ role: 'assistant', content: 'Done.' });
  });
  const { conversation } = await server.platform.dotConversation(dot.id);
  const events: BaseEvent[] = [];
  const view = server.platform.engine!.watch(conversation.id, (event) =>
    events.push(event),
  );
  cleanup.push(view.unsubscribe);
  await server.app.request(
    `/api/chat/${conversation.id}/messages`,
    json({ content: 'Reply to the ticket for me' }),
  );
  return { conversation, events, bodies };
}

const ask = {
  title: 'Reply to ticket #42',
  description: 'Post this reply on the ticket and mark it resolved.',
  output: 'Hi, the export is fixed in today’s release.',
  link: { url: 'https://tickets.example/42', label: 'Ticket #42' },
};

it('shows a request_approval card with its output and link, and tells the model the answer', async () => {
  const server = start();
  const turn = await requestTurn(server, ask);
  let approval!: ApprovalView;
  await vi.waitFor(() => {
    approval = approvalsFrom(turn.events).get('ask-1')!;
    expect(approval?.status).toBe('pending');
  });
  expect(approval.kind).toBe('action');
  expect(approval.payload).toEqual(ask);
  await decide(server, approval.id, true);
  await server.platform.runner!.done(turn.conversation.id);
  expect(JSON.stringify(turn.bodies[1].messages)).toContain(
    'The owner approved',
  );
});

it('tells the model not to go ahead when the owner declines a request', async () => {
  const server = start();
  const turn = await requestTurn(server, ask);
  let approval!: ApprovalView;
  await vi.waitFor(() => {
    approval = approvalsFrom(turn.events).get('ask-1')!;
    expect(approval?.status).toBe('pending');
  });
  await decide(server, approval.id, false);
  await server.platform.runner!.done(turn.conversation.id);
  expect(JSON.stringify(turn.bodies[1].messages)).toContain('declined');
});

it('refuses request_approval links that are not http(s) or OpenDots pages', async () => {
  const server = start();
  const turn = await requestTurn(server, {
    ...ask,
    link: { url: 'javascript:alert(1)' },
  });
  await server.platform.runner!.done(turn.conversation.id);
  expect(approvalsFrom(turn.events).get('ask-1')).toBeUndefined();
});
