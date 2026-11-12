import { Hono } from 'hono';
import { z } from 'zod';
import type { Platform } from '../platform.js';
import { WEBHOOK_FORMAT } from './webhook-source.js';

const kind = z.enum(['ticket', 'mail', 'message', 'calendar']);
const notify = z.enum(['off', 'urgent', 'high', 'all']);
const interval = z.number().int().min(60).max(86_400);
const path = z.string().trim().min(1).max(200);
const fields = z
  .object({
    items: path,
    id: path,
    title: path,
    summary: path,
    priority: path,
    url: path,
    from: path,
    at: path,
  })
  .partial()
  .strict();
const mcpConfig = z
  .object({
    dotId: z.string().min(1).max(200),
    connectionId: z.string().min(1).max(200),
    tool: z.string().min(1).max(128),
    arguments: z.record(z.string(), z.unknown()).default({}),
    fields: fields.optional(),
  })
  .strict();
const createSource = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('mcp'),
      name: z.string().trim().min(1).max(60),
      kind,
      notify: notify.default('urgent'),
      intervalSeconds: interval.default(300),
      config: mcpConfig,
    })
    .strict(),
  z
    .object({
      type: z.literal('webhook'),
      name: z.string().trim().min(1).max(60),
      kind,
      notify: notify.default('urgent'),
    })
    .strict(),
]);
const hookUrl = (id: string) => `/api/inbox/hooks/${id}`;

/** Checks an MCP source points at a tool its Dot can run on a timer. */
async function validateMcp(
  platform: Platform,
  config: z.infer<typeof mcpConfig>,
) {
  if (!(await platform.workspace.dot(config.dotId))) return 'Dot not found.';
  const connection = await platform.workspace.connections.get(
    config.connectionId,
  );
  if (!connection || connection.dotId !== config.dotId)
    return 'That connection does not belong to this Dot.';
  const tool = connection.tools.find((item) => item.name === config.tool);
  if (!tool?.enabled) return 'That tool is not enabled on the connection.';
  if (tool.requiresApproval)
    return 'This tool asks for approval on every call, so it cannot run on a timer. Pick a read-only list tool, or let this one run without asking.';
  if (JSON.stringify(config.arguments).length > 8000)
    return 'Tool arguments are too large.';
  return undefined;
}

/** The event engine's owner routes. The webhook route is public; see inboxHookRoute. */
export function inboxRoutes(platform: Platform) {
  const app = new Hono();
  const store = platform.inbox.store;
  app.get('/inbox', async (c) => {
    const query = z
      .object({
        sourceId: z.string().max(200).optional(),
        state: z.enum(['new', 'seen', 'dismissed']).optional(),
        all: z.enum(['0', '1']).optional(),
      })
      .safeParse(c.req.query());
    if (!query.success) return c.json({ error: 'Invalid inbox filter.' }, 400);
    return c.json({
      sources: await store.sources(),
      events: await store.events({
        sourceId: query.data.sourceId,
        state: query.data.state,
        includeDismissed: query.data.all === '1',
      }),
    });
  });
  app.get('/inbox/links', async (c) => {
    const days = z.coerce
      .number()
      .int()
      .min(1)
      .max(3650)
      .catch(90)
      .parse(c.req.query('days') ?? 90);
    return c.json(await store.links(days));
  });
  app.post('/inbox/sources', async (c) => {
    const parsed = createSource.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        {
          error:
            'Name the source, choose what it watches, and pick a connection tool or webhook.',
        },
        400,
      );
    const value = parsed.data;
    if (value.type === 'mcp') {
      const problem = await validateMcp(platform, value.config);
      if (problem) return c.json({ error: problem }, 400);
      const { source } = await store.create({
        ...value,
        config: value.config,
      });
      return c.json({ source }, 201);
    }
    const { source, secret } = await store.create({
      ...value,
      config: {},
      intervalSeconds: 0,
    });
    return c.json({ source, secret, url: hookUrl(source.id) }, 201);
  });
  app.patch('/inbox/sources/:id', async (c) => {
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(60).optional(),
        enabled: z.boolean().optional(),
        notify: notify.optional(),
        intervalSeconds: interval.optional(),
        config: mcpConfig.optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: 'Invalid source settings.' }, 400);
    const current = await store.source(c.req.param('id'));
    if (!current) return c.json({ error: 'Source not found.' }, 404);
    if (parsed.data.config) {
      if (current.type !== 'mcp')
        return c.json({ error: 'Webhook sources have no tool.' }, 400);
      const problem = await validateMcp(platform, parsed.data.config);
      if (problem) return c.json({ error: problem }, 400);
    }
    return c.json(await store.update(current.id, parsed.data));
  });
  app.delete('/inbox/sources/:id', async (c) =>
    (await store.remove(c.req.param('id')))
      ? c.json({ ok: true })
      : c.json({ error: 'Source not found.' }, 404),
  );
  app.post('/inbox/sources/:id/poll', async (c) => {
    if (!(await store.pollNow(c.req.param('id'))))
      return c.json({ error: 'Only connection sources can be polled.' }, 404);
    void platform.inbox.tick();
    return c.json({ ok: true });
  });
  app.post('/inbox/sources/:id/secret', async (c) => {
    const secret = await store.rotateSecret(c.req.param('id'));
    return secret
      ? c.json({ secret, url: hookUrl(c.req.param('id')) })
      : c.json({ error: 'Webhook source not found.' }, 404);
  });
  app.get('/inbox/events/:id/raw', async (c) => {
    const raw = await store.payload(c.req.param('id'));
    return raw === undefined
      ? c.json({ error: 'Event not found.' }, 404)
      : c.json({ raw });
  });
  app.post('/inbox/events/:id', async (c) => {
    const parsed = z
      .object({ state: z.enum(['new', 'seen', 'dismissed']) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Unknown event state.' }, 400);
    const event = await store.setState(c.req.param('id'), parsed.data.state);
    return event ? c.json(event) : c.json({ error: 'Event not found.' }, 404);
  });
  return app;
}

/**
 * POST /api/inbox/hooks/:id. Outside services cannot hold the owner token,
 * so each webhook source has its own secret, sent as a bearer token or in
 * X-OpenDots-Secret. Mounted ahead of the owner-token middleware.
 */
export function inboxHookRoute(platform: Platform) {
  const app = new Hono();
  app.post('/inbox/hooks/:id', async (c) => {
    c.header('Cache-Control', 'no-store');
    const id = c.req.param('id');
    const secret =
      c.req.header('x-opendots-secret') ??
      c.req.header('authorization')?.replace(/^Bearer /, '') ??
      '';
    // One answer for a wrong secret and an unknown source.
    if (!(await platform.inbox.store.verifySecret(id, secret)))
      return c.json({ error: 'Unknown source or wrong secret.' }, 401);
    if (!c.req.header('content-type')?.includes('application/json'))
      return c.json({ error: 'Use application/json.' }, 415);
    const body = await c.req.json().catch(() => undefined);
    if (body === undefined) return c.json({ error: WEBHOOK_FORMAT }, 400);
    try {
      return c.json(await platform.inbox.receive(id, body), 202);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : WEBHOOK_FORMAT },
        400,
      );
    }
  });
  return app;
}
