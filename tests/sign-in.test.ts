import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ConnectorService } from '../src/server/connectors/service.js';
import { McpConnector } from '../src/server/connectors/mcp.js';
import { Sealer } from '../src/server/connectors/secrets.js';
import { OAuthFlow } from '../src/server/connectors/oauth.js';
import {
  connectorRoutes,
  oauthCallbackRoute,
} from '../src/server/connectors/routes.js';
import { signInConnectors } from '../src/server/connectors/sign-in.js';
import { GmailConnector, rawMessage } from '../src/server/connectors/gmail.js';
import {
  OutlookConnector,
  TeamsConnector,
} from '../src/server/connectors/microsoft.js';
import { sql } from '../src/server/db/index.js';
import { testDb } from './fixtures/db.js';

const USER = 'owner';
const client = { clientId: 'id', clientSecret: 'secret' };

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}
/** A stand-in for Google and Microsoft: tokens, then whatever `api` answers. */
function fakeWeb(api: (url: string, seen: Seen) => unknown = () => ({})) {
  const seen: Seen[] = [];
  let tokens = 0;
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const record: Seen = {
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ''),
    };
    seen.push(record);
    if (/\/token$/.test(url)) {
      tokens++;
      const refreshing = record.body.includes('grant_type=refresh_token');
      return Response.json({
        access_token: `access-${tokens}`,
        ...(refreshing ? {} : { refresh_token: 'refresh-1' }),
        expires_in: 3600,
      });
    }
    const body = api(url, record);
    return body instanceof Response
      ? body
      : body === null
        ? new Response(null, { status: 202 })
        : Response.json(body);
  }) as typeof fetch;
  return { fetcher, seen, tokens: () => tokens };
}

async function fixture(api?: Parameters<typeof fakeWeb>[0]) {
  const web = fakeWeb(
    api ??
      ((url) =>
        url.endsWith('/profile')
          ? { emailAddress: 'ana@example.com' }
          : { messages: [] }),
  );
  const workspace = await WorkspaceStore.open(await testDb(), USER, 'a-key');
  const dot = (await workspace.dots())[0];
  const service = new ConnectorService(workspace.accounts, workspace.actions, [
    new McpConnector(),
    new GmailConnector(client, web.fetcher),
  ]);
  const flow = new OAuthFlow(workspace.db, service, 'http://localhost:4310');
  return { web, workspace, dot, service, flow };
}
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;

it('encrypts secrets at rest and refuses a wrong key', () => {
  const sealer = new Sealer('one key');
  const sealed = sealer.seal('refresh-token');
  expect(sealed).not.toContain('refresh-token');
  expect(sealer.open(sealed)).toBe('refresh-token');
  expect(sealer.seal(sealed)).toBe(sealed);
  expect(() => new Sealer('another').open(sealed)).toThrow(/SECRETS_KEY/);
  expect(() => new Sealer().open(sealed)).toThrow(/SECRETS_KEY/);
  expect(new Sealer().seal('plain')).toBe('plain');
  expect(sealer.open('plain')).toBe('plain');
});

it('seals secrets saved before a key existed', async () => {
  const db = await testDb();
  const plain = await WorkspaceStore.open(db, USER);
  const created = await plain.accounts.create(
    USER,
    {
      connector: 'mcp',
      name: 'Old',
      config: { url: 'https://x.test' },
      secret: 'tok',
    },
    [],
  );
  const keyed = await WorkspaceStore.open(db, USER, 'a-key');
  const stored = await db.row<{ secret: string }>(
    sql`SELECT secret FROM accounts WHERE id=${created.id}`,
  );
  expect(stored!.secret).toMatch(/^enc:v1:/);
  expect((await keyed.accounts.target(created.id)).secret).toBe('tok');
});

it('signs in: sends the user to Google, then saves the account and grants the Dot', async () => {
  const { web, workspace, dot, service, flow } = await fixture();
  const url = new URL(await flow.start(USER, 'gmail', dot.id));
  expect(url.origin + url.pathname).toBe(
    'https://accounts.google.com/o/oauth2/v2/auth',
  );
  expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'http://localhost:4310/api/oauth/callback',
  );
  expect(url.searchParams.get('access_type')).toBe('offline');
  expect(url.searchParams.get('scope')).toContain('gmail.send');

  const account = await flow.finish(stateOf(url.toString()), 'the-code');
  expect(account).toMatchObject({
    connector: 'gmail',
    name: 'ana@example.com',
    detail: 'Gmail · ana@example.com',
    hasSecret: true,
  });
  expect(account.tools.map((tool) => tool.name)).toContain('send_message');
  expect(JSON.stringify(account)).not.toContain('refresh-1');
  const exchange = web.seen.find((r) => r.body.includes('authorization_code'))!;
  expect(exchange.body).toContain('code=the-code');
  expect(exchange.body).toContain('code_verifier=');

  const stored = await workspace.db.row<{ secret: string }>(
    sql`SELECT secret FROM accounts WHERE id=${account.id}`,
  );
  expect(stored!.secret).toMatch(/^enc:v1:/);
  // Read-only tools start allowed; anything that sends starts as ask.
  const grant = (await service.grants(dot.id))[0];
  const policy = (name: string) =>
    grant.tools.find((tool) => tool.name === name)!.policy;
  expect(policy('search_messages')).toBe('allow');
  expect(policy('send_message')).toBe('ask');
  expect(policy('create_draft')).toBe('ask');
});

it('uses a sign-in state once, only before it expires', async () => {
  const { workspace, service, flow } = await fixture();
  const state = stateOf(await flow.start(USER, 'gmail'));
  await flow.finish(state, 'code');
  await expect(flow.finish(state, 'code')).rejects.toThrow(/expired/);
  await expect(flow.finish('made-up', 'code')).rejects.toThrow(/expired/);
  const late = stateOf(await flow.start(USER, 'gmail'));
  await workspace.db.run(sql`UPDATE oauth_states SET expires_at=1`);
  await expect(flow.finish(late, 'code')).rejects.toThrow(/expired/);
  expect(await service.list(USER)).toHaveLength(1);
});

it('keeps the account with the user who started the sign-in', async () => {
  const { service, flow } = await fixture();
  const state = stateOf(await flow.start('someone-else', 'gmail'));
  await flow.finish(state, 'code');
  expect(await service.list(USER)).toHaveLength(0);
  expect(await service.list('someone-else')).toHaveLength(1);
});

it('says when a service is not set up, and refuses typed-in accounts', async () => {
  const { workspace, service, flow } = await fixture();
  const bare = new ConnectorService(workspace.accounts, workspace.actions, [
    new GmailConnector(undefined),
  ]);
  const unset = new OAuthFlow(workspace.db, bare, 'http://x');
  expect(unset.providers()).toEqual([
    { kind: 'gmail', label: 'Gmail', configured: false },
  ]);
  await expect(unset.start(USER, 'gmail')).rejects.toThrow(/not set up/);
  expect(flow.providers().find((p) => p.kind === 'gmail')!.configured).toBe(
    true,
  );
  await expect(service.add(USER, 'gmail', { name: 'x' })).rejects.toThrow(
    /signing in/,
  );
  await expect(flow.start(USER, 'mcp')).rejects.toThrow(/does not use sign-in/);
});

it('answers the redirect from the service with a place to land', async () => {
  const { service, flow } = await fixture();
  const callback = oauthCallbackRoute(flow);
  const state = stateOf(await flow.start(USER, 'gmail'));
  const ok = await callback.request(`/oauth/callback?state=${state}&code=c`);
  expect(ok.status).toBe(302);
  expect(ok.headers.get('location')).toBe(
    'http://localhost:4310/?connected=gmail',
  );
  const again = await callback.request(`/oauth/callback?state=${state}&code=c`);
  expect(again.headers.get('location')).toContain('connect_error=');
  const denied = await callback.request('/oauth/callback?error=access_denied');
  expect(denied.headers.get('location')).toContain('connect_error=');
  expect(await service.list(USER)).toHaveLength(1);
});

it('starts a sign-in over the API for a Dot that exists', async () => {
  const { workspace, service, flow, dot } = await fixture();
  const routes = connectorRoutes(workspace, service, flow, () => USER);
  const post = (path: string, body: unknown) =>
    routes.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const started = await post('/accounts/sign-in/gmail', { dotId: dot.id });
  expect(((await started.json()) as { url: string }).url).toContain(
    'accounts.google.com',
  );
  expect(
    (await post('/accounts/sign-in/gmail', { dotId: 'nope' })).status,
  ).toBe(400);
  const listed = await routes.request('/accounts/providers');
  expect(await listed.json()).toContainEqual({
    kind: 'gmail',
    label: 'Gmail',
    configured: true,
  });
});

it('refreshes access tokens when they are needed, and only then', async () => {
  const { web, workspace, flow } = await fixture((url) =>
    url.includes('/messages?') ? { messages: [] } : { emailAddress: 'a@b.co' },
  );
  const account = await flow.finish(
    stateOf(await flow.start(USER, 'gmail')),
    'c',
  );
  const target = await workspace.accounts.target(account.id);
  const gmail = new GmailConnector(client, web.fetcher);
  const before = web.tokens();
  await gmail.call(target, 'search_messages', { query: 'x' });
  await gmail.call(target, 'search_messages', { query: 'y' });
  // A new connector refreshes once, then reuses the access token.
  expect(web.tokens() - before).toBe(1);
  expect(
    web.seen
      .filter((r) => r.url.includes('/messages?'))
      .every((r) => /^Bearer access-\d+$/.test(r.headers.Authorization)),
  ).toBe(true);
});

it('searches and reads Gmail', async () => {
  const message = {
    id: 'm1',
    threadId: 't-m1',
    snippet: 'hello',
    labelIds: ['UNREAD'],
    payload: {
      headers: [
        { name: 'From', value: 'Bo <bo@x.com>' },
        { name: 'Subject', value: 'Plan' },
      ],
      mimeType: 'multipart/alternative',
      parts: [
        {
          mimeType: 'text/plain',
          body: { data: Buffer.from('The body').toString('base64url') },
        },
      ],
    },
  };
  const { web, workspace, flow } = await fixture((url) => {
    if (url.endsWith('/profile')) return { emailAddress: 'ana@example.com' };
    if (url.includes('/messages?')) return { messages: [{ id: 'm1' }] };
    return message;
  });
  const account = await flow.finish(
    stateOf(await flow.start(USER, 'gmail')),
    'c',
  );
  const target = await workspace.accounts.target(account.id);
  const gmail = new GmailConnector(client, web.fetcher);
  const found = await gmail.call(target, 'search_messages', {
    query: 'from:bo',
  });
  expect(found.isError).toBe(false);
  expect(JSON.parse(found.text)[0]).toMatchObject({
    id: 'm1',
    from: 'Bo <bo@x.com>',
    subject: 'Plan',
    unread: true,
  });
  expect(web.seen.some((r) => r.url.includes('q=from%3Abo'))).toBe(true);
  const read = await gmail.call(target, 'read_message', { id: 'm1' });
  expect(JSON.parse(read.text).body).toBe('The body');
});

it('builds a safe message: no header injection, replies stay in the thread', async () => {
  const raw = Buffer.from(
    rawMessage({
      to: ['a@x.com'],
      subject: 'Hi\r\nBcc: evil@x.com',
      body: 'Ünïcode body',
    }),
    'base64url',
  ).toString();
  expect(raw).not.toMatch(/^Bcc:/m);
  expect(raw).toContain('Subject: Hi Bcc: evil@x.com');
  expect(raw).toContain(Buffer.from('Ünïcode body').toString('base64'));
  const { web, workspace, flow } = await fixture((url, seen) => {
    if (url.endsWith('/profile')) return { emailAddress: 'ana@example.com' };
    if (url.includes('/send'))
      return { id: 'sent', threadId: JSON.parse(seen.body).threadId };
    return {
      id: 'm1',
      threadId: 'thread-9',
      payload: {
        headers: [
          { name: 'From', value: 'Bo <bo@x.com>' },
          { name: 'Subject', value: 'Plan' },
          { name: 'Message-ID', value: '<abc@x.com>' },
        ],
      },
    };
  });
  const account = await flow.finish(
    stateOf(await flow.start(USER, 'gmail')),
    'c',
  );
  const target = await workspace.accounts.target(account.id);
  const gmail = new GmailConnector(client, web.fetcher);
  const reply = await gmail.call(target, 'reply_to_message', {
    id: 'm1',
    body: 'Thanks',
  });
  expect(JSON.parse(reply.text)).toMatchObject({
    sent: true,
    threadId: 'thread-9',
  });
  const sent = JSON.parse(
    web.seen.find((r) => r.url.endsWith('/messages/send'))!.body,
  );
  const text = Buffer.from(sent.raw, 'base64url').toString();
  expect(text).toContain('To: bo@x.com');
  expect(text).toContain('Subject: Re: Plan');
  expect(text).toContain('In-Reply-To: <abc@x.com>');
  const bad = await gmail.call(target, 'send_message', {
    to: ['not an address'],
    subject: 's',
    body: 'b',
  });
  expect(bad.isError).toBe(true);
  expect(bad.text).toMatch(/Invalid arguments/);
});

it('reports a rejected sign-in as a readable error, never a stack', async () => {
  const web = fakeWeb(() => new Response('{}', { status: 401 }));
  const gmail = new GmailConnector(client, web.fetcher);
  await expect(
    gmail.discover({ config: {}, secret: 'refresh-1' }),
  ).rejects.toThrow(/connect it again/);
  const result = await gmail.call(
    { config: {}, secret: 'refresh-1' },
    'search_messages',
    {},
  );
  expect(result.isError).toBe(true);
  expect(result.text).toMatch(/connect it again/);
});

it('talks to Outlook and Teams through Microsoft Graph', async () => {
  const web = fakeWeb((url, seen) => {
    if (url.endsWith('/me'))
      return { displayName: 'Ana', mail: 'ana@corp.com' };
    if (url.includes('/me/messages?'))
      return {
        value: [
          {
            id: 'o1',
            subject: 'Budget',
            from: { emailAddress: { name: 'Bo', address: 'bo@corp.com' } },
            bodyPreview: 'numbers',
            isRead: false,
          },
        ],
      };
    if (url.endsWith('/sendMail')) return null;
    if (url.includes('/chats/c1/messages') && seen.method === 'GET')
      return {
        value: [
          {
            id: 'x',
            from: { user: { displayName: 'Bo' } },
            body: { content: '<p>Hi &amp; bye</p>' },
          },
          { id: 'gone', deletedDateTime: '2026-01-01', body: { content: 'x' } },
        ],
      };
    if (url.includes('/chats/c1/messages')) return { id: 'sent1' };
    return {};
  });
  const secret = 'refresh-1';
  const outlook = new OutlookConnector(
    { ...client, tenant: 'corp' },
    web.fetcher,
  );
  expect(outlook.app!.authorizeUrl('s', 'v', 'http://r')).toContain(
    'login.microsoftonline.com/corp/oauth2/v2.0/authorize',
  );
  expect(await outlook.signedIn(secret)).toEqual({
    name: 'ana@corp.com',
    config: { email: 'ana@corp.com' },
  });
  const found = await outlook.call({ config: {}, secret }, 'search_messages', {
    query: 'bud"get',
  });
  expect(JSON.parse(found.text)[0]).toMatchObject({
    from: 'Bo <bo@corp.com>',
    unread: true,
  });
  expect(
    decodeURIComponent(web.seen.find((r) => r.url.includes('$search'))!.url),
  ).toContain('$search="budget"');
  const sent = await outlook.call({ config: {}, secret }, 'send_message', {
    to: ['bo@corp.com'],
    subject: 'Hi',
    body: 'Yo',
  });
  expect(JSON.parse(sent.text)).toEqual({ sent: true });

  const teams = new TeamsConnector(client, web.fetcher);
  const chat = await teams.call({ config: {}, secret }, 'list_chat_messages', {
    chatId: 'c1',
  });
  expect(JSON.parse(chat.text)).toEqual([
    { id: 'x', from: 'Bo', text: 'Hi & bye' },
  ]);
  const posted = await teams.call({ config: {}, secret }, 'send_chat_message', {
    chatId: 'c1',
    text: 'Hello',
  });
  expect(JSON.parse(posted.text)).toEqual({ sent: true, id: 'sent1' });
  const tools = await teams.discover({ config: {}, secret });
  expect(
    Object.fromEntries(tools.map((tool) => [tool.name, tool.readOnly])),
  ).toMatchObject({ list_teams: true, send_chat_message: false });
});

it('sets up sign-in from the environment, and insists on a key', () => {
  expect(signInConnectors({}).map((c) => c.kind)).toEqual([
    'gmail',
    'outlook',
    'teams',
  ]);
  const configured = { GOOGLE_CLIENT_ID: 'a', GOOGLE_CLIENT_SECRET: 'b' };
  expect(() => signInConnectors(configured)).toThrow(/SECRETS_KEY/);
  expect(signInConnectors({ ...configured, SECRETS_KEY: 'k' })).toHaveLength(3);
});
