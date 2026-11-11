import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { createApp } from '../src/server/app.js';
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
function fixture(ownerToken?: string) {
  const store = new Store(':memory:');
  const ws = new WorkspaceStore(':memory:', 'owner');
  cleanup.push(() => {
    store.close();
    ws.close();
  });
  const config = { mode: 'live' as const, baseUrl: 'https://example.com' };
  const platform = new Platform(store, ws, {
    baseUrl: config.baseUrl,
    voiceName: 'marin',
    slackUsers: [],
  });
  return {
    ws,
    platform,
    app: createApp({
      store,
      runner: new Runner(store, config),
      config,
      platform,
      ownerToken,
    }),
  };
}
const request = (body: unknown, method = 'POST') => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

it('supports manual pages without credentials and returns validation, scope and conflict statuses', async () => {
  const { ws, app } = fixture();
  const space = ws.spaces()[0].id;
  const path = `/api/spaces/${space}/pages`;
  expect((await app.request(path, request({ title: '' }))).status).toBe(400);
  expect((await app.request('/api/spaces/missing/pages')).status).toBe(404);
  const result = await app.request(path, request({ title: 'Document' }));
  expect(result.status).toBe(201);
  const page = await result.json();
  expect(
    (
      await app.request(
        `${path}/${page.id}`,
        request({ expectedRevision: 1, content: 'First' }, 'PATCH'),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(
        `${path}/${page.id}`,
        request({ expectedRevision: 1, content: 'Stale' }, 'PATCH'),
      )
    ).status,
  ).toBe(409);
  expect(
    (
      await app.request(
        `${path}/${page.id}/conversation`,
        request({ dotId: ws.dots()[0].id }),
      )
    ).status,
  ).toBe(503);
  expect(ws.pages.get(space, page.id).content).toBe('First');
  expect(
    (
      await app.request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
      })
    ).status,
  ).toBe(400);
});
it('keeps page routes behind owner authentication and browser origin checks', async () => {
  const { ws, app } = fixture('owner-secret');
  const path = `/api/spaces/${ws.spaces()[0].id}/pages`;
  expect((await app.request(path)).status).toBe(401);
  expect(
    (
      await app.request(path, {
        headers: { Authorization: 'Bearer owner-secret' },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(path, {
        ...request({ title: 'Cross-origin' }),
        headers: {
          Authorization: 'Bearer owner-secret',
          'Content-Type': 'application/json',
          Origin: 'https://evil.example',
        },
      })
    ).status,
  ).toBe(403);
});

it('answers malformed JSON and invalid Space access with 400 on workspace routes', async () => {
  const { ws, app } = fixture();
  const dot = ws.dots()[0];
  for (const path of ['/api/spaces', '/api/dots', '/api/conversations']) {
    const response = await app.request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
  }
  const body = {
    name: dot.name,
    instructions: dot.instructions,
    researchAllowed: true,
    memoryAllowed: true,
  };
  expect(
    (
      await app.request(
        '/api/dots',
        request({ ...body, spaceId: 'missing-space' }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await app.request(
        `/api/dots/${dot.id}`,
        request({ ...body, spaceIds: ['missing-space'] }, 'PUT'),
      )
    ).status,
  ).toBe(400);
});

it('keeps upstream JSON parsing failures on workspace routes as 503', async () => {
  const { ws, app } = fixture();
  vi.spyOn(ws, 'createSpace').mockImplementation(() => {
    throw new SyntaxError('Unexpected token in upstream response');
  });
  const response = await app.request(
    '/api/spaces',
    request({ name: 'Valid', description: '' }),
  );
  expect(response.status).toBe(503);
});

it('deletes pages through the API and returns 404 for missing pages or spaces', async () => {
  const { ws, app } = fixture();
  const space = ws.spaces()[0].id;
  const page = ws.pages.create(space, { title: 'To Delete' });
  const path = `/api/spaces/${space}/pages/${page.id}`;

  const res = await app.request(path, request(undefined, 'DELETE'));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(ws.pages.list(space)).toHaveLength(0);

  const missing = await app.request(path, request(undefined, 'DELETE'));
  expect(missing.status).toBe(404);
  expect(await missing.json()).toEqual({
    error: 'Page not found in this Space.',
  });

  const missingSpace = await app.request(
    `/api/spaces/missing-space/pages/${page.id}`,
    request(undefined, 'DELETE'),
  );
  expect(missingSpace.status).toBe(404);
  expect(await missingSpace.json()).toEqual({ error: 'Space not found.' });
});

it.each([
  ['GET', '/page-context'],
  ['POST', '/page'],
])(
  'returns 404 for an unknown conversation on %s %s',
  async (method, suffix) => {
    const { app } = fixture();
    const body = { title: 'Draft' };
    const response = await app.request(
      `/api/conversations/missing${suffix}`,
      method === 'GET' ? undefined : request(body),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: 'Conversation does not belong to this Dot and owner.',
    });
  },
);

it.each([
  new Error('Provider secret'),
  new SyntaxError('Unexpected token in provider secret'),
])(
  'keeps real conversation store failures as 503 without exposing details: %s',
  async (error) => {
    const { ws, app, platform } = fixture();
    ws.bindThread('valid-thread', ws.dots()[0].id, 'Conversation');
    vi.spyOn(platform.pages, 'saveConversation').mockRejectedValueOnce(error);
    const response = await app.request(
      '/api/conversations/valid-thread/page',
      request({ title: 'Draft' }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error:
        'Page operation could not complete. Check setup or retry; your draft has not been discarded.',
    });
  },
);

it('keeps page conversation response parsing failures as 503', async () => {
  const { ws, app, platform } = fixture();
  const dot = ws.dots()[0];
  const page = ws.pages.create(dot.spaceId, { title: 'Document' });
  vi.spyOn(platform.pages, 'conversation').mockRejectedValueOnce(
    new SyntaxError('Unexpected token in provider secret'),
  );
  const response = await app.request(
    `/api/spaces/${dot.spaceId}/pages/${page.id}/conversation`,
    request({ dotId: dot.id }),
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error:
      'Page operation could not complete. Check setup or retry; your draft has not been discarded.',
  });
});

it.each([
  ['POST', '/spaces/space/pages'],
  ['PATCH', '/spaces/space/pages/page'],
  ['POST', '/spaces/space/pages/page/conversation'],
  ['POST', '/conversations/thread/page'],
])(
  'rejects malformed request JSON before any page operation on %s %s',
  async (method, path) => {
    const { app, platform, ws } = fixture();
    const conversation = vi.spyOn(platform.pages, 'conversation');
    const save = vi.spyOn(platform.pages, 'saveConversation');
    const create = vi.spyOn(ws.pages, 'create');
    const update = vi.spyOn(ws.pages, 'update');
    const review = vi.spyOn(ws.pages, 'createReviewed');
    const response = await app.request(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    expect(response.status).toBe(400);
    for (const operation of [conversation, save, create, update, review])
      expect(operation).not.toHaveBeenCalled();
  },
);

it('answers 404, not 503, for a conversation or call that does not exist', async () => {
  const { app } = fixture();
  for (const path of [
    '/api/conversations/missing/capture',
    '/api/voice/calls/missing',
  ]) {
    const response = await app.request(path);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /not found|does not belong/,
    );
  }
});
