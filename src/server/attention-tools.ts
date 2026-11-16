import { z } from 'zod';
import { defineTool } from './engine/tools.js';
import type { WorkspaceStore } from './workspace.js';
import { DEFAULT_FOCUS_MS } from './discovery/attention.js';
import { MEMORY_KINDS, type Memory } from '../shared/types.js';

const view = (entry: Memory) => ({
  id: entry.id,
  kind: entry.kind,
  text: entry.text,
  ...(entry.subject ? { subject: entry.subject } : {}),
  until: entry.until ? new Date(entry.until).toISOString() : 'until lifted',
});

/**
 * What the owner says matters to them, and how to act on it: focus on
 * something, mute something, be away, a note about them, and telling the Dot
 * two inbox items are the same thing. For chat turns only: a read-only
 * investigation or an outside message can never change these.
 */
export function attentionTools(
  workspace: WorkspaceStore,
  check: () => Promise<void>,
) {
  const inbox = workspace.inbox;
  return [
    defineTool({
      name: 'save_attention',
      description:
        'Remember what the owner said about their attention. Ask first: say what you would save and what it changes, and call this only after they say yes. Kinds: "focus" (what they are concentrating on, such as a client or project: its items become more urgent and are pushed now), "mute" (something they do not care about, such as payment notices: not flagged or pushed, still in the Inbox; fraud-like and urgent items still reach them), "away" (they are away until a date: nothing is pushed, and a summary follows when they return; focus and urgent items still reach them), "note" (a fact about them for you to know; discovery never reads it). Saving the same kind and subject again renews it.',
      parameters: z.object({
        kind: z.enum(MEMORY_KINDS),
        text: z
          .string()
          .min(1)
          .max(300)
          .describe(
            'The entry in one plain line, such as "Focusing on GreenBasket this week".',
          ),
        subject: z
          .string()
          .max(100)
          .optional()
          .describe(
            'For focus and mute: what it is about, such as "GreenBasket" or "payment notifications". Name it so a person or a model can tell whether an item is about it. Leave out for away and note.',
          ),
        days: z
          .number()
          .min(0.04)
          .max(365)
          .optional()
          .describe(
            'How long it lasts, in days; for away, how long until they are back. A focus lasts 7 days when not said; mute and note last until lifted.',
          ),
      }),
      execute: async ({ kind, text, subject, days }) => {
        await check();
        if ((kind === 'focus' || kind === 'mute') && !subject?.trim())
          return {
            error: `A ${kind} needs a subject: what is it about?`,
          };
        if (kind === 'away' && days === undefined)
          return { error: 'Ask how long they are away, then save it.' };
        const duration =
          days !== undefined
            ? days * 86_400_000
            : kind === 'focus'
              ? DEFAULT_FOCUS_MS
              : null;
        const saved = await inbox.attention.save({
          kind,
          text,
          subject,
          until: duration === null ? null : Date.now() + duration,
        });
        return { saved: view(saved) };
      },
    }),
    defineTool({
      name: 'list_attention',
      description:
        'List what the owner asked you to focus on, mute or note, and whether they are away, with when each ends. Use it before saving, or when they ask what you are tracking.',
      parameters: z.object({}),
      execute: async () => {
        await check();
        return { entries: (await inbox.attention.list()).map(view) };
      },
    }),
    defineTool({
      name: 'lift_attention',
      description:
        'Remove a focus, mute, away or note when the owner says to stop ("stop focusing on GreenBasket", "I am back"). Use the id from list_attention.',
      parameters: z.object({ id: z.string().min(1).max(100) }),
      execute: async ({ id }) => {
        await check();
        return (await inbox.attention.lift(id))
          ? { lifted: true }
          : { error: 'No entry with that id.' };
      },
    }),
    defineTool({
      name: 'link_inbox_items',
      description:
        'Record that two inbox items are the same thing, such as the same invoice, order or request, when the owner says so ("these two emails are the same"). Find the ids with search_inbox. Later items about it are then treated as one matter.',
      parameters: z.object({
        itemId: z.string().min(1).max(100),
        otherItemId: z.string().min(1).max(100),
      }),
      execute: async ({ itemId, otherItemId }) => {
        await check();
        if (itemId === otherItemId)
          return { error: 'Those are the same item; give two different ones.' };
        const [first, second] = await Promise.all([
          inbox.event(itemId),
          inbox.event(otherItemId),
        ]);
        if (!first || !second)
          return { error: 'One of those ids is not an inbox item.' };
        await inbox.discovery.link(itemId, otherItemId, 1, 'linked');
        await inbox.discovery.decideLink(itemId, otherItemId, 'confirmed');
        return { linked: [first.title, second.title] };
      },
    }),
  ];
}
