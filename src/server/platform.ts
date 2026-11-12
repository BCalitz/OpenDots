import { randomUUID } from 'node:crypto';
import { ComputerService } from './computer-service.js';
import { ConnectorService } from './connectors/service.js';
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
import {
  messageText,
  reduceEvents,
  type Message,
} from '../shared/thread-events.js';
import {
  decideRoute,
  jevTopicRouter,
  type TopicRoute,
  type TopicRouter,
} from './conversations/auto-thread.js';
import type { Conversation } from '../shared/types.js';
import type { FindingView, InboxEventView } from '../shared/inbox-types.js';
import { DotEngine, type Delegate } from './engine/index.js';
import { Approvals } from './engine/approvals.js';
import { ChannelService } from './channels/service.js';
import { SlackAdapter } from './channels/slack.js';
import { SetupTelemetry } from './setup-telemetry.js';
import { InboxEngine } from './inbox/engine.js';
import { composioReader } from './composio.js';
import { DiscoveryService, type Investigate } from './discovery/service.js';
import { jevJudge, type Judge } from './discovery/classifier.js';
import { DeliveryService } from './discovery/delivery.js';
import { ProposalService } from './discovery/proposals.js';
import { openAiEmbedder, type Embedder } from './discovery/embeddings.js';
import type { PushService } from './push.js';
import { investigationMessage } from './discovery/investigation.js';

export interface PlatformOptions {
  fetch?: typeof fetch;
  /** Mobile push; discovery delivery is off without it. */
  push?: PushService;
}
export class Platform {
  readonly setupTelemetry: SetupTelemetry;
  readonly pages: PageService;
  readonly computers: ComputerService;
  readonly connectors: ConnectorService;
  /** Event engine: sources, the event log and the poller. */
  readonly inbox: InboxEngine;
  /** Flags inbox items that need the owner and investigates them read-only. */
  readonly discovery: DiscoveryService;
  /** Discovery's pushes: now, after a hold, or in the morning brief. */
  readonly delivery?: DeliveryService;
  /** The owner's three choices on what a Dot looked into. */
  readonly proposals: ProposalService;
  /** Similar items by wording, when EMBEDDING_BASE_URL is set. */
  readonly embedder?: Embedder;
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
  /** Reply proposals in progress, by finding; stopped on shutdown. */
  private replies = new AbortController();
  private replying = new Set<string>();
  /** Replaces Jev as the topic router, for tests. */
  routeTopics?: TopicRouter;
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
    options: PlatformOptions = {},
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
    // Items stored before tags existed get theirs in the background.
    void workspace.inbox
      .backfillTags()
      .catch(() => console.error('Could not tag earlier inbox items.'));
    return platform;
  }
  private constructor(
    readonly store: Store,
    readonly workspace: WorkspaceStore,
    readonly config: PlatformConfig,
    setupTelemetry: SetupTelemetry,
    slackDotId: string | undefined,
    private options: PlatformOptions = {},
  ) {
    const paused = async () => (await store.settings()).paused;
    this.setupTelemetry = setupTelemetry;
    this.computers = new ComputerService(workspace, config, paused);
    this.connectors = new ConnectorService(
      workspace.accounts,
      workspace.actions,
    );
    let reader: ReturnType<typeof composioReader> | undefined;
    let readerKey: string | undefined;
    this.inbox = new InboxEngine(workspace.inbox, this.connectors, {
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
    const push = options.push;
    this.delivery = push
      ? new DeliveryService(
          workspace.inbox.discovery,
          (message) => push.send(message),
          {
            previews: () => push.previews,
          },
        )
      : undefined;
    const embedder = config.embeddingBaseUrl
      ? openAiEmbedder({
          baseUrl: config.embeddingBaseUrl,
          model: config.embeddingModel ?? 'nomic-embed-text',
          apiKey: config.embeddingApiKey,
          fetch: options.fetch,
        })
      : undefined;
    this.embedder = embedder;
    this.proposals = new ProposalService(workspace.inbox.discovery.proposals, {
      run: (threadId, prompt, metadata, signal) =>
        this.turn(threadId, prompt, signal, metadata),
      notify: push ? (message) => push.send(message) : undefined,
      cancelPushes: (findingId) =>
        workspace.inbox.discovery.cancelPushes(findingId),
      settings: () => workspace.inbox.discovery.settings(),
      previews: () => push?.previews ?? false,
    });
    this.discovery = new DiscoveryService(workspace.inbox, {
      judge: () => this.jev(),
      investigate: (input, signal) => this.investigate(input, signal),
      threshold: config.discoveryThreshold,
      embedder: () => embedder,
      delivery: this.delivery,
      proposals: this.proposals,
      dotName: async (dotId) => (await workspace.dot(dotId))?.name,
      appsAllowed: async () => (await store.settings()).appsAllowed,
      previews: () => push?.previews ?? false,
    });
    this.inbox.onEvents(this.discovery.listener);
    // After an email is looked into, the Dot proposes the reply in the main
    // chat and sends it only once the owner approves the exact text.
    this.discovery.onReady((finding, event) => {
      void this.proposeReply(finding, event);
    });
    this.pages = new PageService(workspace, () => {
      this.requireReady();
      return this.conversations;
    });
    this.runner = new ThreadRunner(workspace.db, workspace.ownerId, {
      onRunFinished: (run) => void this.nameThread(run),
    });
    this.approvals = new Approvals(workspace.db, {
      onRequest: (view) => this.proposals.approvalRequested(view),
    });
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
    await this.proposals.start();
    this.delivery?.start();
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
    this.replies.abort();
    this.inbox.stop();
    this.discovery.stop();
    this.proposals.stop();
    this.delivery?.stop();
    await this.setupTelemetry.stop();
    await this.channel?.stop();
    this.approvals.close();
    this.runner.close();
  }
  /**
   * Starts the reply turn for an email discovery looked into: the Dot drafts
   * the reply and asks the owner to approve the exact text before sending.
   * Once per finding; never for items that try to instruct an AI.
   */
  private async proposeReply(finding: FindingView, event: InboxEventView) {
    const threadId = finding.threadId;
    if (!threadId || finding.injection || finding.asked === 'nothing') return;
    if (this.replying.has(finding.id)) return;
    if ((await this.inbox.store.source(event.sourceId))?.kind !== 'mail')
      return;
    const asked = (await this.runner.messages(threadId)).some(
      (message) =>
        (message.metadata as { opendotsSource?: string } | undefined)
          ?.opendotsSource === 'reply',
    );
    if (asked) return;
    this.replying.add(finding.id);
    try {
      await this.turn(
        threadId,
        `Draft my reply to "${event.title}"${event.from ? ` from ${event.from}` : ''} and ask me to approve it before sending.`,
        AbortSignal.any([
          this.replies.signal,
          // The approval waits up to 30 minutes.
          AbortSignal.timeout(45 * 60_000),
        ]),
        { opendotsSource: 'reply', findingId: finding.id },
      );
    } catch {
      console.error('The reply proposal did not finish.');
    } finally {
      this.replying.delete(finding.id);
    }
  }
  /** Sorts main-chat messages into topic threads: Jev, when configured. */
  topicRouter(): TopicRouter | undefined {
    return this.config.typesafeApiKey
      ? jevTopicRouter({
          apiKey: this.config.typesafeApiKey,
          fetch: this.options.fetch,
        })
      : undefined;
  }
  /**
   * Where a message the owner sends to a Dot's main chat belongs: the main
   * chat, an existing topic thread, or a new one. Only main-chat messages
   * are routed; anything uncertain, or any failure to decide, stays put.
   */
  async routeMessage(
    threadId: string,
    text: string,
  ): Promise<{
    threadId: string;
    moved?: { to: 'thread' | 'new'; title: string };
  }> {
    const stay = { threadId };
    const router = this.routeTopics ?? this.topicRouter();
    const thread = await this.workspace.conversation(threadId);
    if (!router || !thread || thread.parentId || thread.source) return stay;
    if ((await this.workspace.mainConversation(thread.dotId))?.id !== threadId)
      return stay;
    if (this.runner.isRunning(threadId)) return stay;
    const visible = (message: Message) =>
      (message.role === 'user' || message.role === 'assistant') &&
      !!messageText(message).trim();
    const clip = (value: string, max: number) =>
      value.replace(/\s+/g, ' ').trim().slice(0, max);
    // The main chat as the owner sees it, including exchanges answered in
    // its threads, so "what about the flour?" follows the cake it is about.
    const view = await this.runner.watch(threadId, () => undefined);
    view.unsubscribe();
    const main = reduceEvents(view.events, []).filter(visible);
    const lastAsked = main.findLast((message) => message.role === 'user') as
      (Message & { topicThreadId?: string }) | undefined;
    const topics = (await this.workspace.topicThreads(threadId)).slice(0, 12);
    if (!main.length && !topics.length) return stay;
    const brief = (message: Message, max: number) => ({
      role: message.role as 'user' | 'assistant',
      text: clip(messageText(message), max),
    });
    const threads = await Promise.all(
      topics.map(async (topic) => {
        const history = (await this.runner.messages(topic.id)).filter(visible);
        const opened = history.find((message) => message.role === 'user');
        return {
          id: topic.id,
          title: topic.title,
          opened: opened ? clip(messageText(opened), 300) : '',
          recent: history.slice(-4).map((message) => brief(message, 300)),
        };
      }),
    );
    const titleOf = new Map(topics.map((topic) => [topic.id, topic.title]));
    // An answer belongs to the thread of the question before it.
    let from: string | undefined;
    const recent = main
      .map((message) => {
        if (message.role === 'user')
          from = (message as { topicThreadId?: string }).topicThreadId;
        const thread = from && titleOf.get(from);
        return { ...brief(message, 600), ...(thread ? { thread } : {}) };
      })
      .slice(-6);
    let route: TopicRoute;
    try {
      route = decideRoute({
        ...(await router(
          {
            recent,
            threads,
            message: clip(text, 2000),
          },
          AbortSignal.timeout(8000),
        )),
        ...(lastAsked?.topicThreadId
          ? { latestThreadId: lastAsked.topicThreadId }
          : {}),
      });
    } catch {
      console.error(
        'Could not sort a message into a thread; it stays in the chat.',
      );
      return stay;
    }
    console.log(`Topic routing: ${route.kind}.`);
    if (route.kind === 'thread') {
      const topic =
        topics.find((item) => item.id === route.threadId) ??
        (await this.workspace.conversation(route.threadId));
      if (topic?.parentId !== threadId || this.runner.isRunning(topic.id))
        return stay;
      return {
        threadId: topic.id,
        moved: { to: 'thread', title: topic.title },
      };
    }
    if (route.kind === 'new') {
      const id = randomUUID();
      const title = clip(text, 60) || 'New thread';
      await this.conversations.createThread({
        threadId: id,
        dotId: thread.dotId,
      });
      // The chat shows the exchange itself, labelled with this thread, so
      // the thread needs no card of its own.
      await this.workspace.bindThread(id, thread.dotId, title, undefined, {
        parentId: threadId,
      });
      return {
        threadId: id,
        moved: { to: 'new', title },
      };
    }
    return stay;
  }
  /**
   * Undoes an automatic move: the exchange `messageId` started, and what
   * followed it in the thread, go back to the end of the main chat. A thread
   * left empty is removed.
   */
  async unthread(topicId: string, messageId: string) {
    this.requireReady();
    const topic = await this.workspace.requireThread(topicId);
    if (!topic.parentId)
      throw new Error('Only a message in a thread can go back to the chat.');
    const kept = await this.runner.moveTail({
      sourceId: topic.id,
      targetId: topic.parentId,
      messageId,
    });
    if (!kept) {
      await this.runner.deleteThread(topic.id);
      await this.workspace.unbindTopic(topic.id);
    }
    return { threadId: topic.parentId, removed: !kept };
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
          true,
        )
      ).id;
    let reply: string;
    try {
      reply = await this.turn(
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
    return { threadId, reply };
  };
  /**
   * A new thread; `source` marks background threads such as Slack's.
   * `topic` makes it a topic thread in the Dot's main chat.
   */
  async createConversation(
    dotId: string,
    title: string,
    source?: string,
    topic?: boolean,
  ): Promise<Conversation> {
    this.requireReady();
    if (!(await this.workspace.dot(dotId))) throw new Error('Dot not found.');
    const parentId: string | undefined = topic
      ? (await this.dotConversation(dotId)).conversation.id
      : undefined;
    const id = randomUUID();
    await this.conversations.createThread({ threadId: id, dotId });
    return this.workspace.bindThread(
      id,
      dotId,
      title,
      source,
      parentId ? { parentId } : undefined,
    );
  }
  /**
   * Splits a conversation at a message into a new topic thread in the same
   * Dot's chat: `move` takes that exchange and everything after it, `copy`
   * starts the thread with that one exchange and leaves the chat as it is.
   */
  async splitConversation(
    threadId: string,
    messageId: string,
    mode: 'move' | 'copy',
    title?: string,
  ) {
    this.requireReady();
    const thread = await this.workspace.requireThread(threadId);
    const parentId =
      thread.parentId ??
      (await this.dotConversation(thread.dotId)).conversation.id;
    const messages = await this.runner.messages(threadId);
    const index = messages.findIndex((message) => message.id === messageId);
    const from = messages
      .slice(0, index + 1)
      .findLast((m) => m.role === 'user');
    const name =
      title?.trim() ||
      (from
        ? messageText(from).replace(/\s+/g, ' ').trim().slice(0, 60)
        : '') ||
      'New thread';
    const id = randomUUID();
    const { anchorMessageId } = await this.runner.split({
      sourceId: threadId,
      targetId: id,
      messageId,
      mode,
      ...(title?.trim() ? { name: title.trim() } : {}),
      // Moved out of the main chat, the exchanges still show there, labelled
      // with the thread; only the model's context for them changes.
      keepShown: mode === 'move' && parentId === threadId,
    });
    const conversation = await this.workspace.bindThread(
      id,
      thread.dotId,
      name,
      undefined,
      {
        parentId,
        // A copy from the main chat is shown there as a card where it grew
        // from; a move keeps showing the exchanges themselves.
        ...(parentId === threadId && mode === 'copy' && anchorMessageId
          ? { anchorMessageId }
          : {}),
      },
    );
    // A real title once there is an answer to describe.
    if (!title?.trim())
      void this.nameThread({
        threadId: id,
        runId: '',
        status: 'finished',
        error: null,
        messages: await this.runner.messages(id),
        added: [],
      });
    return conversation;
  }
  /** The Dot's one continuing chat, created on first use. */
  async dotConversation(
    dotId: string,
    title?: string,
  ): Promise<{ conversation: Conversation; created: boolean }> {
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
    const excerpt = namingExcerpt(run.messages);
    if (!excerpt) return;
    this.naming.add(run.threadId);
    try {
      if ((await runner.thread(run.threadId))?.name) return;
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
        undefined,
        true,
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
