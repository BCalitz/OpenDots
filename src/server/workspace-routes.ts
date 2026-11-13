import { setupInputSchema } from './setup-telemetry.js';
import { pageRoutes } from './page-routes.js';
import { insightRoutes } from './insight-routes.js';
import { inboxRoutes } from './inbox/routes.js';
import { discoveryRoutes } from './discovery/routes.js';
import { memoryRoutes } from './memory/routes.js';
import { chatRoutes } from './chat-routes.js';
import { Hono } from 'hono';
import { z } from 'zod';
import { Platform } from './platform.js';
import { VoiceService } from './voice.js';
const dotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    instructions: z.string().trim().min(3).max(2000),
    researchAllowed: z.boolean(),
    memoryAllowed: z.boolean(),
    spaceIds: z.array(z.string().min(1)).min(1).max(100).optional(),
    spaceId: z.string().min(1).optional(),
    delegateDotIds: z.array(z.string().min(1).max(200)).max(50).optional(),
    monthlyTokenCap: z
      .number()
      .int()
      .min(1000)
      .max(1_000_000_000_000)
      .nullable()
      .optional(),
  })
  .strict();
export function workspaceRoutes(platform: Platform, voice: VoiceService) {
  const app = new Hono();
  app.route('/', chatRoutes(platform));
  app.route('/', pageRoutes(platform));
  app.route('/', insightRoutes(platform));
  app.route('/', inboxRoutes(platform));
  app.route('/', discoveryRoutes(platform));
  app.route('/', memoryRoutes(platform));
  app.post('/setup-telemetry', async (c) => {
    const parsed = setupInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: 'Invalid setup event.' }, 400);
    const event = parsed.data;
    if (
      event.kind === 'step_viewed' &&
      event.step !== 'settings' &&
      event.step !==
        (platform.setup().missing.length ? 'setup_required' : 'ready')
    )
      return c.json({ error: 'Setup step does not match server state.' }, 400);
    platform.setupTelemetry.capture(event);
    return c.json({ ok: true });
  });
  app.get('/workspace', async (c) =>
    c.json({
      spaces: await platform.workspace.spaces(),
      dots: await platform.workspace.dots(),
      conversations: await platform.workspace.conversations(),
      mainConversations: await platform.workspace.mainConversations(),
      setup: platform.setup(),
      calls: await platform.workspace.calls(),
    }),
  );
  app.post('/spaces', async (c) => {
    const data = z
      .object({
        name: z.string().trim().min(1).max(60),
        description: z.string().max(500).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Enter a Space name (up to 60 characters).' },
        400,
      );
    return c.json(
      await platform.workspace.createSpace(
        data.data.name,
        data.data.description,
      ),
      201,
    );
  });
  // Settings stored outside updateDot: the token cap and which Dots it directs.
  const applyLimits = async (
    id: string,
    data: { monthlyTokenCap?: number | null; delegateDotIds?: string[] },
  ) => {
    if (data.monthlyTokenCap !== undefined)
      await platform.workspace.setMonthlyTokenCap(id, data.monthlyTokenCap);
    if (data.delegateDotIds !== undefined)
      await platform.workspace.setDelegates(id, data.delegateDotIds);
    return (await platform.workspace.dot(id))!;
  };
  const badDelegates = async (id: string | undefined, ids?: string[]) => {
    if (ids === undefined) return false;
    const dots = await platform.workspace.dots();
    return ids.some(
      (other) => other === id || !dots.some((dot) => dot.id === other),
    );
  };
  app.post('/dots', async (c) => {
    const data = dotSchema
      .extend({ spaceId: z.string() })
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        {
          error:
            'Provide a name, role instructions, and explicit tool permissions.',
        },
        400,
      );
    if (await badDelegates(undefined, data.data.delegateDotIds))
      return c.json({ error: 'Choose existing Dots for it to direct.' }, 400);
    const dot = await platform.workspace.createDot(
      data.data.spaceId,
      data.data.name,
      data.data.instructions,
      data.data.researchAllowed,
      data.data.memoryAllowed,
      data.data.spaceIds,
    );
    return c.json(await applyLimits(dot.id, data.data), 201);
  });
  app.put('/dots/:id', async (c) => {
    const data = dotSchema.safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Invalid specialist settings.' }, 400);
    const current = await platform.workspace.dot(c.req.param('id'));
    if (!current) return c.json({ error: 'Dot not found.' }, 404);
    if (await badDelegates(current.id, data.data.delegateDotIds))
      return c.json(
        { error: 'A Dot can direct other existing Dots, not itself.' },
        400,
      );
    const dot = await platform.workspace.updateDot(
      c.req.param('id'),
      data.data,
    );
    return c.json(await applyLimits(dot.id, data.data));
  });
  app.post('/conversations', async (c) => {
    const data = z
      .object({
        dotId: z.string(),
        title: z.string().trim().min(1).max(120).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Select a Dot and a conversation title.' }, 400);
    if (platform.setup().missing.length)
      return c.json(
        { error: `Setup required: ${platform.setup().missing.join(', ')}.` },
        503,
      );
    // Each Dot has one continuing chat: reuse it when it already exists.
    const { conversation, created } = await platform.dotConversation(
      data.data.dotId,
      data.data.title,
    );
    return c.json(conversation, created ? 201 : 200);
  });
  // Splits a conversation into a topic thread in the same Dot's chat.
  app.post('/conversations/:id/split', async (c) => {
    const data = z
      .object({
        messageId: z.string().min(1).max(200),
        mode: z.enum(['move', 'copy']),
        title: z.string().trim().max(120).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json({ error: 'Choose a message to split from.' }, 400);
    try {
      const thread = await platform.splitConversation(
        c.req.param('id'),
        data.data.messageId,
        data.data.mode,
        data.data.title,
      );
      return c.json(thread, 201);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Could not split.';
      if (/^(Wait for|Choose a message|This part)/.test(message))
        return c.json({ error: message }, 409);
      if (
        /^(Conversation does not belong|Conversation not found)/.test(message)
      )
        return c.json({ error: message }, 404);
      throw error;
    }
  });
  app.get('/conversations/:id/capture', async (c) =>
    c.json(await platform.workspace.capture(c.req.param('id'))),
  );
  app.post('/voice/calls', async (c) => {
    const data = z
      .object({ threadId: z.string(), sdp: z.string().max(100000) })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A conversation and audio SDP offer are required.' },
        400,
      );
    return c.json(
      await voice.begin(data.data.threadId, data.data.sdp, c.req.raw.signal),
      201,
    );
  });
  app.get('/voice/calls/:id', async (c) =>
    c.json(await platform.workspace.call(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/active', async (c) =>
    c.json(await voice.activate(c.req.param('id'))),
  );
  app.post('/voice/calls/:id/compute', async (c) => {
    const data = z
      .object({
        toolCallId: z.string().min(1).max(200),
        request: z.string().trim().min(1).max(4000),
        transcript: z.string().max(12000).default(''),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'A bounded compute request and tool call ID are required.' },
        400,
      );
    return c.json({
      text: await voice.compute(
        c.req.param('id'),
        data.data.toolCallId,
        `${data.data.request}\n\nUntrusted current-call transcript for context:\n${data.data.transcript}`,
      ),
    });
  });
  app.post('/voice/calls/:id/end', async (c) => {
    const data = z
      .object({
        transcript: z.string().max(20000),
        anchorMessageId: z.string().max(200).optional(),
      })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!data.success)
      return c.json(
        { error: 'Transcript exceeds the 20,000 character limit.' },
        400,
      );
    await platform.workspace.anchorCall(
      c.req.param('id'),
      data.data.anchorMessageId,
    );
    return c.json(await voice.end(c.req.param('id'), data.data.transcript));
  });
  app.onError((error, c) => {
    const text = error.message;
    if (text.startsWith('Space access must include'))
      return c.json({ error: text }, 400);
    const known =
      /^(Setup|Voice setup|Dot |Space |Specialist |Conversation |Call |This call|End the current|Voice provider|An audio)/.test(
        text,
      );
    // A conversation, call or Dot the caller named that does not exist is a missing resource, not a
    // server fault.
    if (
      /^(Dot not found|Call not found|Conversation does not belong)/.test(text)
    )
      return c.json({ error: text }, 404);
    return c.json(
      {
        error: known
          ? text
          : 'The service request failed. Check the server configuration and try again.',
      },
      503,
    );
  });
  return app;
}
