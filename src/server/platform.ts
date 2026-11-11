import { ComputerService } from './computer-service.js';
import { ConnectionService } from './connections.js';
import { PageService } from './page-service.js';
import { randomUUID } from 'node:crypto';
import {
  CopilotKitIntelligence,
  CopilotRuntime,
  createCopilotHonoHandler,
  type CopilotHonoApp,
} from '@copilotkit/runtime/v2';
import { createSlackChannel } from './slack-channel.js';
export { slackIdentity } from './slack-channel.js';
import { Store } from './store.js';
import { WorkspaceStore } from './workspace.js';
import { DotAgent } from './dot-agent.js';
import type { Delegate } from './engine/index.js';
import {
  conversationBackend,
  INTELLIGENCE_KEY_MISSING_LABEL,
  setupStatus,
  type PlatformConfig,
} from './platform-config.js';
import {
  IntelligenceConversationBackend,
  LocalConversationBackend,
  type ConversationBackend,
} from './conversations/backend.js';
import { ThreadRunner, type FinishedRun } from './engine/thread-runner.js';
import { DotEngine } from './engine/index.js';
import { Approvals } from './engine/approvals.js';
import {
  generateThreadName,
  namingExcerpt,
} from './conversations/thread-names.js';
import { validateRuntimeScope } from './runtime-scope.js';
import { learningSelector } from './learning.js';
import { SetupTelemetry } from './setup-telemetry.js';
import { InboxEngine } from './inbox/engine.js';
export class Platform {
  private channelStartupFailed = false;
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connections: ConnectionService;
  /** Event engine: sources, the event log and the poller. */
  readonly inbox: InboxEngine;
  readonly intelligence?: CopilotKitIntelligence;
  readonly handler?: CopilotHonoApp;
  readonly backend: 'local' | 'intelligence';
  readonly conversations?: ConversationBackend;
  /** Set when conversations are stored locally. */
  readonly runner?: ThreadRunner;
  /** Runs every turn when conversations are stored locally. */
  readonly engine?: DotEngine;
  /** Owner approvals for tools that change things. */
  readonly approvals?: Approvals;
  private naming = new Set<string>();
  /** One request at a time per specialist thread. */
  private delegations = new Map<string, Promise<unknown>>();
  readonly delegate: Delegate = (input) => this.runDelegation(input);
  constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    private options: {
      /** SQLite file for local conversations; in-memory when omitted. */
      databasePath?: string;
      fetch?: typeof fetch;
    } = {},
  ) {
    this.setupTelemetry = new SetupTelemetry(store);
    this.computers = new ComputerService(
      workspace,
      config,
      () => store.settings().paused,
    );
    this.connections = new ConnectionService(workspace.connections);
    this.inbox = new InboxEngine(workspace.inbox, this.connections, {
      paused: () => store.settings().paused,
    });
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return this.conversations!;
    });
    this.backend = conversationBackend(config);
    const agent = (dotId: string) =>
      new DotAgent(
        store,
        workspace,
        config,
        dotId,
        false,
        this.setupTelemetry,
        this.delegate,
      );
    const agents = async () =>
      Object.fromEntries(
        workspace.dots().map((dot) => [dot.id, agent(dot.id)]),
      );
    if (this.backend === 'local') {
      if (config.slackChannel)
        console.warn(
          'Slack Channels need CONVERSATION_BACKEND=intelligence; Slack stays offline with local conversations.',
        );
      const database = options.databasePath ?? ':memory:';
      this.runner = new ThreadRunner(database, workspace.ownerId, {
        onRunFinished: (run) => void this.nameThread(run),
      });
      this.approvals = new Approvals(database);
      this.engine = new DotEngine({
        store,
        workspace,
        config,
        runner: this.runner,
        setupTelemetry: this.setupTelemetry,
        delegate: this.delegate,
        approvals: this.approvals,
      });
      this.conversations = new LocalConversationBackend(
        this.runner,
        this.engine,
      );
      return;
    }
    if (!config.intelligenceKey) return;
    this.intelligence = new CopilotKitIntelligence({
      apiKey: config.intelligenceKey,
      apiUrl: config.intelligenceApiUrl,
      wsUrl: config.intelligenceWsUrl,
      getLearningContainerId: learningSelector(
        workspace,
        config.slackDotId ?? workspace.dots()[0]?.id,
      ),
    });
    const channels = [];
    if (config.slackChannel && config.slackTeam && config.slackUsers.length) {
      const dotId = config.slackDotId ?? workspace.dots()[0].id;
      if (!workspace.dot(dotId))
        throw new Error('SLACK_DOT_ID does not identify an existing Dot.');
      const slack = createSlackChannel({
        name: config.slackChannel,
        config,
        ownerId: workspace.ownerId,
        paused: () => store.settings().paused,
        agent: () =>
          new DotAgent(
            store,
            workspace,
            config,
            dotId,
            true,
            this.setupTelemetry,
            this.delegate,
          ),
      });
      channels.push(slack);
    }
    const runtime = new CopilotRuntime({
      intelligence: this.intelligence,
      telemetryId: this.setupTelemetry.identity,
      telemetryProperties: this.setupTelemetry.metadata,
      identifyUser: async () => ({
        id: workspace.ownerId,
        name: 'OpenDots owner',
      }),
      agents,
      channels,
      generateThreadNames: true,
    });
    this.conversations = new IntelligenceConversationBackend(
      this.intelligence,
      workspace.ownerId,
      { url: config.runtimeUrl, ownerToken: config.ownerToken },
    );
    this.handler = createCopilotHonoHandler({
      runtime,
      basePath: '/api/copilotkit',
      cors: { origin: [] },
    });
  }
  setup() {
    return setupStatus(
      this.config,
      this.handler?.channels?.status().overall ??
        (this.config.slackChannel ? 'setup_required' : 'not_configured'),
      this.channelStartupFailed,
    );
  }
  requireReady() {
    const missing = this.setup().missing;
    if (missing.length)
      throw new Error(
        `Setup required: ${missing.join(', ')}.${this.backend === 'intelligence' ? ' Set CONVERSATION_BACKEND=local to keep conversations on this server instead.' : ''}`,
      );
  }
  async start() {
    this.setupTelemetry.start();
    if (this.handler?.channels) {
      try {
        await this.handler.channels.ready({ timeoutMs: 15000 });
        this.channelStartupFailed = false;
      } catch (error) {
        this.channelStartupFailed = true;
        this.setupTelemetry.capture({
          kind: 'setup_failed',
          step: 'settings',
          error_class: 'channel_start_failed',
        });
        throw error;
      }
    }
  }
  async stop() {
    this.inbox.stop();
    await this.setupTelemetry.stop();
    await this.handler?.channels?.stop();
    this.approvals?.close();
    this.runner?.close();
  }
  async createConversation(dotId: string, title: string) {
    this.requireReady();
    if (!this.workspace.dot(dotId)) throw new Error('Dot not found.');
    const id = randomUUID();
    await this.conversations!.createThread({
      threadId: id,
      dotId,
      name: title,
    });
    return this.workspace.bindThread(id, dotId, title);
  }
  /** The Dot's one continuing chat, created on first use. */
  async dotConversation(dotId: string, title?: string) {
    const existing = this.workspace.mainConversation(dotId);
    if (existing) return { conversation: existing, created: false };
    const dot = this.workspace.dot(dotId);
    if (!dot) throw new Error('Dot not found.');
    return {
      conversation: await this.createConversation(dotId, title || dot.name),
      created: true,
    };
  }
  async history(threadId: string): Promise<string> {
    this.requireReady();
    this.workspace.requireThread(threadId);
    const history = await this.conversations!.getThreadMessages({
      threadId,
      userId: this.workspace.ownerId,
    });
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
  async handle(request: Request): Promise<Response> {
    if (this.engine)
      return Response.json(
        { error: 'Local conversations use /api/chat.' },
        { status: 404 },
      );
    if (!this.handler)
      return Response.json(
        { error: `Setup required: ${INTELLIGENCE_KEY_MISSING_LABEL}.` },
        { status: 503 },
      );
    let body: unknown;
    if (request.method !== 'GET' && request.method !== 'HEAD')
      body = await request
        .clone()
        .json()
        .catch(() => null);
    try {
      validateRuntimeScope(request, this.workspace, body);
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof Error
              ? error.message
              : 'Conversation scope denied.',
        },
        { status: 403 },
      );
    }
    return this.handler.fetch(request);
  }
  /** Names a local thread after its first answer, like Intelligence does. */
  private async nameThread(run: FinishedRun) {
    const runner = this.runner;
    if (!runner || run.status !== 'finished' || this.naming.has(run.threadId))
      return;
    if (runner.thread(run.threadId)?.name) return;
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
      if (!name || runner.thread(run.threadId)?.name) return;
      runner.renameThread(run.threadId, name);
      this.workspace.retitleThread(run.threadId, name);
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
    const from = this.workspace.dot(fromDotId);
    const to = this.workspace.dot(toDotId);
    if (!from || !to || !(from.delegateDotIds ?? []).includes(to.id))
      throw new Error('This Dot is not allowed to direct that Dot.');
    if (this.workspace.isDelegateThread(parentThreadId))
      throw new Error(
        'A Dot answering another Dot cannot pass the work on again.',
      );
    let threadId = this.workspace.delegateThread(parentThreadId, to.id);
    if (!threadId) {
      const conversation = await this.createConversation(
        to.id,
        `From ${from.name}: ${request.replace(/\s+/g, ' ').slice(0, 60)}`,
      );
      this.workspace.bindDelegate(parentThreadId, to.id, conversation.id);
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
    const thread = this.workspace.requireThread(threadId);
    return this.conversations!.turn({
      threadId,
      dotId: thread.dotId,
      prompt,
      signal,
      metadata,
    });
  }
}
