import { Hono } from 'hono';
import { z } from 'zod';
import type { WorkspaceStore } from './workspace.js';
import { connectionInput, type ConnectionService } from './connections.js';
export function connectionRoutes(
  workspace: WorkspaceStore,
  connections: ConnectionService,
) {
  const app = new Hono();
  app.onError((error, c) =>
    c.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'Invalid connection request.')
            : error.message,
      },
      400,
    ),
  );
  const requireDot = (id: string) => {
    if (!workspace.dot(id)) throw new Error('Dot not found.');
    return id;
  };
  const owned = (id: string) => {
    const connection = connections.store.get(id);
    if (!connection) throw new Error('Connection not found.');
    return connection;
  };
  app.get('/dots/:id/connections', (c) =>
    c.json(connections.store.list(requireDot(c.req.param('id')))),
  );
  app.post('/dots/:id/connections', async (c) =>
    c.json(
      await connections.add(
        requireDot(c.req.param('id')),
        connectionInput.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post('/connections/:id/refresh', async (c) =>
    c.json(await connections.refresh(owned(c.req.param('id')).id)),
  );
  app.patch('/connections/:id/tools/:name', async (c) => {
    const patch = z
      .object({
        enabled: z.boolean().optional(),
        requiresApproval: z.boolean().optional(),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      connections.setTool(
        owned(c.req.param('id')).id,
        c.req.param('name'),
        patch,
      ),
    );
  });
  app.delete('/connections/:id', (c) => {
    connections.store.remove(owned(c.req.param('id')).id);
    return c.json({ ok: true });
  });
  return app;
}
