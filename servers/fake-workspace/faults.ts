/** Injected faults: throttling, errors and latency on matching Graph requests. */
import { z } from "zod";

import type { Clock } from "./clock";

import { GraphError } from "./errors";

export const FaultSpecSchema = z
  .object({
    site: z.string().nullish().default(null),
    kind: z.enum(["throttle", "error", "latency"]),
    /** Matched against the request path, e.g. /v1.0/sites/kestrel. */
    path_prefix: z.string().nullish().default(null),
    /** Let this many matching requests through first. */
    after_requests: z.int().min(0).default(0),
    /** Then fire this many times; null: until cleared. */
    count: z.int().min(1).nullish().default(null),
    retry_after_s: z.int().min(0).nullish().default(null),
    status: z.int().min(500).max(599).default(503),
    latency_ms: z.int().min(0).nullish().default(null),
  })
  .refine((spec) => spec.kind !== "latency" || spec.latency_ms !== null, {
    message: "a latency fault needs latency_ms",
    path: ["latency_ms"],
  });

export type FaultSpec = z.infer<typeof FaultSpecSchema>;

interface Fault {
  readonly spec: FaultSpec;
  seen: number;
  fired: number;
}

export class Faults {
  private readonly faults: Fault[] = [];

  constructor(private readonly clock: Clock) {}

  add(spec: FaultSpec): void {
    this.faults.push({ spec, seen: 0, fired: 0 });
  }

  /** Empties the list in place, so a request held in a latency fault meets none of the others after its wait. */
  clear(): void {
    this.faults.length = 0;
  }

  /**
   * Faults are tried in the order they were added. Latency stacks; the first throttle or error
   * that fires answers the request.
   */
  async apply(site: string, path: string): Promise<void> {
    for (const fault of this.faults) {
      const { spec } = fault;
      if ((spec.site !== null && spec.site !== site) || !path.startsWith(spec.path_prefix ?? "")) continue;
      fault.seen += 1;
      if (fault.seen <= spec.after_requests || fault.fired === spec.count) continue;
      fault.fired += 1;
      if (spec.kind === "latency") {
        await this.clock.sleep(spec.latency_ms! / 1000);
      } else if (spec.kind === "throttle") {
        const retryAfter = { "Retry-After": String(spec.retry_after_s ?? 1) };
        throw new GraphError(429, "TooManyRequests", "Please retry again later.", retryAfter);
      } else {
        const code = spec.status === 503 ? "serviceNotAvailable" : "generalException";
        const headers = spec.retry_after_s === null ? undefined : { "Retry-After": String(spec.retry_after_s) };
        throw new GraphError(spec.status, code, "An injected fault.", headers);
      }
    }
  }
}
