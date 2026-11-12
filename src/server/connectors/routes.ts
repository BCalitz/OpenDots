import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from '../workspace.js';
import type { OAuthFlow } from './oauth.js';
import type { ConnectorService } from './service.js';

const policy = z.enum(['allow', 'ask', 'block']);
const create = z
  .object({ connector: z.string().trim().min(1).max(40) })
  .passthrough();

/**
 * A user's connected accounts, and the grants that let a Dot use them.
 *
 * `userOf` says who is asking. Until sign-in exists it is the one configured
 * owner; when it does, this is the only place that changes: every account and
 * grant below is already read and written for that user and nobody else.
 */
export function connectorRoutes(
  workspace: WorkspaceStore,
  connectors: ConnectorService,
  flow: OAuthFlow,
  userOf: (c: Context) => string = () => workspace.ownerId,
) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'Invalid request.')
            : error.message,
      },
      400,
    ),
  );
  const requireDot = async (id: string) => {
    if (!(await workspace.dot(id))) throw new Error('Dot not found.');
    return id;
  };
  app.get('/accounts', async (c) => c.json(await connectors.list(userOf(c))));
  // Services the user signs in to, and whether this server is set up for each.
  app.get('/accounts/providers', (c) => c.json(flow.providers()));
  app.post('/accounts/sign-in/:kind', async (c) => {
    const body = z
      .object({ dotId: z.string().optional() })
      .strict()
      .parse(await c.req.json());
    const dotId = body.dotId && (await requireDot(body.dotId));
    return c.json({
      url: await flow.start(userOf(c), c.req.param('kind'), dotId),
    });
  });
  app.post('/accounts', async (c) => {
    const { connector, ...input } = create.parse(await c.req.json());
    return c.json(await connectors.add(userOf(c), connector, input), 201);
  });
  app.post('/accounts/:id/refresh', async (c) =>
    c.json(await connectors.refresh(userOf(c), c.req.param('id'))),
  );
  app.delete('/accounts/:id', async (c) => {
    if (!(await connectors.remove(userOf(c), c.req.param('id'))))
      throw new Error('Account not found.');
    return c.json({ ok: true });
  });
  app.get('/dots/:id/grants', async (c) =>
    c.json(await connectors.grants(await requireDot(c.req.param('id')))),
  );
  app.put('/dots/:id/grants/:accountId', async (c) =>
    c.json(
      await connectors.grant(
        userOf(c),
        await requireDot(c.req.param('id')),
        c.req.param('accountId'),
      ),
    ),
  );
  app.delete('/dots/:id/grants/:accountId', async (c) => {
    if (
      !(await connectors.revoke(
        userOf(c),
        await requireDot(c.req.param('id')),
        c.req.param('accountId'),
      ))
    )
      throw new Error('This Dot does not use that account.');
    return c.json({ ok: true });
  });
  app.patch('/dots/:id/grants/:accountId/tools/:name', async (c) => {
    const body = z
      .object({ policy })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await connectors.setPolicy(
        userOf(c),
        await requireDot(c.req.param('id')),
        c.req.param('accountId'),
        c.req.param('name'),
        body.policy,
      ),
    );
  });
  return app;
}

/**
 * Where a service sends the browser back after sign-in. It carries no owner
 * token (the browser is arriving from another site), so it is answered before
 * the token checks and trusts only the one-time state it issued.
 */
export function oauthCallbackRoute(flow: OAuthFlow) {
  const app = new Hono();
  app.get('/oauth/callback', async (c) => {
    const { state, code, error } = c.req.query();
    const back = (params: Record<string, string>) =>
      c.redirect(`${flow.publicUrl}/?${new URLSearchParams(params)}`);
    if (error || !state || !code)
      return back({ connect_error: 'The sign-in was cancelled.' });
    try {
      const account = await flow.finish(state, code);
      return back({ connected: account.connector });
    } catch (failure) {
      return back({
        connect_error:
          failure instanceof Error ? failure.message : 'Sign-in failed.',
      });
    }
  });
  return app;
}
