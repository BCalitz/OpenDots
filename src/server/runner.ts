import { DEFAULT_WORKER_LEASE_MS, Store } from './store.js';
import type { Result, Memory } from '../shared/types.js';
import type { Claim } from './store.js';
import { research, type Config } from './research.js';
import { DEFAULT_AGENT_RUN_TIMEOUT_MS } from './platform-config.js';
export class Runner {
  private timer?: ReturnType<typeof setInterval>;
  private active = new Map<string, AbortController>();
  private claiming = false;
  constructor(
    private store: Store,
    private config: Config,
    private execute?: (
      claim: Claim,
      memories: Memory[],
      signal: AbortSignal,
      progress: (text: string) => void,
    ) => Promise<Result>,
    private runTimeoutMs = DEFAULT_AGENT_RUN_TIMEOUT_MS,
  ) {}
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => void this.tick(), 1000);
      void this.tick();
    }
  }
  async stop() {
    clearInterval(this.timer);
    this.timer = undefined;
    try {
      // Interrupt first, so the aborted run cannot record itself as failed.
      for (const task of await this.store.tasks()) {
        if (this.active.has(task.id) && task.lease)
          await this.store.interrupt(
            { ...task, lease: task.lease },
            'Server stopped during this run. Review completed effects before retrying.',
          );
      }
    } finally {
      this.abortAll();
    }
  }
  abort(id: string) {
    this.active.get(id)?.abort(new Error('Run stopped.'));
  }
  abortAll() {
    for (const controller of this.active.values())
      controller.abort(new Error('Run stopped because settings changed.'));
  }
  async tick() {
    try {
      await this.runTick();
    } catch {
      // Store errors must not become unhandled interval promise rejections.
      // Do not log task content, provider responses, or database details.
      console.error(
        'Background runner tick failed; will retry on the next tick.',
      );
    }
  }
  private async runTick() {
    if (this.active.size || this.claiming) return;
    // Leave time to persist the outcome after the configured run timeout.
    this.claiming = true;
    let claim: Claim | null;
    try {
      claim = await this.store.claim(
        Date.now(),
        Math.max(DEFAULT_WORKER_LEASE_MS, this.runTimeoutMs * 2),
      );
    } finally {
      this.claiming = false;
    }
    if (!claim) return;
    const owned = claim;
    const controller = new AbortController();
    this.active.set(claim.id, controller);
    let checking = false;
    const ownershipCheck = setInterval(() => {
      if (checking) return;
      checking = true;
      this.store
        .owns(owned)
        .then((owns) => {
          if (!owns)
            controller.abort(new Error('Run permission or lease was revoked.'));
        })
        .catch(() => controller.abort(new Error('Run ownership check failed.')))
        .finally(() => (checking = false));
    }, 100);
    const timeout = setTimeout(
      () =>
        controller.abort(
          new Error(
            `Research exceeded the ${this.runTimeoutMs / 1000} second time limit.`,
          ),
        ),
      this.runTimeoutMs,
    );
    try {
      const settings = await this.store.settings();
      const memories = settings.memoryAllowed
        ? await this.store.memories()
        : [];
      // Progress lines are written in order; the ownership check above
      // stops a run whose lease was revoked.
      let progressWrites = Promise.resolve();
      const progress = (text: string) => {
        controller.signal.throwIfAborted();
        progressWrites = progressWrites
          .then(() => this.store.event(owned.id, owned.lease, text))
          .catch(() => undefined);
      };
      const result = this.execute
        ? await this.execute(claim, memories, controller.signal, progress)
        : await research(
            claim.prompt,
            memories,
            this.config,
            controller.signal,
            progress,
          );
      controller.signal.throwIfAborted();
      await progressWrites;
      await this.store.finish(claim, result);
    } catch (error) {
      await this.store.fail(
        claim,
        error instanceof Error ? error.message : 'Unexpected research failure.',
      );
    } finally {
      clearInterval(ownershipCheck);
      clearTimeout(timeout);
      this.active.delete(claim.id);
    }
  }
}
