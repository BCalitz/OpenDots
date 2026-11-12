import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  ConnectionService,
  exposedTools,
  normalizeResult,
  type McpTransportFactory,
} from '../src/server/connections.js';
import {
  connectionTools,
  type Approve,
} from '../src/server/connection-tools.js';
import { detachedContext } from '../src/server/engine/tools.js';
import type { ApprovalStatus } from '../src/shared/approvals.js';
import { connectionRoutes } from '../src/server/connection-routes.js';
import {
  ConnectionStore,
  INTERRUPTED_ACTION_THRESHOLD_MS,
} from '../src/server/connection-store.js';
import type { Connection } from '../src/shared/connection-types.js';
import { sql } from '../src/server/db/index.js';
import { testDb } from './fixtures/db.js';
async function fixture({ twin = false } = {}) {
  const workspace = await WorkspaceStore.open(await testDb(), 'owner');
  const dot = (await workspace.dots())[0];
  await workspace.bindThread('thread', dot.id, 'A conversation');
  const sent = vi.fn();
  const sentTwin = vi.fn();
  const tokens: (string | undefined)[] = [];
  // Holds tools/list open while set, to interleave owner changes.
  const gate: { wait?: Promise<void> } = {};
  const transport: McpTransportFactory = ({ token }) => {
    tokens.push(token);
    const server = new McpServer({ name: 'mail', version: '1.0.0' });
    server.registerTool(
      'search_mail',
      {
        description: 'Search the inbox.',
        inputSchema: { query: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ query }) => ({
        content: [{ type: 'text', text: `3 results for ${query}` }],
      }),
    );
    server.registerTool(
      'send mail!',
      {
        description: 'Send an email.',
        inputSchema: { to: z.string(), body: z.string() },
      },
      async (args) => {
        sent(args);
        return { content: [{ type: 'text', text: `Sent to ${args.to}` }] };
      },
    );
    // Normalizes to the same model-facing base name as "send mail!".
    if (twin)
      server.registerTool(
        'send mail?',
        {
          description: 'Send an email to everyone.',
          inputSchema: { to: z.string(), body: z.string() },
        },
        async (args) => {
          sentTwin(args);
          return { content: [{ type: 'text', text: 'Sent to everyone' }] };
        },
      );
    const [client, serverSide] = InMemoryTransport.createLinkedPair();
    void server.connect(serverSide);
    const send = client.send.bind(client);
    client.send = async (message, options) => {
      if ('method' in message && message.method === 'tools/list' && gate.wait)
        await gate.wait;
      return send(message, options);
    };
    return client;
  };
  const connections = new ConnectionService(workspace.connections, transport);
  const routes = connectionRoutes(workspace, connections);
  const request = (path: string, method = 'GET', body?: unknown) =>
    routes.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    workspace,
    dot,
    connections,
    routes,
    request,
    sent,
    sentTwin,
    tokens,
    gate,
  };
}
it('discovers tools, gates anything not read-only, and never returns the token', async () => {
  const { dot, request, tokens } = await fixture();
  const response = await request(`/dots/${dot.id}/connections`, 'POST', {
    name: 'Work Mail',
    url: 'https://mail.example.com/mcp',
    token: 'secret-token',
  });
  expect(response.status).toBe(201);
  const connection = (await response.json()) as Connection & {
    token?: string;
  };
  expect(tokens).toEqual(['secret-token']);
  expect(connection.hasToken).toBe(true);
  expect(connection.token).toBeUndefined();
  expect(JSON.stringify(connection)).not.toContain('secret-token');
  expect(
    connection.tools.map(({ name, readOnly, requiresApproval, enabled }) => ({
      name,
      readOnly,
      requiresApproval,
      enabled,
    })),
  ).toEqual([
    {
      name: 'search_mail',
      readOnly: true,
      requiresApproval: false,
      enabled: true,
    },
    {
      name: 'send mail!',
      readOnly: false,
      requiresApproval: true,
      enabled: true,
    },
  ]);
});
it('rejects endpoints with embedded credentials or non-http schemes', async () => {
  const { dot, request } = await fixture();
  for (const url of ['https://user:pw@example.com/mcp', 'file:///etc/passwd']) {
    const response = await request(`/dots/${dot.id}/connections`, 'POST', {
      name: 'Bad',
      url,
    });
    expect(response.status).toBe(400);
  }
});
it('derives unique, provider-safe tool names', () => {
  const tool = (name: string) => ({
    name,
    title: name,
    description: '',
    inputSchema: { type: 'object' },
    readOnly: true,
    enabled: true,
    requiresApproval: false,
  });
  const connection = (id: string, name: string, tools: string[]) =>
    ({ id, name, tools: tools.map(tool) }) as unknown as Connection;
  const names = exposedTools([
    connection('a', 'Work Mail', ['send mail!', 'send-mail']),
    connection('b', 'work mail', ['send mail!']),
  ]).map((tool) => tool.name);
  expect(names).toEqual([
    'work_mail__send_mail',
    'work_mail__send-mail',
    'work_mail__send_mail_2',
  ]);
  for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
});
const tools = (
  connections: ConnectionService,
  dotId: string,
  approve?: Approve,
  threadId = 'thread',
) =>
  connectionTools(
    connections,
    dotId,
    threadId,
    async () => {},
    new AbortController().signal,
    approve,
  );
const toolCtx = (toolCallId = 'call') => detachedContext(undefined, toolCallId);
/** An owner who answers every request the same way, and remembers it. */
const owner = (answer: ApprovalStatus) => {
  const asked: { kind: string; payload: unknown }[] = [];
  const approve: Approve = async (_context, request) => {
    asked.push(request);
    return answer;
  };
  return { approve, asked };
};
it('runs read-only tools directly and holds write tools for owner approval', async () => {
  const { dot, connections, sent } = await fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const declining = owner('declined');
  const find = async (approve: Approve | undefined, name: string) =>
    (await tools(connections, dot.id, approve)).find(
      (tool) => tool.name === name,
    )!;
  expect(
    await (
      await find(declining.approve, 'mail__search_mail')
    ).execute({ query: 'invoices' }, toolCtx()),
  ).toEqual({ isError: false, text: '3 results for invoices' });
  expect(declining.asked).toEqual([]);
  expect(
    await (
      await find(declining.approve, 'mail__send_mail')
    ).execute({ to: 'a@example.com', body: 'Hi' }, toolCtx()),
  ).toMatchObject({ approved: false, status: 'declined' });
  // The owner saw the server's record of exactly what would run.
  expect(declining.asked).toEqual([
    {
      kind: 'connection_action',
      payload: {
        connection: 'Mail',
        title: 'send mail!',
        description: 'Send an email.',
        arguments: { to: 'a@example.com', body: 'Hi' },
      },
    },
  ]);
  expect(
    await (
      await find(owner('expired').approve, 'mail__send_mail')
    ).execute({ to: 'a@example.com', body: 'Hi' }, toolCtx()),
  ).toMatchObject({ approved: false, status: 'expired' });
  // Schedules, voice and Slack cannot ask, so gated tools never run there.
  expect(
    await (
      await find(undefined, 'mail__send_mail')
    ).execute({ to: 'a@example.com', body: 'Hi' }, toolCtx()),
  ).toMatchObject({ status: 'unavailable' });
  expect(sent).not.toHaveBeenCalled();
});
it('runs an approved request once and records its receipt', async () => {
  const { dot, connections, sent, workspace } = await fixture();
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const send = (
    await tools(connections, dot.id, owner('approved').approve)
  ).find((tool) => tool.name === 'mail__send_mail')!;
  expect(
    await send.execute({ to: 'a@example.com', body: 'Hi' }, toolCtx('tc1')),
  ).toEqual({ approved: true, isError: false, text: 'Sent to a@example.com' });
  // The same tool call cannot run it twice.
  expect(
    await send.execute({ to: 'a@example.com', body: 'Hi' }, toolCtx('tc1')),
  ).toMatchObject({ approved: true, error: 'This action already ran.' });
  expect(sent).toHaveBeenCalledOnce();
  expect(sent.mock.calls[0][0]).toEqual({ to: 'a@example.com', body: 'Hi' });
  expect(await workspace.connections.action('thread', 'tc1')).toMatchObject({
    status: 'done',
    result: { isError: false, text: 'Sent to a@example.com' },
  });
});
it('binds approvals to the exact tool, even when look-alike names collide', async () => {
  const { dot, connections, sent, sentTwin } = await fixture({ twin: true });
  await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const names = (await connections.tools(dot.id)).map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(['mail__send_mail', 'mail__send_mail_2']),
  );
  const approving = owner('approved');
  const twin = (await tools(connections, dot.id, approving.approve)).find(
    (tool) => tool.name === 'mail__send_mail_2',
  )!;
  await twin.execute({ to: 'a@example.com', body: 'Hi' }, toolCtx('tc1'));
  expect(approving.asked[0]?.payload).toMatchObject({ title: 'send mail?' });
  expect(sentTwin).toHaveBeenCalledOnce();
  expect(sent).not.toHaveBeenCalled();
});
it('honors owner changes to a tool, including during a turn', async () => {
  const { dot, connections, workspace } = await fixture();
  const connection = await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  const [search] = await tools(connections, dot.id);
  const before = await workspace.connections.fingerprint(dot.id);
  await connections.setTool(connection.id, 'search_mail', {
    requiresApproval: true,
  });
  expect(await workspace.connections.fingerprint(dot.id)).not.toBe(before);
  expect(await search.execute!({ query: 'x' }, toolCtx())).toMatchObject({
    status: 'unavailable',
  });
  await connections.setTool(connection.id, 'search_mail', { enabled: false });
  expect((await connections.tools(dot.id)).map((tool) => tool.name)).toEqual([
    'mail__send_mail',
  ]);
  await expect(search.execute!({ query: 'x' }, toolCtx())).rejects.toThrow(
    'not available',
  );
});
it('keeps owner changes made while a refresh is discovering tools', async () => {
  const { dot, connections, gate } = await fixture();
  const connection = await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  let release!: () => void;
  gate.wait = new Promise((resolve) => (release = resolve));
  const refreshing = connections.refresh(connection.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Revoke and gate while discovery is still pending.
  await connections.setTool(connection.id, 'send mail!', { enabled: false });
  await connections.setTool(connection.id, 'search_mail', {
    requiresApproval: true,
  });
  gate.wait = undefined;
  release();
  const refreshed = await refreshing;
  expect(
    refreshed.tools.map(({ name, enabled, requiresApproval }) => ({
      name,
      enabled,
      requiresApproval,
    })),
  ).toEqual([
    { name: 'search_mail', enabled: true, requiresApproval: true },
    { name: 'send mail!', enabled: false, requiresApproval: true },
  ]);
});
it('keeps owner choices on refresh and reports unreachable services', async () => {
  const { dot, connections } = await fixture();
  const connection = await connections.add(dot.id, {
    name: 'Mail',
    url: 'https://mail.example.com/mcp',
  });
  await connections.setTool(connection.id, 'send mail!', { enabled: false });
  const refreshed = await connections.refresh(connection.id);
  expect(
    refreshed.tools.find((tool) => tool.name === 'send mail!'),
  ).toMatchObject({ enabled: false, requiresApproval: true });
  expect(refreshed.error).toBeNull();
  const offline = new ConnectionService(connections.store, () => {
    throw new Error('connect ECONNREFUSED');
  });
  const failed = await offline.refresh(connection.id);
  expect(failed.error).toContain('ECONNREFUSED');
  expect(failed.tools).toHaveLength(2);
  await expect(
    offline.add(dot.id, { name: 'Down', url: 'https://down.example.com' }),
  ).rejects.toThrow('Could not reach the connected service');
});
it('normalizes and bounds tool results', () => {
  expect(
    normalizeResult({
      isError: true,
      content: [
        { type: 'text', text: 'Quota exceeded' },
        { type: 'image', data: 'x', mimeType: 'image/png' },
      ],
    }),
  ).toEqual({ isError: true, text: 'Quota exceeded\n[image omitted]' });
  expect(normalizeResult({ structuredContent: { ok: true } }).text).toBe(
    '{"ok":true}',
  );
  expect(
    normalizeResult({ content: [{ type: 'text', text: 'x'.repeat(30000) }] })
      .text,
  ).toHaveLength(20000 + '\n[truncated]'.length);
  expect(normalizeResult('nope').isError).toBe(true);
});
it('treats a receipt without a claim time as claimed when it was created', async () => {
  const db = await testDb();
  // Receipts from before claim times were recorded have only created_at.
  await db.run(
    sql`INSERT INTO mcp_actions (thread_id, tool_call_id, connection_id, tool, status, result, created_at, approval_id) VALUES ('thread', 'tc1', 'connection', 'send mail!', 'running', NULL, ${Date.now() - INTERRUPTED_ACTION_THRESHOLD_MS}, 'approval-1')`,
  );
  const store = new ConnectionStore(db);
  expect(await store.action('thread', 'tc1')).toMatchObject({
    approvalId: 'approval-1',
    status: 'interrupted',
    result: null,
  });
});
