import { randomUUID } from 'node:crypto';
import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import {
  setupStatus,
  slackSetup,
  type PlatformConfig,
} from './platform-config.js';
import { LocalConversationBackend } from './conversations/backend.js';
import {
  generateThreadName,
  namingExcerpt,
} from './conversations/thread-names.js';
import { ThreadRunner, type FinishedRun } from './engine/thread-runner.js';
import { DotEngine, type Delegate } from './engine/index.js';
import { Approvals } from './engine/approvals.js';
import { ChannelService } from './channels/service.js';
import { SlackAdapter } from './channels/slack.js';
import { SetupTelemetry } from './setup-telemetry.js';
import { InboxEngine } from './inbox/engine.js';
import { composioReader } from './composio.js';
import { DiscoveryService, type Investigate } from './discovery/service.js';
import { jevJudge, type Judge } from './discovery/classifier.js';
import { investigationMessage } from './discovery/investigation.js';

export class Platform {
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  /** Event engine: sources, the event log and the poller. */
  readonly inbox: InboxEngine;
  /** Flags inbox items that need the owner and investigates them read-only. */
  readonly discovery: DiscoveryService;
  /** Threads, runs and their events, in this server's database. */
  readonly runner: ThreadRunner;
  /** Runs every turn: chat, mobile, voice, schedules, delegation, Slack. */
  readonly engine: DotEngine;
  /** Owner approvals for tools that change things. */
  readonly approvals: Approvals;
  readonly conversations: LocalConversationBackend;
  /** Slack, when it is configured. */
  readonly channel?: ChannelService;
  private naming = new Set<string>();
  /** One request at a time per specialist thread. */
  private delegations = new Map<string, Promise<unknown>>();
  readonly delegate: Delegate = (input) => this.runDelegation(input);
  /**
   * Builds the platform and finishes what a restart left open: runs and
   * approvals that were in flight.
   */
  static async create(
    store: Store,
    workspace: WorkspaceStore,
    config: PlatformConfig,
    options: { fetch?: typeof fetch } = {},
  ) {
    let slackDotId: string | undefined;
    if (slackSetup(config) === 'configured') {
      slackDotId = config.slackDotId ?? (await workspace.dots())[0].id;
      if (!(await workspace.dot(slackDotId)))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
    }
    const platform = new Platform(
      store,
      workspace,
      config,
      await SetupTelemetry.create(store),
      slackDotId,
      options,
    );
    await platform.runner.recoverInterruptedRuns();
    await platform.approvals.expireStale();
    return platform;
  }
  private constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    setupTelemetry: SetupTelemetry,
    slackDotId: string | undefined,
    private options: { fetch?: typeof fetch } = {},
  ) {
    const paused = async () => (await store.settings()).paused;
    this.setupTelemetry = setupTelemetry;
    this.computers = new ComputerService(workspace, config, paused);
    this.connections = new ConnectionService(workspace.connections);
    let reader: ReturnType<typeof composioReader> | undefined;
    let readerKey: string | undefined;
    this.inbox = new InboxEngine(workspace.inbox, this.connections, {
      paused,
      composio: () => {
        const key = config.composioApiKey;
        if (!key) return undefined;
        if (!reader || readerKey !== key) {
          reader = composioReader(key, workspace.ownerId);
          readerKey = key;
        }
        return reader;
      },
    });
    this.discovery = new DiscoveryService(workspace.inbox, {
      judge: () => this.jev(),
      investigate: (input, signal) => this.investigate(input, signal),
      threshold: config.discoveryThreshold,
    });
    this.inbox.onEvents(this.discovery.listener);
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return this.conversations;
    });
    this.runner = new ThreadRunner(workspace.db, workspace.ownerId, {
      onRunFinished: (run) => void this.nameThread(run),
    });
    this.approvals = new Approvals(workspace.db);
    this.engine = new DotEngine({
      store,
      workspace,
      config,
      runner: this.runner,
      setupTelemetry: this.setupTelemetry,
      delegate: this.delegate,
      approvals: this.approvals,
    });
    this.conversations = new LocalConversationBackend(this.runner, this.engine);
    if (slackDotId) {
      const dotId = slackDotId;
      this.channel = new ChannelService(
        new SlackAdapter({
          botToken: config.slackBotToken!,
          appToken: config.slackAppToken!,
        }),
        {
          db: workspace.db,
          tenantId: config.slackTeam!,
          userIds: config.slackUsers,
          dotId,
          paused,
          createThread: async (id, title) =>
            (await this.createConversation(id, title, 'slack')).id,
          turn: (threadId, prompt, signal) =>
            this.turn(threadId, prompt, signal, { opendotsSource: 'slack' }),
        },
      );
    }
  }
  setup() {
    return setupStatus(this.config, this.channel?.status());
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(`Setup required: ${missing.join(', ')}.`);
  }
  async start() {
    this.setupTelemetry.start();
    await this.discovery.start();
    if (!this.channel) return;
    try {
      await this.channel.start();
    } catch (error) {
      this.setupTelemetry.capture({
        kind: 'setup_failed',
        step: 'settings',
        error_class: 'channel_start_failed',
      });
      throw error;
    }
  }
  async stop() {
    this.inbox.stop();
    this.discovery.stop();
    await this.setupTelemetry.stop();
    await this.channel?.stop();
    this.approvals.close();
    this.runner.close();
  }
  /** The discovery judge: Jev, when TYPESAFE_API_KEY is set. */
  jev(): Judge | undefined {
    return this.config.typesafeApiKey
      ? jevJudge({
          apiKey: this.config.typesafeApiKey,
          fetch: this.options.fetch,
        })
      : undefined;
  }
  /**
   * Opens a discovery conversation and runs the read-only investigation, or,
   * when the item follows up on one already discussed, continues that
   * conversation instead.
   */
  private investigate: Investigate = async (input, signal) => {
    const threadId =
      input.existingThreadId ??
      (
        await this.createConversation(
          input.dotId,
          `${input.app}: ${input.event.title}`.slice(0, 80),
          'discovery',
        )
      ).id;
    try {
      await this.turn(
        threadId,
        investigationMessage({
          ...input,
          continuing: !!input.existingThreadId,
        }),
        signal,
        { opendotsSource: 'discovery', findingId: input.finding.id },
      );
    } catch (error) {
      throw Object.assign(
        error instanceof Error ? error : new Error('The investigation failed.'),
        { threadId },
      );
    }
    return { threadId };
  };
  /** A new thread; `source` marks background threads such as Slack's. */
  async createConversation(dotId: string, title: string, source?: string) {
    this.requireReady();
    if (!(await this.workspace.dot(dotId))) throw new Error('Dot not found.');
    const id = randomUUID();
    await this.conversations.createThread({ threadId: id, dotId });
    return this.workspace.bindThread(id, dotId, title, source);
  }
  /** The Dot's one continuing chat, created on first use. */
  async dotConversation(dotId: string, title?: string) {
    const existing = await this.workspace.mainConversation(dotId);
    if (existing) return { conversation: existing, created: false };
    const dot = await this.workspace.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    return {
      conversation: await this.createConversation(dotId, title || dot.name),
      created: true,
    };
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    await this.workspace.requireThread(threadId);
    const history = await this.conversations.getThreadMessages({ threadId });
    return history.messages
      .filter((message) => ['user', 'assistant'].includes(message.role))
      .slice(-12)
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : ''}`,
      )
      .join('\n')
      .slice(-12000);
  }
  /** Names a thread after its first answer with one small model call. */
  private async nameThread(run: FinishedRun) {
    const runner = this.runner;
    if (run.status !== 'finished' || this.naming.has(run.threadId)) return;
    if ((await runner.thread(run.threadId))?.name) return;
    const excerpt = namingExcerpt(run.messages);
    if (!excerpt) return;
    this.naming.add(run.threadId);
    try {
      const name = await generateThreadName(
        this.config,
        excerpt,
        this.options.fetch,
      );
      // The owner may have renamed it while the model was answering.
      if (!name || (await runner.thread(run.threadId))?.name) return;
      await runner.renameThread(run.threadId, name);
      await this.workspace.retitleThread(run.threadId, name);
    } catch {
      // Naming is cosmetic; the database may already be closed on shutdown.
    } finally {
      this.naming.delete(run.threadId);
    }
  }
  /**
   * Hands a request from one Dot to another it is allowed to direct, in a
   * thread kept per coordinator conversation so the owner can open it. The
   * specialist answers with its own permissions and limits, and cannot pass
   * the work on again.
   */
  private async runDelegation({
    fromDotId,
    parentThreadId,
    toDotId,
    request,
    signal,
  }: Parameters<Delegate>[0]) {
    const from = await this.workspace.dot(fromDotId);
    const to = await this.workspace.dot(toDotId);
    if (!from || !to || !(from.delegateDotIds ?? []).includes(to.id))
      throw new Error('This Dot is not allowed to direct that Dot.');
    if (await this.workspace.isDelegateThread(parentThreadId))
      throw new Error(
        'A Dot answering another Dot cannot pass the work on again.',
      );
    let threadId = await this.workspace.delegateThread(parentThreadId, to.id);
    if (!threadId) {
      const conversation = await this.createConversation(
        to.id,
        `From ${from.name}: ${request.replace(/\s+/g, ' ').slice(0, 60)}`,
      );
      await this.workspace.bindDelegate(parentThreadId, to.id, conversation.id);
      threadId = conversation.id;
    }
    const target = threadId;
    const previous = this.delegations.get(target) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() =>
        this.turn(
          target,
          `${from.name}, another of the owner's Dots, asks you:\n\n${request}`,
          signal,
          { opendotsSource: 'delegation', fromDotId: from.id, parentThreadId },
        ),
      );
    this.delegations.set(target, run);
    try {
      return { threadId: target, reply: await run };
    } finally {
      if (this.delegations.get(target) === run) this.delegations.delete(target);
    }
  }
  async turn(
    threadId: string,
    prompt: string,
    signal: AbortSignal,
    metadata?: Record<string, unknown>,
  ): Promise<string> {
    this.requireReady();
    await this.workspace.requireThread(threadId);
    return this.conversations.turn({
      threadId,
      prompt,
      signal,
      metadata,
    });
  }
}
