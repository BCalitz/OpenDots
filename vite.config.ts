/// <reference types="vitest/config" />
import { createLogger, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { darkTheme } from './src/build/dark-theme.ts';

// The API boots after Vite and restarts under `node --watch`; while it is down, Vite would log
// a full stack trace for every proxied request. Drop just those connection errors.
const logger = createLogger();
const logError = logger.error.bind(logger);
logger.error = (message, options) => {
  const code = (options?.error as NodeJS.ErrnoException | undefined)?.code;
  if (
    message.includes('proxy error') &&
    (code === 'ECONNREFUSED' || code === 'ECONNRESET')
  )
    return;
  logError(message, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react()],
  css: { postcss: { plugins: [darkTheme()] } },
  build: { outDir: 'dist/client' },
  // Tests run against Postgres in parallel. With a worker per core, the
  // timing-sensitive ones (voice, runner, shutdown) starve; half the cores
  // finish as fast. Several tests take 3 to 4 seconds under load, too close
  // to the 5-second default timeout.
  test: { maxWorkers: '50%', testTimeout: 15_000 },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
