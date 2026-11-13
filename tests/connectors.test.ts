import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import {
  ConnectorService,
  exposedTools,
} from '../src/server/connectors/service.js';
import {
  McpConnector,
  normalizeResult,
  type McpTransportFactory,
} from '../src/server/connectors/mcp.js';
import {
  connectorTools,
  type Approve,
} from '../src/server/connectors/tools.js';
import { detachedContext } from '../src/server/engine/tools.js';
import type { ApprovalStatus } from '../src/shared/approvals.js';
import { connectorRoutes } from '../src/server/connectors/routes.js';
import { OAuthFlow } from '../src/server/connectors/oauth.js';
import {
  INTERRUPTED_ACTION_THRESHOLD_MS,
  ToolCalls,
} from '../src/server/engine/tool-calls.js';
import type { Access } from '../src/server/connectors/accounts.js';
import type { Account, Grant } from '../src/shared/connection-types.js';
import { sql } from '../src/server/db/index.js';
import { testDb } from './fixtures/db.js';

const USER = 'owner';
const mail = { name: 'Mail', url: 'https://mail.example.com/mcp' };

async function fixture({ twin = false } = {}) {
  const workspace = await WorkspaceStore.open(await testDb(), USER);
  const dot = (await workspace.dots())[0];
  const other = await workspace.createDot(
    dot.spaceId,
    'Second',
    'Another Dot.',
    false,
    false,
  );
  await workspace.bindThread('thread', dot.id, 'A conversation');
  const sent = vi.fn();
  const sentTwin = vi.fn();
  const tokens: (string | undefined)[] = [];
  // What the fake service offers, which a test can change between calls.
  const offer = { sendIsReadOnly: false, extraTool: false };
  // Holds tools/list open while set, to interleave user changes.
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
        annotations: { readOnlyHint: offer.sendIsReadOnly },
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
    if (offer.extraTool)
      server.registerTool(
        'delete mail',
        { description: 'Delete an email.', inputSchema: { id: z.string() } },
        async () => ({ content: [{ type: 'text', text: 'Deleted' }] }),
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
  const connectors = new ConnectorService(
    workspace.accounts,
    workspace.actions,
    [new McpConnector(transport)],
  );
  toolCallsOf.set(connectors, workspace.toolCalls);
  const routesFor = (user: string) =>
    connectorRoutes(
      workspace,
      connectors,
      new OAuthFlow(workspace.db, connectors, 'http://localhost:4310'),
      () => user,
    );
  const call = (
    routes: ReturnType<typeof routesFor>,
    path: string,
    method = 'GET',
    body?: unknown,
  ) =>
    routes.request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const routes = routesFor(USER);
  /** The user connects Mail and lets a Dot use it. */
  const connect = async (dotId = dot.id) => {
    const account = await connectors.add(USER, 'mcp', mail);
    return { account, grant: await connectors.grant(USER, dotId, account.id) };
  };
  return {
    workspace,
    dot,
    other,
    connectors,
    routes,
    routesFor,
    request: (path: string, method?: string, body?: unknown) =>
      call(routes, path, method, body),
    requestAs: (user: string, path: string, method?: string, body?: unknown) =>
      call(routesFor(user), path, method, body),
    connect,
    sent,
    sentTwin,
    tokens,
    offer,
    gate,
  };
}
const policies = (grant: Grant) =>
  Object.fromEntries(grant.tools.map((tool) => [tool.name, tool.policy]));

it('discovers tools, gates anything not read-only, and never returns the token', async () => {
  const { dot, request, tokens } = await fixture();
  const response = await request('/accounts', 'POST', {
    connector: 'mcp',
    name: 'Work Mail',
    url: 'https://mail.example.com/mcp',
    token: 'secret-token',
  });
  expect(response.status).toBe(201);
  const account = (await response.json()) as Account & { secret?: string };
  expect(tokens).toEqual(['secret-token']);
  expect(account).toMatchObject({
    userId: USER,
    connector: 'mcp',
    detail: 'mail.example.com',
    hasSecret: true,
  });
  expect(JSON.stringify(account)).not.toContain('secret-token');
  // What the service offers says nothing about who may use it.
  expect(
    account.tools.map(({ name, readOnly }) => ({ name, readOnly })),
  ).toEqual([
    { name: 'search_mail', readOnly: true },
    { name: 'send mail!', readOnly: false },
  ]);
  expect(account.tools[0]).not.toHaveProperty('policy');
  const granted = await request(
    `/dots/${dot.id}/grants/${account.id}`,
    'PUT',
    {},
  );
  expect(policies((await granted.json()) as Grant)).toEqual({
    search_mail: 'allow',
    'send mail!': 'ask',
  });
});
it('rejects endpoints with embedded credentials, non-http schemes and unknown kinds', async () => {
  const { request } = await fixture();
  for (const body of [
    { connector: 'mcp', name: 'Bad', url: 'https://user:pw@example.com/mcp' },
    { connector: 'mcp', name: 'Bad', url: 'file:///etc/passwd' },
    { connector: 'nope', name: 'Bad', url: 'https://example.com/mcp' },
  ])
    expect((await request('/accounts', 'POST', body)).status).toBe(400);
});
it('derives unique, provider-safe tool names', () => {
  const access = (id: string, name: string, tools: string[]) =>
    ({
      account: { id, name },
      grant: {
        tools: tools.map((tool) => ({ name: tool, policy: 'allow' })),
      },
    }) as unknown as Access;
  const names = exposedTools([
    access('a', 'Work Mail', ['send mail!', 'send-mail']),
    access('b', 'work mail', ['send mail!']),
  ]).map((tool) => tool.name);
  expect(names).toEqual([
    'work_mail__send_mail',
    'work_mail__send-mail',
    'work_mail__send_mail_2',
  ]);
  for (const name of names) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
});
/** Each fixture's once-only tool call record, by its connector service. */
const toolCallsOf = new WeakMap<ConnectorService, ToolCalls>();
const tools = (
  connectors: ConnectorService,
  dotId: string,
  approve?: Approve,
  threadId = 'thread',
) =>
  connectorTools(
    connectors,
    dotId,
    threadId,
    async () => {},
    new AbortController().signal,
    approve,
    toolCallsOf.get(connectors)!,
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
  const { dot, connectors, connect, sent } = await fixture();
  await connect();
  const declining = owner('declined');
  const find = async (approve: Approve | undefined, name: string) =>
    (await tools(connectors, dot.id, approve)).find(
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
  const { dot, connectors, connect, sent, workspace } = await fixture();
  const { account } = await connect();
  const send = (
    await tools(connectors, dot.id, owner('approved').approve)
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
  expect(await workspace.toolCalls.get('thread', 'tc1')).toMatchObject({
    kind: 'connector',
    status: 'done',
    result: { isError: false, text: 'Sent to a@example.com' },
  });
  // The receipt records which Dot and which account, for the audit trail.
  expect(
    await workspace.db.row(
      sql`SELECT account_id, dot_id FROM tool_calls WHERE tool_call_id='tc1'`,
    ),
  ).toEqual({ accountId: account.id, dotId: dot.id });
});
it('binds approvals to the exact tool, even when look-alike names collide', async () => {
  const { dot, connectors, connect, sent, sentTwin } = await fixture({
    twin: true,
  });
  await connect();
  const names = (await connectors.tools(dot.id)).map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(['mail__send_mail', 'mail__send_mail_2']),
  );
  const approving = owner('approved');
  const twin = (await tools(connectors, dot.id, approving.approve)).find(
    (tool) => tool.name === 'mail__send_mail_2',
  )!;
  await twin.execute({ to: 'a@example.com', body: 'Hi' }, toolCtx('tc1'));
  expect(approving.asked[0]?.payload).toMatchObject({ title: 'send mail?' });
  expect(sentTwin).toHaveBeenCalledOnce();
  expect(sent).not.toHaveBeenCalled();
});
it('honors changes to a tool, including during a turn', async () => {
  const { dot, connectors, connect, workspace } = await fixture();
  const { account } = await connect();
  const [search] = await tools(connectors, dot.id);
  const before = await workspace.accounts.fingerprint(dot.id);
  await connectors.setPolicy(USER, dot.id, account.id, 'search_mail', 'ask');
  expect(await workspace.accounts.fingerprint(dot.id)).not.toBe(before);
  expect(await search.execute!({ query: 'x' }, toolCtx())).toMatchObject({
    status: 'unavailable',
  });
  await connectors.setPolicy(USER, dot.id, account.id, 'search_mail', 'block');
  expect((await connectors.tools(dot.id)).map((tool) => tool.name)).toEqual([
    'mail__send_mail',
  ]);
  await expect(search.execute!({ query: 'x' }, toolCtx())).rejects.toThrow(
    'not available',
  );
});
it('changes the fingerprint when access is granted, taken away or refreshed', async () => {
  const { dot, connectors, workspace } = await fixture();
  const seen = [await workspace.accounts.fingerprint(dot.id)];
  const account = await connectors.add(USER, 'mcp', mail);
  await connectors.grant(USER, dot.id, account.id);
  seen.push(await workspace.accounts.fingerprint(dot.id));
  await connectors.refresh(USER, account.id);
  seen.push(await workspace.accounts.fingerprint(dot.id));
  await connectors.revoke(USER, dot.id, account.id);
  seen.push(await workspace.accounts.fingerprint(dot.id));
  // Each step changes it, and taking the access away leaves nothing behind.
  expect(new Set(seen.slice(0, 3)).size).toBe(3);
  expect(seen[3]).toBe(seen[0]);
});
it('keeps choices made while a refresh is discovering tools', async () => {
  const { dot, connectors, connect, gate } = await fixture();
  const { account } = await connect();
  let release!: () => void;
  gate.wait = new Promise((resolve) => (release = resolve));
  const refreshing = connectors.refresh(USER, account.id);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Block and gate while discovery is still pending.
  await connectors.setPolicy(USER, dot.id, account.id, 'send mail!', 'block');
  await connectors.setPolicy(USER, dot.id, account.id, 'search_mail', 'ask');
  gate.wait = undefined;
  release();
  await refreshing;
  expect(policies((await connectors.grants(dot.id))[0])).toEqual({
    search_mail: 'ask',
    'send mail!': 'block',
  });
});
it('keeps choices on refresh and reports unreachable services', async () => {
  const { dot, connectors, connect } = await fixture();
  const { account } = await connect();
  await connectors.setPolicy(USER, dot.id, account.id, 'send mail!', 'block');
  const refreshed = await connectors.refresh(USER, account.id);
  expect(refreshed.error).toBeNull();
  expect(policies((await connectors.grants(dot.id))[0])['send mail!']).toBe(
    'block',
  );
  const offline = new ConnectorService(
    connectors.accounts,
    connectors.actions,
    [
      new McpConnector(() => {
        throw new Error('connect ECONNREFUSED');
      }),
    ],
  );
  const failed = await offline.refresh(USER, account.id);
  expect(failed.error).toContain('ECONNREFUSED');
  expect(failed.tools).toHaveLength(2);
  await expect(
    offline.add(USER, 'mcp', { name: 'Down', url: 'https://down.example.com' }),
  ).rejects.toThrow('Could not reach the connected service');
});
it('does not let a refresh lift the approval on a tool', async () => {
  const { dot, connectors, connect, offer } = await fixture();
  const { account } = await connect();
  // The service now claims its send tool only reads.
  offer.sendIsReadOnly = true;
  const refreshed = await connectors.refresh(USER, account.id);
  expect(
    refreshed.tools.find((tool) => tool.name === 'send mail!'),
  ).toMatchObject({ readOnly: true });
  expect(policies((await connectors.grants(dot.id))[0])['send mail!']).toBe(
    'ask',
  );
});
it('gives tools that appear later the default policy, on every grant', async () => {
  const { dot, other, connectors, connect, offer } = await fixture();
  const { account } = await connect();
  await connectors.grant(USER, other.id, account.id);
  await connectors.setPolicy(USER, dot.id, account.id, 'send mail!', 'block');
  offer.extraTool = true;
  await connectors.refresh(USER, account.id);
  for (const id of [dot.id, other.id])
    expect(policies((await connectors.grants(id))[0])['delete mail']).toBe(
      'ask',
    );
  expect(policies((await connectors.grants(dot.id))[0])['send mail!']).toBe(
    'block',
  );
});
it('shares one account between Dots, each with its own policies', async () => {
  const { dot, other, connectors, connect } = await fixture();
  const { account } = await connect();
  await connectors.grant(USER, other.id, account.id);
  await connectors.setPolicy(USER, dot.id, account.id, 'send mail!', 'block');
  expect((await connectors.tools(dot.id)).map((tool) => tool.name)).toEqual([
    'mail__search_mail',
  ]);
  expect((await connectors.tools(other.id)).map((tool) => tool.name)).toEqual([
    'mail__search_mail',
    'mail__send_mail',
  ]);
  expect(await connectors.list(USER)).toHaveLength(1);
});
it('takes access away with the grant, and starts fresh when it is granted again', async () => {
  const { dot, other, connectors, connect, workspace } = await fixture();
  const { account, grant } = await connect();
  await connectors.grant(USER, other.id, account.id);
  await connectors.setPolicy(USER, dot.id, account.id, 'search_mail', 'block');
  expect(await connectors.revoke(USER, dot.id, account.id)).toBe(true);
  expect(await connectors.tools(dot.id)).toEqual([]);
  expect(
    await workspace.db.rows(
      sql`SELECT 1 FROM grant_policies WHERE grant_id=${grant.id}`,
    ),
  ).toEqual([]);
  // The account and the other Dot's access are untouched.
  expect(await connectors.tools(other.id)).toHaveLength(2);
  expect(await connectors.revoke(USER, dot.id, account.id)).toBe(false);
  expect(
    policies(await connectors.grant(USER, dot.id, account.id)).search_mail,
  ).toBe('allow');
});
it('removes every grant with the account', async () => {
  const { dot, other, connectors, connect, workspace } = await fixture();
  const { account } = await connect();
  await connectors.grant(USER, other.id, account.id);
  expect(await connectors.remove(USER, account.id)).toBe(true);
  expect(await connectors.tools(dot.id)).toEqual([]);
  expect(await connectors.tools(other.id)).toEqual([]);
  expect(await workspace.db.rows(sql`SELECT 1 FROM grants`)).toEqual([]);
  expect(await workspace.db.rows(sql`SELECT 1 FROM grant_policies`)).toEqual(
    [],
  );
});
it('keeps one user’s accounts private from another', async () => {
  const { dot, connectors, connect, requestAs, request } = await fixture();
  const { account } = await connect();
  const stranger = 'someone-else';
  expect(await connectors.list(stranger)).toEqual([]);
  expect(await (await requestAs(stranger, '/accounts')).json()).toEqual([]);
  // Nothing of another user's account can be read, changed or used.
  await expect(connectors.refresh(stranger, account.id)).rejects.toThrow(
    'not found',
  );
  await expect(connectors.grant(stranger, dot.id, account.id)).rejects.toThrow(
    'not found',
  );
  await expect(
    connectors.setPolicy(stranger, dot.id, account.id, 'send mail!', 'allow'),
  ).rejects.toThrow('not found');
  expect(await connectors.revoke(stranger, dot.id, account.id)).toBe(false);
  expect(await connectors.remove(stranger, account.id)).toBe(false);
  expect(
    (await requestAs(stranger, `/accounts/${account.id}`, 'DELETE')).status,
  ).toBe(400);
  // The owner's account, grant and policies are all as they were.
  expect(await connectors.list(USER)).toHaveLength(1);
  expect(policies((await connectors.grants(dot.id))[0])).toEqual({
    search_mail: 'allow',
    'send mail!': 'ask',
  });
  expect((await request('/accounts')).status).toBe(200);
});
it('serves accounts and grants over the API', async () => {
  const { dot, request } = await fixture();
  const created = await request('/accounts', 'POST', {
    connector: 'mcp',
    ...mail,
  });
  const account = (await created.json()) as Account;
  const path = `/dots/${dot.id}/grants/${account.id}`;
  expect(await (await request(`/dots/${dot.id}/grants`)).json()).toEqual([]);
  expect((await request(path, 'PUT', {})).status).toBe(200);
  // Granting twice changes nothing.
  expect((await request(path, 'PUT', {})).status).toBe(200);
  const patched = await request(`${path}/tools/send%20mail!`, 'PATCH', {
    policy: 'allow',
  });
  expect(policies((await patched.json()) as Grant)['send mail!']).toBe('allow');
  const listed = (await (
    await request(`/dots/${dot.id}/grants`)
  ).json()) as Grant[];
  expect(listed).toHaveLength(1);
  expect(policies(listed[0])['send mail!']).toBe('allow');
  for (const [route, method, body] of [
    [`${path}/tools/send%20mail!`, 'PATCH', { policy: 'whenever' }],
    [`${path}/tools/send%20mail!`, 'PATCH', { policy: 'allow', extra: 1 }],
    [`${path}/tools/missing`, 'PATCH', { policy: 'allow' }],
    [`/dots/${dot.id}/grants/missing`, 'PUT', {}],
    ['/dots/missing/grants/' + account.id, 'PUT', {}],
  ] as const)
    expect((await request(route, method, body)).status).toBe(400);
  expect((await request(path, 'DELETE')).status).toBe(200);
  expect((await request(path, 'DELETE')).status).toBe(400);
  expect((await request(`/accounts/${account.id}`, 'DELETE')).status).toBe(200);
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
    sql`INSERT INTO tool_calls (thread_id, tool_call_id, account_id, tool, status, result, created_at, approval_id) VALUES ('thread', 'tc1', 'account', 'send mail!', 'running', NULL, ${Date.now() - INTERRUPTED_ACTION_THRESHOLD_MS}, 'approval-1')`,
  );
  const store = new ToolCalls(db);
  expect(await store.get('thread', 'tc1')).toMatchObject({
    approvalId: 'approval-1',
    status: 'interrupted',
    result: null,
  });
});
