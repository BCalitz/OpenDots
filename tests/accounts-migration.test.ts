import { expect, it } from 'vitest';
import { sql } from '../src/server/db/index.js';
import { migrate } from '../src/server/db/migrations.js';
import { testDb } from './fixtures/db.js';

/** A tool as the per-Dot connections stored it: catalog and permissions together. */
const tool = (
  name: string,
  readOnly: boolean,
  enabled: boolean,
  requiresApproval: boolean,
) => ({
  name,
  title: name,
  description: '',
  inputSchema: { type: 'object' },
  readOnly,
  enabled,
  requiresApproval,
});
const connection = (
  id: string,
  dot: string,
  name: string,
  url: string,
  token: string | null,
  tools: unknown[],
  error: string | null,
  at: number,
) =>
  sql`INSERT INTO mcp_connections (id, dot_id, name, url, token, tools, error, created_at, updated_at) VALUES (${id}, ${dot}, ${name}, ${url}, ${token}, ${JSON.stringify(tools)}, ${error}, ${at}, ${at})`;

it('turns per-Dot connections into shared accounts, grants and policies', async () => {
  // The schema as the previous release left it, with real-looking data.
  const db = await testDb(8);
  await db.run(
    sql`INSERT INTO thread_bindings (id, dot_id, owner_id, title, created_at) VALUES ('t1', 'dotA', 'alice', 'Chat', 1)`,
  );
  await db.run(
    connection(
      'c1',
      'dotA',
      'Mail',
      'https://mail.example.com/mcp',
      'tok',
      [tool('search', true, true, false), tool('send', false, false, true)],
      null,
      100,
    ),
  );
  // The same login, connected again from another Dot.
  await db.run(
    connection(
      'c2',
      'dotB',
      'Mail copy',
      'https://mail.example.com/mcp',
      'tok',
      [tool('search', true, true, true), tool('send', false, true, true)],
      null,
      200,
    ),
  );
  // A different service, with no token and a recorded error.
  await db.run(
    connection(
      'c3',
      'dotA',
      'Tickets',
      'https://tickets.example.com/mcp',
      null,
      [tool('list', true, true, false)],
      'It was down',
      300,
    ),
  );
  await db.run(
    sql`INSERT INTO mcp_approvals (id, thread_id, dot_id, connection_id, tool, arguments, created_at) VALUES ('ap1', 'th', 'dotB', 'c2', 'send', '{}', 1)`,
  );
  await db.run(
    sql`INSERT INTO mcp_actions (thread_id, tool_call_id, connection_id, tool, status, result, created_at, claimed_at, approval_id) VALUES ('th', 'tc', 'c2', 'send', 'done', '{"isError":false,"text":"ok"}', 1, 1, 'ap1')`,
  );
  await db.run(
    sql`INSERT INTO inbox_sources (id, name, kind, type, config, enabled, notify, interval_seconds, created_at, updated_at) VALUES ('s1', 'Mine', 'mail', 'mcp', '{"dotId":"dotB","connectionId":"c2","tool":"search","arguments":{}}', true, 'off', 300, 1, 1)`,
  );

  await migrate(db);

  // Two logins, not three, both belonging to the install's user.
  const accounts = await db.rows<{
    id: string;
    userId: string;
    connector: string;
    name: string;
    config: string;
    secret: string | null;
    tools: string;
    error: string | null;
  }>(sql`SELECT * FROM accounts ORDER BY created_at`);
  expect(
    accounts.map(({ id, userId, name }) => ({ id, userId, name })),
  ).toEqual([
    { id: 'c1', userId: 'alice', name: 'Mail' },
    { id: 'c3', userId: 'alice', name: 'Tickets' },
  ]);
  expect(accounts[0]).toMatchObject({
    connector: 'mcp',
    secret: 'tok',
    error: null,
  });
  expect(JSON.parse(accounts[0].config)).toEqual({
    url: 'https://mail.example.com/mcp',
  });
  expect(accounts[1]).toMatchObject({ secret: null, error: 'It was down' });
  // The catalog keeps what the service said and drops the permissions.
  const catalog = JSON.parse(accounts[0].tools) as Record<string, unknown>[];
  expect(catalog.map((entry) => entry.name)).toEqual(['search', 'send']);
  for (const entry of catalog) {
    expect(entry).not.toHaveProperty('enabled');
    expect(entry).not.toHaveProperty('requiresApproval');
    expect(entry).toHaveProperty('readOnly');
  }

  // One grant per Dot that had the login.
  const grants = await db.rows<{
    id: string;
    accountId: string;
    dotId: string;
  }>(sql`SELECT id, account_id, dot_id FROM grants ORDER BY created_at`);
  expect(grants.map(({ accountId, dotId }) => [accountId, dotId])).toEqual([
    ['c1', 'dotA'],
    ['c1', 'dotB'],
    ['c3', 'dotA'],
  ]);
  const policy = async (grantId: string) =>
    Object.fromEntries(
      (
        await db.rows<{ tool: string; policy: string }>(
          sql`SELECT tool, policy FROM grant_policies WHERE grant_id=${grantId}`,
        )
      ).map((row) => [row.tool, row.policy]),
    );
  // Not enabled became block; needing approval became ask; the rest allow.
  expect(await policy(grants[0].id)).toEqual({
    search: 'allow',
    send: 'block',
  });
  expect(await policy(grants[1].id)).toEqual({ search: 'ask', send: 'ask' });
  expect(await policy(grants[2].id)).toEqual({ list: 'allow' });

  // What referred to a connection now refers to its account, and the receipt
  // keeps the Dot it was for.
  expect(
    await db.row(
      sql`SELECT account_id FROM connector_approvals WHERE id='ap1'`,
    ),
  ).toEqual({ accountId: 'c1' });
  expect(
    await db.row(
      sql`SELECT account_id, dot_id FROM tool_calls WHERE tool_call_id='tc'`,
    ),
  ).toEqual({ accountId: 'c1', dotId: 'dotB' });
  expect(
    JSON.parse(
      (await db.row<{ config: string }>(
        sql`SELECT config FROM inbox_sources WHERE id='s1'`,
      ))!.config,
    ),
  ).toEqual({
    dotId: 'dotB',
    accountId: 'c1',
    tool: 'search',
    arguments: {},
  });
  expect(
    await db.row(sql`SELECT to_regclass('mcp_connections') AS gone`),
  ).toEqual({ gone: null });
});

it('gives connections to the default user when no threads say who the owner is', async () => {
  const db = await testDb(8);
  await db.run(
    connection(
      'c1',
      'dotA',
      'Mail',
      'https://mail.example.com/mcp',
      null,
      [tool('search', true, true, false)],
      null,
      1,
    ),
  );
  await migrate(db);
  expect(await db.row(sql`SELECT user_id FROM accounts`)).toEqual({
    userId: 'opendots-owner',
  });
});

it('migrates a database with no connections', async () => {
  const db = await testDb(8);
  await migrate(db);
  expect(await db.rows(sql`SELECT 1 FROM accounts`)).toEqual([]);
  expect(await db.rows(sql`SELECT 1 FROM grants`)).toEqual([]);
});

it('retires Composio: drops its columns and keeps its discovery sources as disabled history', async () => {
  const db = await testDb(10);
  await db.run(
    sql`INSERT INTO settings VALUES (1, '{"name":"Ada","paused":false,"researchAllowed":true,"memoryAllowed":true,"appsAllowed":true}') ON CONFLICT (id) DO UPDATE SET value=excluded.value`,
  );
  await db.run(
    sql`INSERT INTO discovery_settings VALUES (1, '{"allowedApps":["gmail","microsoft_teams"]}') ON CONFLICT (id) DO UPDATE SET value=excluded.value`,
  );
  await db.run(
    sql`INSERT INTO inbox_sources (id, name, kind, type, config, created_at, updated_at) VALUES ('s1', 'Teams', 'message', 'composio', '{"dotId":"d1","accountId":"ca_1","toolkit":"microsoft_teams"}', 1, 1), ('s2', 'Hook', 'ticket', 'webhook', '{}', 1, 1)`,
  );
  await migrate(db);

  const settings = await db.row<{ value: string }>(
    sql`SELECT value FROM settings WHERE id=1`,
  );
  expect(JSON.parse(settings!.value)).toEqual({
    name: 'Ada',
    paused: false,
    researchAllowed: true,
    memoryAllowed: true,
  });
  const discovery = await db.row<{ value: string }>(
    sql`SELECT value FROM discovery_settings WHERE id=1`,
  );
  expect(JSON.parse(discovery!.value).allowedApps).toEqual(['gmail', 'teams']);
  const sources = await db.rows<{
    id: string;
    type: string;
    enabled: boolean;
    lastError: string | null;
    config: string;
  }>(
    sql`SELECT id, type, enabled, last_error, config FROM inbox_sources ORDER BY id`,
  );
  expect(sources[0]).toMatchObject({
    id: 's1',
    type: 'account',
    enabled: false,
  });
  expect(sources[0].lastError).toMatch(/no longer supported/);
  expect(JSON.parse(sources[0].config)).toEqual({
    dotId: 'd1',
    userId: '',
    accountId: '',
    app: 'teams',
  });
  // Other sources are untouched.
  expect(sources[1]).toMatchObject({ type: 'webhook', enabled: true });
  const columns = await db.rows<{ columnName: string }>(
    sql`SELECT column_name FROM information_schema.columns WHERE table_name='dots' AND table_schema=current_schema()`,
  );
  expect(columns.map((c) => c.columnName)).not.toContain('composio_toolkits');
});
