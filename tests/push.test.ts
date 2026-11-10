import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { Store } from '../src/server/store.js';
import { Runner } from '../src/server/runner.js';
import type { Config } from '../src/server/research.js';
import {
  EXPO_PUSH_URL,
  PushService,
  scheduledResultMessage,
} from '../src/server/push.js';

const config: Config = { mode: 'sample', baseUrl: 'https://api.openai.com/v1' };
const closers: { close(): void }[] = [];
afterEach(() => closers.splice(0).forEach((item) => item.close()));
const token = 'ExponentPushToken[abcdefghijklmnop]';
const other = 'ExponentPushToken[qrstuvwxyz012345]';

function tickets(...statuses: ('ok' | 'gone')[]) {
  return vi.fn(
    async (..._args: Parameters<typeof fetch>) =>
      new Response(
        JSON.stringify({
          data: statuses.map((status) =>
            status === 'ok'
              ? { status: 'ok', id: 'ticket' }
              : {
                  status: 'error',
                  message: 'gone',
                  details: { error: 'DeviceNotRegistered' },
                },
          ),
        }),
      ),
  );
}
function service(fetchImpl: typeof fetch, previews = false) {
  const push = new PushService(':memory:', { fetch: fetchImpl, previews });
  closers.push(push);
  return push;
}

describe('PushService', () => {
  it('sends one message per device to the Expo push service', async () => {
    const fetchImpl = tickets('ok', 'ok');
    const push = service(fetchImpl as unknown as typeof fetch);
    push.register({ token, platform: 'ios' });
    push.register({ token: other, platform: 'android' });

    expect(
      await push.send({ title: 'T', body: 'B', data: { threadId: 'th' } }),
    ).toEqual({ sent: 2, failed: 0 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(EXPO_PUSH_URL);
    const body = JSON.parse(String(init?.body));
    expect(body.map((m: { to: string }) => m.to)).toEqual([token, other]);
    expect(body[0]).toMatchObject({
      title: 'T',
      body: 'B',
      data: { threadId: 'th' },
    });
  });

  it('forgets devices the push service reports as unregistered', async () => {
    const push = service(tickets('gone', 'ok') as unknown as typeof fetch);
    push.register({ token, platform: 'ios' });
    push.register({ token: other, platform: 'android' });

    expect(await push.send({ title: 'T', body: 'B', data: {} })).toEqual({
      sent: 1,
      failed: 1,
    });
    expect(push.devices().map((device) => device.token)).toEqual([other]);
  });

  it('does not throw when the push service is unreachable', async () => {
    const push = service((async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch);
    push.register({ token, platform: 'ios' });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await push.send({ title: 'T', body: 'B', data: {} })).toEqual({
      sent: 0,
      failed: 1,
    });
  });

  it('skips the network when no devices are registered', async () => {
    const fetchImpl = tickets();
    const push = service(fetchImpl as unknown as typeof fetch);
    expect(await push.send({ title: 'T', body: 'B', data: {} })).toEqual({
      sent: 0,
      failed: 0,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('hides result text unless previews are enabled', () => {
    const quiet = service(tickets() as unknown as typeof fetch);
    const loud = service(tickets() as unknown as typeof fetch, true);
    const outcome = { text: 'GS-142 is overdue and assigned to you.' };

    expect(scheduledResultMessage(quiet, 'Scout', 'th', outcome)).toEqual({
      title: 'Scout has an update',
      body: 'Open the conversation to see the result.',
      data: { threadId: 'th' },
    });
    expect(scheduledResultMessage(loud, 'Scout', 'th', outcome).body).toBe(
      outcome.text,
    );
    expect(
      scheduledResultMessage(loud, 'Scout', 'th', { error: 'Timed out' }),
    ).toMatchObject({
      title: 'Scout: scheduled task failed',
      body: 'Timed out',
    });
  });
});

describe('push device routes', () => {
  function fixture() {
    const store = new Store(':memory:');
    const push = service(tickets('ok') as unknown as typeof fetch);
    closers.push(store);
    const app = createApp({
      store,
      runner: new Runner(store, config),
      config,
      ownerToken: 'owner-token-for-push-tests',
      push,
    });
    const request = (path: string, method: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          Authorization: 'Bearer owner-token-for-push-tests',
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { push, app, request };
  }

  it('requires the owner token', async () => {
    const { app } = fixture();
    const response = await app.request('/api/push/devices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, platform: 'ios' }),
    });
    expect(response.status).toBe(401);
  });

  it('registers, tests and removes a device', async () => {
    const { push, request } = fixture();
    expect(
      (await request('/api/push/devices', 'POST', { token, platform: 'ios' }))
        .status,
    ).toBe(201);
    expect(push.devices()).toHaveLength(1);
    expect((await request('/api/push/test', 'POST', {})).status).toBe(200);
    expect(
      (await request('/api/push/devices', 'DELETE', { token })).status,
    ).toBe(200);
    expect(push.devices()).toHaveLength(0);
  });

  it('rejects malformed tokens', async () => {
    const { request } = fixture();
    expect(
      (
        await request('/api/push/devices', 'POST', {
          token: 'not-a-token',
          platform: 'ios',
        })
      ).status,
    ).toBe(400);
  });
});
