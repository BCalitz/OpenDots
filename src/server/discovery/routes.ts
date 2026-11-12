import { Hono } from 'hono';
import { z } from 'zod';
import {
  DISCOVERY_TOOLKITS,
  type ComposioSourceConfig,
  type DiscoveryState,
} from '../../shared/inbox-types.js';
import type { ComposioAccountService } from '../composio-accounts.js';
import type { Platform } from '../platform.js';

/** Discovery settings per connected account, and starting investigations. */
export function discoveryRoutes(
  platform: Platform,
  accounts: () => ComposioAccountService | undefined,
) {
  const app = new Hono();
  const store = platform.inbox.store;
  app.get('/discovery', async (c) => {
    const { config } = platform;
    const state: DiscoveryState = {
      accounts: (await store.composioSources()).map((source) => {
        const value = source.config as ComposioSourceConfig;
        return {
          sourceId: source.id,
          accountId: value.accountId,
          toolkit: value.toolkit,
          dotId: value.dotId,
          enabled: source.enabled,
          intervalSeconds: source.intervalSeconds,
          lastPolledAt: source.lastPolledAt,
          lastError: source.lastError,
        };
      }),
      model: { configured: !!config.typesafeApiKey },
    };
    return c.json(state);
  });
  app.put('/discovery/accounts/:accountId', async (c) => {
    const accountId = c.req.param('accountId');
    const body = z
      .object({
        dotId: z.string().min(1).max(200),
        enabled: z.boolean(),
        intervalSeconds: z.number().int().min(60).max(86_400).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId))
      return c.json({ error: 'Choose a Dot to look into what it finds.' }, 400);
    const service = accounts();
    if (!service)
      return c.json(
        {
          error:
            'Connected apps are not set up. Add COMPOSIO_API_KEY to .env and restart OpenDots.',
        },
        422,
      );
    const dot = await platform.workspace.dot(body.data.dotId);
    if (!dot) return c.json({ error: 'Dot not found.' }, 400);
    let account;
    try {
      account = (await service.list(c.req.raw.signal)).find(
        (item) => item.id === accountId,
      );
    } catch {
      return c.json(
        {
          error: 'Composio could not complete the request. Try again shortly.',
        },
        502,
      );
    }
    if (!account) return c.json({ error: 'Account not found.' }, 404);
    const toolkit = DISCOVERY_TOOLKITS[account.toolkit];
    if (!toolkit)
      return c.json(
        { error: `Discovery cannot read ${account.name} yet.` },
        400,
      );
    const config: ComposioSourceConfig = {
      dotId: dot.id,
      accountId: account.id,
      toolkit: account.toolkit,
    };
    const existing = await store.composioSource(account.id);
    const source = existing
      ? (await store.update(existing.id, {
          config,
          enabled: body.data.enabled,
          ...(body.data.intervalSeconds
            ? { intervalSeconds: body.data.intervalSeconds }
            : {}),
        }))!
      : (
          await store.create({
            name: `${toolkit.name}${account.alias ? ` (${account.alias})` : ''}`,
            kind: toolkit.kind,
            type: 'composio',
            config,
            // Discovery notifies when a Dot has something to say, not per item.
            notify: 'off',
            intervalSeconds: body.data.intervalSeconds ?? 300,
          })
        ).source;
    if (!existing && !body.data.enabled)
      await store.update(source.id, { enabled: false });
    if (body.data.enabled) {
      await store.pollNow(source.id);
      void platform.inbox.tick();
    }
    const settings = await platform.store.settings();
    return c.json({
      sourceId: source.id,
      // Without app access the Dot cannot check other apps while investigating.
      warning:
        !settings.appsAllowed || !dot.appsAllowed
          ? `${dot.name} cannot use connected apps yet, so it can only read the item itself. Turn on Connected apps in Settings and in ${dot.name}’s settings.`
          : undefined,
    });
  });
  app.post('/inbox/findings/:id/investigate', async (c) => {
    try {
      return c.json(await platform.discovery.investigate(c.req.param('id')));
    } catch (error) {
      return c.json(
        {
          error: error instanceof Error ? error.message : 'Finding not found.',
        },
        404,
      );
    }
  });
  return app;
}
