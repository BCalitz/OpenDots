import type { ConnectorService } from '../connectors/service.js';
import type {
  ComposioSourceConfig,
  InboxEventView,
  McpSourceConfig,
} from '../../shared/inbox-types.js';
import { ComposioListSource, type ComposioExecute } from './composio-source.js';
import { McpListSource } from './mcp-source.js';
import type { Source } from './source.js';
import type { InboxStore, SourceRecord } from './store.js';
import { WebhookSource } from './webhook-source.js';

export interface NewEvents {
  source: SourceRecord;
  events: InboxEventView[];
  /** The first poll of a source backfills what already exists. */
  initial: boolean;
}
type Listener = (batch: NewEvents) => void | Promise<void>;
const safeError = (error: unknown) =>
  (error instanceof Error && error.message
    ? error.message
    : 'The source could not be read.'
  ).slice(0, 300);

/**
 * The event engine. Polls due sources under a lease, accepts webhook
 * deliveries, writes everything to the event log first and then tells
 * listeners (push today, triage in phase 5) about events it has not seen.
 */
export class InboxEngine {
  private timer?: ReturnType<typeof setInterval>;
  private polling?: AbortController;
  private listeners: Listener[] = [];
  constructor(
    readonly store: InboxStore,
    private connectors: ConnectorService,
    private options: {
      paused: () => Promise<boolean>;
      /** Runs Composio tools for discovery sources; unset without a key. */
      composio?: () => ComposioExecute | undefined;
      tickMs?: number;
      pollTimeoutMs?: number;
    },
  ) {}
  /** Builds the adapter for a stored source. New source types are added here. */
  sourceFor(record: SourceRecord): Source {
    if (record.type === 'webhook')
      return new WebhookSource(record.id, record.kind);
    if (record.type === 'composio') {
      const execute = this.options.composio?.();
      if (!execute)
        throw new Error(
          'Connected apps are not set up. Add COMPOSIO_API_KEY to .env and restart OpenDots.',
        );
      return new ComposioListSource(
        record.id,
        record.config as ComposioSourceConfig,
        execute,
      );
    }
    if (!('accountId' in record.config))
      throw new Error('This source is missing its account settings.');
    return new McpListSource(
      record.id,
      record.kind,
      record.config as McpSourceConfig,
      this.connectors,
    );
  }
  onEvents(listener: Listener) {
    this.listeners.push(listener);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.options.tickMs ?? 5000,
    );
    void this.tick();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.polling?.abort(new Error('Server stopped.'));
  }
  /** Polls at most one due source. Safe to call repeatedly. */
  async tick() {
    if (this.polling) return;
    const controller = new AbortController();
    this.polling = controller;
    try {
      if (await this.options.paused()) return;
      const claim = await this.store.claimDue(
        Date.now(),
        (this.options.pollTimeoutMs ?? 60_000) * 2,
      );
      if (!claim) return;
      const startedAt = new Date();
      const timeout = setTimeout(
        () =>
          controller.abort(new Error('The source did not respond in time.')),
        this.options.pollTimeoutMs ?? 60_000,
      );
      try {
        const source = this.sourceFor(claim.source);
        if (!source.poll) throw new Error('This source does not poll.');
        const since = claim.source.cursor
          ? new Date(claim.source.cursor)
          : null;
        const events = await source.poll(since, controller.signal);
        controller.signal.throwIfAborted();
        if (!(await this.store.owns(claim))) return;
        const fresh = await this.store.ingest(events);
        await this.store.finishPoll(claim, {
          cursor: startedAt.toISOString(),
        });
        await this.emit({
          source: claim.source,
          events: fresh,
          initial: !claim.source.cursor,
        });
      } catch (error) {
        await this.store.finishPoll(claim, { error: safeError(error) });
      } finally {
        clearTimeout(timeout);
      }
    } catch {
      // Store errors must not become unhandled interval rejections, and
      // source content stays out of the logs.
      console.error('Inbox poll failed; will retry on the next tick.');
    } finally {
      this.polling = undefined;
    }
  }
  /** Handles a webhook delivery whose secret was already verified. */
  async receive(sourceId: string, body: unknown) {
    const record = await this.store.source(sourceId);
    if (!record || record.type !== 'webhook' || !record.enabled)
      throw new Error('Source not found.');
    const source = this.sourceFor(record);
    const events = source.webhook!(body);
    const fresh = await this.store.ingest(events);
    await this.emit({ source: record, events: fresh, initial: false });
    return { received: events.length, new: fresh.length };
  }
  private async emit(batch: NewEvents) {
    if (!batch.events.length) return;
    for (const listener of this.listeners) {
      try {
        await listener(batch);
      } catch {
        console.error('An inbox listener failed.');
      }
    }
  }
}
