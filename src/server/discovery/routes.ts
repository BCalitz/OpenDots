import { Hono } from 'hono';
import { z } from 'zod';
import {
  DISCOVERY_TOOLKITS,
  type ComposioSourceConfig,
  type DiscoveryState,
} from '../../shared/inbox-types.js';
import type { ComposioAccountService } from '../composio-accounts.js';
import type { Platform } from '../platform.js';
import { DISMISSALS_TO_QUIET, ProposalClosedError } from './proposals.js';

const time = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time such as 07:30.');
const settingsSchema = z
  .object({
    briefTime: time,
    quietHours: z.object({ start: time, end: time }).strict().nullable(),
    holdMinutes: z.number().int().min(0).max(120),
    timeZone: z.string().refine((zone) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return true;
      } catch {
        return false;
      }
    }, 'Unknown time zone.'),
    trusted: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(
            /^(@?[a-z0-9.-]+\.[a-z]{2,}|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})$/,
            'Trusted entries are addresses or domains, such as brightlane.co.za.',
          ),
      )
      .max(50),
    allowedApps: z.array(z.string().regex(/^[a-z0-9_]{1,60}$/)).max(50),
  })
  .partial()
  .strict();

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
      embeddings: {
        configured: !!platform.embedder,
        model: platform.embedder?.model ?? null,
      },
      settings: await store.discovery.settings(),
    };
    return c.json(state);
  });
  app.put('/discovery/settings', async (c) => {
    const body = settingsSchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success)
      return c.json(
        { error: body.error.issues[0]?.message ?? 'Check the settings.' },
        400,
      );
    return c.json(await store.discovery.updateSettings(body.data));
  });
  /** What the next morning brief holds, and what the last one held. */
  app.get('/discovery/brief', async (c) => {
    const lastAt = await store.discovery.lastBriefAt();
    return c.json({
      next: await store.discovery.brief(),
      last: lastAt
        ? { sentAt: lastAt, entries: await store.discovery.brief(lastAt) }
        : null,
    });
  });
  /** One item with its finding and links, for showing it from a chat. */
  app.get('/inbox/events/:id', async (c) => {
    const id = c.req.param('id');
    const event = await store.event(id);
    if (!event)
      return c.json({ error: 'That item is no longer in the inbox.' }, 404);
    return c.json({ event, links: await store.discovery.links(id) });
  });
  app.get('/inbox/events/:id/links', async (c) =>
    c.json(await store.discovery.links(c.req.param('id'))),
  );
  app.get('/discovery/links/review', async (c) =>
    c.json(await store.discovery.reviewQueue()),
  );
  app.post('/discovery/links', async (c) => {
    const body = z
      .object({
        eventId: z.string().min(1).max(200),
        otherEventId: z.string().min(1).max(200),
        status: z.enum(['confirmed', 'rejected']),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Choose a link.' }, 400);
    const found = await store.discovery.decideLink(
      body.data.eventId,
      body.data.otherEventId,
      body.data.status,
    );
    return found
      ? c.json({ ok: true })
      : c.json({ error: 'Link not found.' }, 404);
  });
  /** Jev's raw answers for a finding, as stored. */
  app.get('/inbox/findings/:id/answers', async (c) =>
    c.json({ answers: await store.findingAnswers(c.req.param('id')) }),
  );
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
  /** Proposals, most important first; `?all=1` includes decided ones. */
  app.get('/proposals', async (c) =>
    c.json(
      await store.discovery.proposals.list({ all: c.req.query('all') === '1' }),
    ),
  );
  app.get('/proposals/:id', async (c) => {
    const proposal = await store.discovery.proposals.get(c.req.param('id'));
    return proposal
      ? c.json(proposal)
      : c.json({ error: 'Proposal not found.' }, 404);
  });
  /** The owner's choice: prepare, handle, snooze or dismiss. */
  app.post('/proposals/:id/decide', async (c) => {
    const body = z
      .object({
        choice: z.enum(['prepare', 'handle', 'snooze', 'dismiss']),
        until: z
          .union([z.enum(['later', 'tomorrow']), z.number().int().positive()])
          .optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'Choose what to do.' }, 400);
    try {
      return c.json(
        await platform.proposals.decide(
          c.req.param('id'),
          body.data.choice,
          body.data.until,
        ),
      );
    } catch (error) {
      if (error instanceof ProposalClosedError)
        return c.json({ error: error.message }, 409);
      throw error;
    }
  });
  /** Senders no longer flagged because the owner kept dismissing them. */
  app.get('/discovery/rules', async (c) =>
    c.json(await store.discovery.proposals.rules(DISMISSALS_TO_QUIET)),
  );
  app.delete('/discovery/rules/:sender', async (c) => {
    await store.discovery.proposals.forgetRule(
      c.req.param('sender').toLowerCase(),
    );
    return c.json({ ok: true });
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
