import type { AccountSourceConfig } from '../shared/inbox-types.js';
import type { Dot } from '../shared/types.js';
import type { Store } from './store.js';
import type { WorkspaceStore } from './workspace.js';

/**
 * The one Dot the owner talks to. Discovery, the home screen and calls use
 * it. When the setting is unset, or names a Dot that no longer exists, it is
 * chosen once: the Dot discovery already uses, else the oldest Dot.
 */
export async function ensureAssistant(
  store: Store,
  workspace: WorkspaceStore,
): Promise<Dot> {
  const dots = await workspace.dots();
  const saved = (await store.settings()).assistantDotId;
  let dot = dots.find((item) => item.id === saved);
  if (!dot) {
    const sources = await workspace.inbox.accountSources();
    const discoveryDotIds = [
      ...sources.filter((source) => source.enabled),
      ...sources,
    ].map((source) => (source.config as AccountSourceConfig).dotId);
    dot =
      discoveryDotIds
        .map((id) => dots.find((item) => item.id === id))
        .find(Boolean) ?? dots[0];
    if (!dot) throw new Error('The workspace has no Dot to be the assistant.');
    await store.updateSettings({ assistantDotId: dot.id });
  }
  await followAssistant(workspace, dot.id);
  return dot;
}

/** Points every discovery account source at the assistant. */
export async function followAssistant(
  workspace: WorkspaceStore,
  dotId: string,
) {
  for (const source of await workspace.inbox.accountSources()) {
    const config = source.config as AccountSourceConfig;
    if (config.dotId !== dotId)
      await workspace.inbox.update(source.id, {
        config: { ...config, dotId },
      });
  }
}
