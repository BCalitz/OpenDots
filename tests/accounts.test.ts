import { describe, expect, it, vi } from 'vitest';
import type { Composio } from '@composio/core';
import {
  accountRoutes,
  composioAccountService,
  type ComposioAccountService,
} from '../src/server/composio-accounts.js';
import type { ConnectedAccount } from '../src/shared/types.js';

const gmail: ConnectedAccount = {
  id: 'ca_gmail',
  toolkit: 'gmail',
  name: 'Gmail',
  status: 'ACTIVE',
  statusReason: null,
  alias: null,
  disabled: false,
  createdAt: '2026-11-11T08:00:00.000Z',
};

function fake(overrides: Partial<ComposioAccountService> = {}) {
  const service: ComposioAccountService = {
    list: vi.fn(async () => [gmail]),
    connect: vi.fn(async () => ({
      redirectUrl: 'https://connect.composio.dev/link/abc',
      name: 'QuickBooks',
    })),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
  return { service, app: accountRoutes(() => service) };
}
const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

describe('account routes', () => {
  it('explains how to turn it on without a Composio key', async () => {
    const res = await accountRoutes(() => undefined).request('/accounts');
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatch(/COMPOSIO_API_KEY/);
  });

  it('lists accounts', async () => {
    const { app } = fake();
    const res = await app.request('/accounts');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([gmail]);
  });

  it('starts a connection for a valid app name, normalised', async () => {
    const { app, service } = fake();
    const res = await app.request(
      '/accounts',
      post({ toolkit: ' QuickBooks ' }),
    );
    expect(res.status).toBe(200);
    expect(service.connect).toHaveBeenCalledWith(
      'quickbooks',
      expect.anything(),
    );
    expect((await res.json()).redirectUrl).toMatch(/^https:/);
  });

  it('rejects app names that are not slugs', async () => {
    const { app, service } = fake();
    for (const toolkit of ['', '../x', 'gmail; drop', 'a'.repeat(81)]) {
      const res = await app.request('/accounts', post({ toolkit }));
      expect(res.status).toBe(400);
    }
    expect(service.connect).not.toHaveBeenCalled();
  });

  it('turns Composio errors into a safe message', async () => {
    const { app } = fake({
      connect: vi.fn(async () => {
        throw new Error('Toolkit with slug nope not found (key sk_secret)');
      }),
    });
    const res = await app.request('/accounts', post({ toolkit: 'nope' }));
    expect(res.status).toBe(502);
    const { error } = await res.json();
    expect(error).toBe('Composio has no app with that name.');
    expect(error).not.toContain('sk_secret');
  });

  it("disconnects only the owner's own accounts", async () => {
    const { app, service } = fake();
    const other = await app.request('/accounts/ca_someone_else', {
      method: 'DELETE',
    });
    expect(other.status).toBe(404);
    expect(service.disconnect).not.toHaveBeenCalled();
    const own = await app.request('/accounts/ca_gmail', { method: 'DELETE' });
    expect(own.status).toBe(200);
    expect(service.disconnect).toHaveBeenCalledWith(
      'ca_gmail',
      expect.anything(),
    );
  });
});

describe('composioAccountService', () => {
  it('returns display fields only, never credentials', async () => {
    const composio = {
      connectedAccounts: {
        list: vi.fn(async () => ({
          items: [
            {
              id: 'ca_1',
              toolkit: { slug: 'gmail' },
              status: 'ACTIVE',
              statusReason: null,
              alias: 'work',
              isDisabled: false,
              createdAt: '2026-11-11T08:00:00.000Z',
              updatedAt: '2026-11-11T08:00:00.000Z',
              authConfig: { id: 'ac_1' },
              data: { access_token: 'secret-token' },
              params: { refresh_token: 'secret-refresh' },
              state: { val: { access_token: 'secret-token' } },
            },
            {
              id: 'ca_2',
              toolkit: { slug: 'slack' },
              status: 'REVOKED',
              statusReason: null,
              isDisabled: false,
              createdAt: '2026-11-11T08:00:00.000Z',
            },
          ],
          nextCursor: null,
        })),
        delete: vi.fn(),
      },
      toolkits: { get: vi.fn(async () => ({ name: 'Gmail' })) },
      sessions: { create: vi.fn() },
    } as unknown as Composio;
    const accounts = await composioAccountService(composio, 'owner').list();
    expect(accounts).toEqual([
      {
        id: 'ca_1',
        toolkit: 'gmail',
        name: 'Gmail',
        status: 'ACTIVE',
        statusReason: null,
        alias: 'work',
        disabled: false,
        createdAt: '2026-11-11T08:00:00.000Z',
      },
    ]);
    expect(JSON.stringify(accounts)).not.toContain('secret');
    expect(composio.connectedAccounts.list).toHaveBeenCalledWith(
      expect.objectContaining({ userIds: ['owner'] }),
      expect.anything(),
    );
  });

  it('connects through one reused Tool Router session for the owner', async () => {
    const authorize = vi.fn(async () => ({
      redirectUrl: 'https://connect.composio.dev/link/x',
    }));
    const composio = {
      toolkits: { get: vi.fn(async () => ({ name: 'QuickBooks' })) },
      sessions: { create: vi.fn(async () => ({ authorize })) },
    } as unknown as Composio;
    const service = composioAccountService(composio, 'owner');
    await service.connect('quickbooks');
    await service.connect('gmail');
    expect(composio.sessions.create).toHaveBeenCalledTimes(1);
    expect(composio.sessions.create).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ manageConnections: true }),
    );
    expect(authorize).toHaveBeenCalledWith('quickbooks');
  });
});
