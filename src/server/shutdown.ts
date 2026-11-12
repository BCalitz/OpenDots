export function createShutdown(options: {
  stopRunner: () => void | Promise<void>;
  stopPlatform: () => Promise<void>;
  closeServer: () => Promise<void>;
  /** Runs last, once everything that writes to the database has stopped. */
  closeDatabase?: () => Promise<void>;
  exit: (code: number) => void;
  report: (operation: string, error: unknown) => void;
  timeoutMs?: number;
}) {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= (async () => {
      let failed = false;
      const report = (operation: string, error: unknown) => {
        failed = true;
        options.report(operation, error);
      };
      let runnerStopped: Promise<void> = Promise.resolve();
      try {
        runnerStopped = Promise.resolve(options.stopRunner()).catch((error) =>
          report('Stopping scheduler failed', error),
        );
      } catch (error) {
        report('Stopping scheduler failed', error);
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          report('Shutdown deadline exceeded', new Error('Timeout'));
          resolve();
        }, options.timeoutMs ?? 8000);
      });
      const settle = async (operation: string, action: () => Promise<void>) => {
        try {
          await action();
        } catch (error) {
          report(operation, error);
        }
      };
      await Promise.race([
        Promise.all([
          runnerStopped,
          settle('Stopping Channels failed', options.stopPlatform),
          settle('Closing HTTP server failed', options.closeServer),
        ]).then(() =>
          options.closeDatabase
            ? settle('Closing database failed', options.closeDatabase)
            : undefined,
        ),
        deadline,
      ]);
      clearTimeout(timer);
      options.exit(failed ? 1 : 0);
    })());
}
