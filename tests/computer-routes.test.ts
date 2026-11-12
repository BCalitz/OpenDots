import { expect, it } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { ComputerService } from '../src/server/computer-service.js';
import { computerRoutes } from '../src/server/computer-routes.js';
import { testDb } from './fixtures/db.js';

async function fixture() {
  const workspace = await WorkspaceStore.open(await testDb(), 'owner');
  const id = (await workspace.dots())[0].id;
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
  };
  // No computer supervisor configured: `configured` is false, so any
  // action that reaches `allowed()` fails with a plain domain error
  // rather than attempting a network call.
  const service = new ComputerService(workspace, config, async () => false);
  const app = computerRoutes(service);
  return { workspace, id, app };
}

// `configured: true`, so `allowed()` reaches its permission check instead of
// failing earlier with "Computer service is not configured."; `transport` is
// never called because `allowed()` throws before any network request.
async function configuredFixture() {
  const workspace = await WorkspaceStore.open(await testDb(), 'owner');
  const id = (await workspace.dots())[0].id;
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    computerSupervisorUrl: 'https://supervisor.example.com',
    computerSupervisorToken: 'supervisor-token',
    computerToken: 'computer-token',
  };
  const transport = () => {
    throw new Error('transport should not be called in this test');
  };
  const service = new ComputerService(
    workspace,
    config,
    async () => false,
    transport,
  );
  const app = computerRoutes(service);
  return { workspace, id, app };
}

it('answers malformed JSON on the actions route with 400, not a service error', async () => {
  const { app, id } = await fixture();
  const response = await app.request(`/dots/${id}/computer/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{',
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Invalid JSON request.' });
});

it('answers an invalid action shape with 400 from the Zod schema', async () => {
  const { app, id } = await fixture();
  const response = await app.request(`/dots/${id}/computer/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Invalid computer request.' });
});

it('answers an unconfigured computer service with 503, not 400', async () => {
  const { app, id } = await fixture();
  const response = await app.request(`/dots/${id}/computer/start`, {
    method: 'POST',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Computer service is not configured.',
  });
});

it('answers an unknown Dot id with 404, not a service error', async () => {
  const { app } = await fixture();
  const response = await app.request('/dots/missing/computer/start', {
    method: 'POST',
  });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: 'Dot not found.' });
});

it('answers an unknown computer action with 400, not a service error', async () => {
  const { app, id } = await fixture();
  const response = await app.request(`/dots/${id}/computer/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'not_a_real_action', input: {} }),
  });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: 'Unknown computer action.' });
});

it('answers a disabled computer permission with 403, not a service error', async () => {
  const { app, id, workspace } = await configuredFixture();
  await workspace.computers.patch(id, { enabled: false });
  const response = await app.request(`/dots/${id}/computer/take`, {
    method: 'POST',
  });
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: 'Computer permission is disabled.',
  });
});

// `stateSchema`/`controlSchema` also validate the supervisor's own response,
// so a malformed upstream body must not be mistaken for the caller's fault:
// it is a service failure (503), not an invalid request (400).
async function upstreamFixture(responses: Record<string, unknown>) {
  const workspace = await WorkspaceStore.open(await testDb(), 'owner');
  const id = (await workspace.dots())[0].id;
  await workspace.computers.patch(id, { enabled: true, browser: true });
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    computerSupervisorUrl: 'https://supervisor.example.com',
    computerSupervisorToken: 'supervisor-token',
    computerToken: 'computer-token',
  };
  const transport = async (url: RequestInfo | URL) => {
    for (const [suffix, body] of Object.entries(responses))
      if (String(url).endsWith(suffix))
        return new Response(JSON.stringify(body), { status: 200 });
    throw new Error(`transport should not be called for ${url}`);
  };
  const service = new ComputerService(
    workspace,
    config,
    async () => false,
    transport,
  );
  const app = computerRoutes(service);
  return { id, app };
}

it('answers a malformed supervisor ensure response with 503, not a caller validation error', async () => {
  const { app, id } = await upstreamFixture({ '/ensure': {} });
  const response = await app.request(`/dots/${id}/computer/start`, {
    method: 'POST',
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Computer service returned an invalid response.',
  });
});

it('answers a malformed supervisor listing response with 503, not a caller validation error', async () => {
  const { app, id } = await upstreamFixture({
    '/computers': { computers: [{ botId: 'placeholder' }] },
  });
  const response = await app.request(`/dots/${id}/computer/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'read', input: {} }),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'Computer service returned an invalid response.',
  });
});
