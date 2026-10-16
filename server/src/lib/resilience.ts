/**
 * Keeping the process alive, and stopping it cleanly when it must stop.
 *
 * A rejected promise nobody awaited, or an error thrown outside a request, is
 * enough to end a Node process. Both are handled here on purpose, and
 * differently:
 *
 * - An unhandled rejection is logged and the process carries on. Requests run
 *   in their own transactions, so one stray rejection says nothing about the
 *   next request.
 * - An uncaught exception means this process no longer knows what state it is
 *   in. It finishes the requests in flight, closes the database pool and exits
 *   non-zero, so the host restarts it.
 */
import { logServerError, newErrorId } from './logging.js';

type Closable = { close(cb: (err?: Error) => void): void; closeIdleConnections?: () => void };

export interface ShutdownDeps {
  server: Closable;
  closePool: () => Promise<void>;
  exit: (code: number) => void;
  /** How long to wait for requests in flight before giving up. */
  timeoutMs?: number;
  log?: (message: string) => void;
}

/**
 * Returns a function that stops the server once. Further calls are ignored, so
 * two signals in a row, or a signal during an exception, do not race.
 */
export function makeShutdown(deps: ShutdownDeps) {
  const { server, closePool, exit, timeoutMs = 10_000, log = console.log } = deps;
  let started = false;

  return async function shutdown(reason: string, code = 0): Promise<void> {
    if (started) return;
    started = true;
    log(`Shutting down (${reason}).`);

    // Requests that never finish must not hold the exit hostage.
    const force = setTimeout(() => {
      log('Requests did not finish in time; exiting anyway.');
      exit(1);
    }, timeoutMs);
    force.unref?.();

    // Stop accepting, let requests in flight finish, drop idle keep-alive sockets.
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections?.();
    await closed;

    try {
      await closePool();
    } catch {
      /* the pool may already be broken; we are leaving anyway */
    }
    clearTimeout(force);
    exit(code);
  };
}

interface ProcessLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
}

/** Registers the handlers. `target` is the process, or a stand-in in tests. */
export function installProcessGuards(
  shutdown: (reason: string, code?: number) => Promise<void>,
  target: ProcessLike = process,
): void {
  target.on('unhandledRejection', (reason: unknown) => {
    logServerError(newErrorId(), reason, 'PROCESS', 'unhandledRejection');
  });

  target.on('uncaughtException', (err: unknown) => {
    logServerError(newErrorId(), err, 'PROCESS', 'uncaughtException');
    void shutdown('uncaught exception', 1);
  });

  target.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  target.on('SIGINT', () => void shutdown('SIGINT', 0));
}
