import { setTimeout as delay } from "node:timers/promises";

/**
 * Real UTC time, unless the control API pinned it. Waits (retry backoff, injected latency) go
 * through `sleep`, so tests can see and control them.
 */
export class Clock {
  pinned: Date | null = null;

  now(): Date {
    return this.pinned ?? new Date();
  }

  /** Rejects with the signal's reason if it aborts first. */
  async sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    await delay(seconds * 1000, undefined, { signal });
  }
}

/** ISO 8601 in UTC with a `Z`, and a fraction only when there is one, as Python's isoformat. */
export function iso(moment: Date): string {
  const text = moment.toISOString();
  return text.endsWith(".000Z") ? text.replace(".000Z", "Z") : text.replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** The time to stamp on a change: whole seconds. */
export function stamp(clock: Clock): Date {
  return new Date(Math.floor(clock.now().getTime() / 1000) * 1000);
}
