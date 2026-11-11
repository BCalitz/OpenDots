import type { JSONSchema } from '@tanstack/ai';
import type { Tool } from './engine/tools.js';
import type { composioSession } from './composio.js';
import { safeFailure } from './slack-channel.js';
import type { UsageStore } from './usage-store.js';

type Session = Awaited<ReturnType<typeof composioSession>>;
type CancellableSession = Session & {
  tools(
    modifiers: Parameters<Session['tools']>[0],
    requestOptions: { signal?: AbortSignal },
  ): ReturnType<Session['tools']>;
  execute(
    toolSlug: string,
    input: Record<string, unknown>,
    options: Parameters<Session['execute']>[2],
    requestOptions: { signal?: AbortSignal },
  ): ReturnType<Session['execute']>;
};

export async function composioTools(
  session: Session,
  check: () => void,
  signal?: AbortSignal,
  log?: { store: UsageStore; dotId: string; threadId: string },
) {
  check();
  // @composio/core 0.22 supports request options at runtime but omits them
  // from the public Session function aliases.
  const cancellable = session as CancellableSession;
  const tools = await cancellable.tools(undefined, { signal });
  return tools
    .filter((tool) => tool.type === 'function')
    .map(({ function: fn }): Tool => ({
      name: fn.name,
      description: fn.description ?? `Use the Composio ${fn.name} tool.`,
      parameters: (fn.parameters ?? { type: 'object' }) as JSONSchema,
      execute: async (input: unknown) => {
        check();
        // Composio slugs start with the toolkit, e.g. GMAIL_SEND_EMAIL.
        const entry = log?.store.beginAction({
          dotId: log.dotId,
          threadId: log.threadId,
          kind: 'app',
          target: fn.name.split('_')[0]?.toLowerCase() || 'composio',
          action: fn.name,
        });
        try {
          const { data, error } = await cancellable.execute(
            fn.name,
            input as Record<string, unknown>,
            undefined,
            { signal },
          );
          if (entry)
            log!.store.finishAction(entry, error ? 'failed' : 'succeeded');
          return { data, error };
        } catch (error) {
          if (entry) log!.store.finishAction(entry, 'failed');
          return {
            data: {},
            error: `Composio tool failed: ${safeFailure(error)}.`,
          };
        }
      },
    }));
}
