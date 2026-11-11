import { Hono } from 'hono';
import { z } from 'zod';
import type { Composio } from '@composio/core';
import type { ConnectedAccount } from '../shared/types.js';

/** The calls the Accounts page needs, so tests can supply a fake. */
export interface ComposioAccountService {
  list(signal?: AbortSignal): Promise<ConnectedAccount[]>;
  connect(
    toolkit: string,
    signal?: AbortSignal,
  ): Promise<{ redirectUrl: string; name: string }>;
  disconnect(id: string, signal?: AbortSignal): Promise<void>;
}

const LIVE_STATUSES = new Set([
  'INITIALIZING',
  'INITIATED',
  'ACTIVE',
  'FAILED',
  'EXPIRED',
  'INACTIVE',
]);

/**
 * Connected accounts for the owner, through Composio. Connecting uses a
 * Tool Router session, the same path as the Connect link a Dot shows in chat,
 * so it works with a key scoped for chat use. Only display fields leave this
 * module: Composio's list response also carries raw credential fields.
 */
export function composioAccountService(
  composio: Composio,
  ownerId: string,
): ComposioAccountService {
  const names = new Map<string, string>();
  let session:
    Promise<Awaited<ReturnType<Composio['sessions']['create']>>> | undefined;
  const connectSession = () =>
    (session ??= composio.sessions
      .create(ownerId, { manageConnections: true, instant: false })
      .catch((error: unknown) => {
        session = undefined;
        throw error;
      }));
  const toolkitName = async (slug: string) => {
    const known = names.get(slug);
    if (known) return known;
    const toolkit = await composio.toolkits.get(slug);
    names.set(slug, toolkit.name);
    return toolkit.name;
  };
  return {
    async list(signal) {
      const accounts: ConnectedAccount[] = [];
      let cursor: string | undefined;
      do {
        const page = await composio.connectedAccounts.list(
          { userIds: [ownerId], limit: 100, ...(cursor ? { cursor } : {}) },
          { signal },
        );
        for (const item of page.items) {
          if (!LIVE_STATUSES.has(item.status)) continue;
          const slug = item.toolkit.slug;
          accounts.push({
            id: item.id,
            toolkit: slug,
            name: await toolkitName(slug).catch(() => slug),
            status: item.status,
            statusReason: item.statusReason ?? null,
            alias: item.alias ?? null,
            disabled: item.isDisabled,
            createdAt: item.createdAt,
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor && accounts.length < 500);
      return accounts;
    },
    async connect(toolkit) {
      const name = await toolkitName(toolkit);
      const request = await (await connectSession()).authorize(toolkit);
      if (!request.redirectUrl)
        throw new Error(`${name} did not return a sign-in link.`);
      return { redirectUrl: request.redirectUrl, name };
    },
    async disconnect(id, signal) {
      await composio.connectedAccounts.delete(id, { signal });
    },
  };
}

const toolkitSchema = z.object({
  toolkit: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{1,80}$/),
});

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(message)) return 'Composio has no app with that name.';
  if (/invalid api key|401|403|forbidden|unauthori/i.test(message))
    return 'Composio refused the request. Check that COMPOSIO_API_KEY is valid and has the Connected accounts and Session permissions.';
  return 'Composio could not complete the request. Try again shortly.';
}

/** GET/POST/DELETE /accounts for the Accounts page. Owner-only like all /api routes. */
export function accountRoutes(
  service: () => ComposioAccountService | undefined,
) {
  const app = new Hono();
  const NOT_CONFIGURED =
    'Connected apps are not set up. Add COMPOSIO_API_KEY to .env and restart OpenDots.';
  app.get('/accounts', async (c) => {
    const accounts = service();
    if (!accounts) return c.json({ error: NOT_CONFIGURED }, 422);
    try {
      return c.json(await accounts.list(c.req.raw.signal));
    } catch (error) {
      console.error('Listing Composio accounts failed:', error);
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.post('/accounts', async (c) => {
    const accounts = service();
    if (!accounts) return c.json({ error: NOT_CONFIGURED }, 422);
    const body = toolkitSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        { error: 'Enter an app name such as gmail or quickbooks.' },
        400,
      );
    try {
      return c.json(
        await accounts.connect(body.data.toolkit, c.req.raw.signal),
      );
    } catch (error) {
      console.error('Starting a Composio connection failed:', error);
      return c.json({ error: failure(error) }, 502);
    }
  });
  app.delete('/accounts/:id', async (c) => {
    const accounts = service();
    if (!accounts) return c.json({ error: NOT_CONFIGURED }, 422);
    const id = c.req.param('id');
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id))
      return c.json({ error: 'Invalid account.' }, 400);
    try {
      // Only disconnect accounts that belong to this owner.
      const owned = await accounts.list(c.req.raw.signal);
      if (!owned.some((account) => account.id === id))
        return c.json({ error: 'Account not found.' }, 404);
      await accounts.disconnect(id, c.req.raw.signal);
      return c.json({ ok: true });
    } catch (error) {
      console.error('Disconnecting a Composio account failed:', error);
      return c.json({ error: failure(error) }, 502);
    }
  });
  return app;
}
