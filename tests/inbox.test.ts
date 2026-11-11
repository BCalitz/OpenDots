import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
import {
  ConnectionService,
  type McpTransportFactory,
} from '../src/server/connections.js';
import { InboxEngine, type NewEvents } from '../src/server/inbox/engine.js';
import { eventsFromResult, withSince } from '../src/server/inbox/mcp-source.js';
import { normalizePriority } from '../src/server/inbox/source.js';
import { pushNotifier, shouldNotify } from '../src/server/inbox/notify.js';
import type { PushService } from '../src/server/push.js';
import type { InboxState } from '../src/shared/inbox-types.js';

const resources: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of resources.splice(0).reverse()) await close();
});

type Ticket = { id: string; title: string; priority: string };
function ticketServer(tickets: Ticket[]) {
  const calls: Record<string, unknown>[] = [];
  const transport: McpTransportFactory = () => {
    const server = new McpServer({ name: 'tickets', version: '1.0.0' });
    server.registerTool(
      'list_my_tickets',
      {
        description: 'Tickets assigned to me.',
        inputSchema: { assignee: z.string(), since: z.string() },
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        calls.push(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, data: tickets }),
            },
          ],
        };
      },
    );
    server.registerTool(
      'close_ticket',
      { description: 'Close a ticket.', inputSchema: { id: z.string() } },
      async () => ({ content: [{ type: 'text', text: 'closed' }] }),
    );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    return client;
  };
  return { transport, calls };
}

async function engineFixture(tickets: Ticket[], paused = false) {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  resources.push(() => workspace.close());
  const dot = workspace.dots()[0];
  const server = ticketServer(tickets);
  const connections = new ConnectionService(
    workspace.connections,
    server.transport,
  );
  const connection = await connections.add(dot.id, {
    name: 'Tickets',
    url: 'https://tickets.invalid/mcp',
  });
  const state = { paused };
  const engine = new InboxEngine(workspace.inbox, connections, {
    paused: () => state.paused,
  });
  resources.push(() => engine.stop());
  const batches: NewEvents[] = [];
  engine.onEvents((batch) => void batches.push(batch));
  const { source } = workspace.inbox.create({
    name: 'My tickets',
    kind: 'ticket',
    type: 'mcp',
    notify: 'urgent',
    intervalSeconds: 300,
    config: {
      dotId: dot.id,
      connectionId: connection.id,
      tool: 'list_my_tickets',
      arguments: { assignee: 'me', since: '{{since}}' },
    },
  });
  return { workspace, engine, source, batches, server, state, dot, connection };
}

it('polls a read-only MCP list tool, dedupes, and resumes from its cursor', async () => {
  const tickets: Ticket[] = [
    { id: 'T-1', title: 'Payment export failing', priority: 'Urgent' },
    { id: 'T-2', title: 'Update docs', priority: 'Low' },
  ];
  const { workspace, engine, source, batches, server } =
    await engineFixture(tickets);

  await engine.tick();
  expect(batches).toHaveLength(1);
  expect(batches[0].initial).toBe(true);
  expect(
    batches[0].events.map((event) => [event.externalId, event.priority]),
  ).toEqual([
    ['T-1', 'urgent'],
    ['T-2', 'low'],
  ]);
  expect(batches[0].events[0]).toMatchObject({
    kind: 'ticket.assigned',
    title: 'Payment export failing',
    state: 'new',
  });
  // First poll looks back a week; the tool got a real timestamp.
  expect(Date.parse(String(server.calls[0].since))).toBeLessThan(
    Date.now() - 6 * 86_400_000,
  );

  // Not due again yet.
  await engine.tick();
  expect(server.calls).toHaveLength(1);

  tickets.push({ id: 'T-3', title: 'Client X escalation', priority: 'High' });
  workspace.inbox.pollNow(source.id);
  await engine.tick();
  expect(server.calls).toHaveLength(2);
  expect(Date.parse(String(server.calls[1].since))).toBeGreaterThan(
    Date.now() - 60_000,
  );
  expect(batches).toHaveLength(2);
  expect(batches[1]).toMatchObject({ initial: false });
  expect(batches[1].events.map((event) => event.externalId)).toEqual(['T-3']);

  const [view] = workspace.inbox.sources();
  expect(view).toMatchObject({ eventCount: 3, newCount: 3, lastError: null });
  // Sorted by importance, then newest.
  expect(workspace.inbox.events().map((event) => event.externalId)).toEqual([
    'T-1',
    'T-3',
    'T-2',
  ]);
  expect(workspace.inbox.payload(batches[1].events[0].id)).toMatchObject({
    id: 'T-3',
  });
});

it('records an error instead of running a tool that needs approval', async () => {
  const { workspace, engine, connection, dot, batches } = await engineFixture(
    [],
  );
  const { source } = workspace.inbox.create({
    name: 'Bad',
    kind: 'ticket',
    type: 'mcp',
    notify: 'off',
    intervalSeconds: 300,
    config: {
      dotId: dot.id,
      connectionId: connection.id,
      tool: 'close_ticket',
      arguments: { id: 'x' },
    },
  });
  // Disable the good source so the bad one is due first.
  for (const other of workspace.inbox.sources())
    if (other.id !== source.id)
      workspace.inbox.update(other.id, { enabled: false });
  await engine.tick();
  expect(workspace.inbox.source(source.id)?.lastError).toMatch(/approval/);
  expect(batches).toHaveLength(0);
});

it('leases a source to one poller and waits while Dots are paused', async () => {
  const { workspace, engine, state, server } = await engineFixture([
    { id: 'T-1', title: 'One', priority: 'normal' },
  ]);
  const claim = workspace.inbox.claimDue();
  expect(claim).toBeDefined();
  expect(workspace.inbox.claimDue()).toBeUndefined();
  // An expired lease can be claimed again.
  expect(workspace.inbox.claimDue(Date.now() + 10 * 60_000)).toBeDefined();
  expect(workspace.inbox.finishPoll(claim!, {})).toBe(false);

  state.paused = true;
  for (const source of workspace.inbox.sources())
    workspace.inbox.pollNow(source.id);
  await engine.tick();
  expect(server.calls).toHaveLength(0);
});

it('finds records in common result shapes', () => {
  const jira = JSON.stringify({
    issues: [
      {
        key: 'PAY-7',
        self: 'https://jira.invalid/rest/api/2/issue/1',
        fields: { summary: 'Refund stuck', priority: { name: 'Highest' } },
      },
    ],
  });
  expect(
    eventsFromResult(jira, {
      id: 's',
      kind: 'ticket',
      fields: { title: 'fields.summary', priority: 'fields.priority' },
    })[0],
  ).toMatchObject({
    externalId: 'PAY-7',
    title: 'Refund stuck',
    priority: 'urgent',
    url: 'https://jira.invalid/rest/api/2/issue/1',
  });
  const github = JSON.stringify([
    {
      number: 42,
      title: 'Crash on save',
      html_url: 'https://github.invalid/o/r/issues/42',
      user: { login: 'someone' },
      updated_at: '2026-11-01T10:00:00Z',
    },
  ]);
  expect(
    eventsFromResult(github, { id: 's', kind: 'ticket' })[0],
  ).toMatchObject({
    externalId: '42',
    url: 'https://github.invalid/o/r/issues/42',
    occurredAt: Date.parse('2026-11-01T10:00:00Z'),
  });
  expect(() =>
    eventsFromResult('3 results', { id: 's', kind: 'ticket' }),
  ).toThrow(/not JSON/);
  expect(() =>
    eventsFromResult('{"ok":true}', { id: 's', kind: 'ticket' }),
  ).toThrow(/items path/);
  expect(normalizePriority(1)).toBe('urgent');
  expect(normalizePriority('P1')).toBe('high');
  expect(normalizePriority({ label: 'minor' })).toBe('low');
  expect(normalizePriority(undefined)).toBe('normal');
  const since = new Date('2026-11-09T00:00:00Z');
  expect(withSince({ a: ['{{since}}'], b: 'x' }, since)).toEqual({
    a: ['2026-11-09T00:00:00.000Z'],
    b: 'x',
  });
});

it('pushes only for events above the threshold and never for the backfill', async () => {
  const send = vi.fn(async () => ({ sent: 1, failed: 0 }));
  const push = { send, previews: false } as unknown as PushService;
  const notify = pushNotifier(push);
  const event = (priority: 'urgent' | 'normal') => ({
    id: priority,
    sourceId: 's',
    sourceName: 'Tickets',
    externalId: priority,
    kind: 'ticket.assigned',
    title: 'Secret customer detail',
    summary: '',
    priority,
    from: null,
    url: null,
    occurredAt: 0,
    receivedAt: 0,
    state: 'new' as const,
  });
  const source = { kind: 'ticket', notify: 'urgent' } as NewEvents['source'];
  await notify({ source, events: [event('urgent')], initial: true });
  await notify({ source, events: [event('normal')], initial: false });
  expect(send).not.toHaveBeenCalled();
  await notify({
    source,
    events: [event('urgent'), event('normal')],
    initial: false,
  });
  expect(send).toHaveBeenCalledWith({
    title: 'New urgent ticket',
    body: 'Open the OpenDots inbox to see it.',
    data: { url: '/#/inbox' },
  });
  expect(shouldNotify('high', 'urgent')).toBe(true);
  expect(shouldNotify('off', 'urgent')).toBe(false);
});

it('accepts webhook deliveries with the source secret, not the owner token', async () => {
  const ownerToken = 'owner-token-that-is-long-enough';
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  resources.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
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
    ownerToken,
  });
  const owner = (body?: unknown, method = 'POST') => ({
    method,
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const created = await app.request(
    '/api/inbox/sources',
    owner({ type: 'webhook', name: 'Helpdesk', kind: 'ticket' }),
  );
  expect(created.status).toBe(201);
  const { source, secret, url } = (await created.json()) as {
    source: { id: string };
    secret: string;
    url: string;
  };
  expect(url).toBe(`/api/inbox/hooks/${source.id}`);
  const deliver = (body: unknown, key?: string) =>
    app.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'X-OpenDots-Secret': key } : {}),
      },
      body: JSON.stringify(body),
    });
  const ticket = {
    externalId: 'HD-9',
    title: 'Payment export failing for client X',
    priority: 'urgent',
    url: 'https://helpdesk.invalid/HD-9',
  };
  expect((await deliver(ticket)).status).toBe(401);
  expect((await deliver(ticket, 'wrong')).status).toBe(401);
  expect((await deliver({ nope: true }, secret)).status).toBe(400);
  const accepted = await deliver(
    { events: [ticket, { ...ticket, externalId: 'HD-10', priority: 'low' }] },
    secret,
  );
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toEqual({ received: 2, new: 2 });
  expect(await (await deliver(ticket, secret)).json()).toEqual({
    received: 1,
    new: 0,
  });

  const inbox = (await (
    await app.request('/api/inbox', owner(undefined, 'GET'))
  ).json()) as InboxState;
  expect(inbox.sources[0]).toMatchObject({
    type: 'webhook',
    hasSecret: true,
    eventCount: 2,
  });
  expect(inbox.events.map((event) => event.externalId)).toEqual([
    'HD-9',
    'HD-10',
  ]);
  const dismissed = await app.request(
    `/api/inbox/events/${inbox.events[0].id}`,
    owner({ state: 'dismissed' }),
  );
  expect(await dismissed.json()).toMatchObject({ state: 'dismissed' });
  const after = (await (
    await app.request('/api/inbox', owner(undefined, 'GET'))
  ).json()) as InboxState;
  expect(after.events.map((event) => event.externalId)).toEqual(['HD-10']);

  // Rotating the secret retires the old one.
  const rotated = (await (
    await app.request(`/api/inbox/sources/${source.id}/secret`, owner({}))
  ).json()) as { secret: string };
  expect((await deliver(ticket, secret)).status).toBe(401);
  expect((await deliver(ticket, rotated.secret)).status).toBe(202);
  // Disabled sources stop accepting deliveries.
  await app.request(
    `/api/inbox/sources/${source.id}`,
    owner({ enabled: false }, 'PATCH'),
  );
  expect((await deliver(ticket, rotated.secret)).status).toBe(401);
});

it('only accepts MCP sources whose tool can run without asking', async () => {
  const store = new Store(':memory:');
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const platform = new Platform(store, workspace, {
    apiKey: 'fixture',
    model: 'custom-model',
    baseUrl: 'https://unused.invalid/v1',
    runtimeUrl: '',
    voiceName: 'marin',
    slackUsers: [],
  });
  resources.push(async () => {
    await platform.stop();
    store.close();
    workspace.close();
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
  const dot = workspace.dots()[0];
  const tool = (name: string, requiresApproval: boolean) => ({
    name,
    title: name,
    description: '',
    inputSchema: { type: 'object' },
    readOnly: !requiresApproval,
    enabled: true,
    requiresApproval,
  });
  const connection = workspace.connections.create(
    dot.id,
    { name: 'Tickets', url: 'https://tickets.invalid/mcp' },
    [tool('list_my_tickets', false), tool('close_ticket', true)],
  );
  const create = (name: string) =>
    app.request('/api/inbox/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'mcp',
        name: 'Mine',
        kind: 'ticket',
        config: { dotId: dot.id, connectionId: connection.id, tool: name },
      }),
    });
  const gated = await create('close_ticket');
  expect(gated.status).toBe(400);
  expect((await gated.json()).error).toMatch(/approval/);
  const ok = await create('list_my_tickets');
  expect(ok.status).toBe(201);
  expect(await ok.json()).toMatchObject({
    source: { type: 'mcp', notify: 'urgent', intervalSeconds: 300 },
  });
});
