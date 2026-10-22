import type { createLogger } from "@/lib/logger";

type Logger = Pick<ReturnType<typeof createLogger>, "info" | "error">;

export interface PollLoopOptions {
  /** Named in the two log lines. */
  name: string;
  /** The wait between passes while they succeed. */
  intervalMs: number;
  /** The longest wait while they fail. */
  maxMs?: number;
  /** The wait before the first pass. */
  firstMs?: number;
  pass: () => Promise<void>;
  logger: Logger;
  now?: () => number;
}

export interface PollLoop {
  /** Runs a pass now, or right after the one running. */
  kick(): void;
  stop(): void;
}

/** The wait after `failures` failed passes in a row: the interval, doubled per failure, capped at `maxMs`. */
export function backoffMs(failures: number, intervalMs: number, maxMs: number): number {
  return failures ? Math.min(intervalMs * 2 ** failures, maxMs) : intervalMs;
}

/**
 * Runs `pass` every `intervalMs`, one at a time. While it throws (Postgres stopped, say), the wait doubles up to
 * `maxMs`, and the logger hears once when passes start failing and once when one works again, not every pass.
 */
export function pollLoop({
  name,
  intervalMs,
  maxMs = 30_000,
  firstMs = 0,
  pass,
  logger,
  now = Date.now,
}: PollLoopOptions): PollLoop {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;
  let stopped = false;
  let failures = 0;
  let downSince = 0;

  function schedule(ms: number) {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void run(), ms);
  }

  async function run() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    clearTimeout(timer);
    try {
      do {
        again = false;
        await pass();
      } while (again && !stopped);
      if (failures) logger.info(`${name} recovered`, { failures, downMs: now() - downSince });
      failures = 0;
    } catch (error) {
      if (!failures) {
        downSince = now();
        logger.error(`${name} failed; retrying with backoff, quietly until it works`, { error, maxMs });
      }
      failures += 1;
    } finally {
      running = false;
      schedule(backoffMs(failures, intervalMs, maxMs));
    }
  }

  schedule(firstMs);
  return {
    kick: () => void run(),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
