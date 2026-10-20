import { isIP, Socket } from "node:net";

/** A connection the guard refused: where it was going, and when. */
export interface EgressAttempt {
  host: string;
  port: number | null;
  at: Date;
}

export class EgressBlockedError extends Error {
  readonly code = "EGRESS_BLOCKED";
  constructor(
    readonly host: string,
    readonly port: number | null,
  ) {
    super(`egress blocked: ${host}${port === null ? "" : `:${port}`} is not on this machine`);
    this.name = "EgressBlockedError";
  }
}

/** This machine: `localhost` and the loopback addresses (127.0.0.0/8 and ::1). */
export function isLoopback(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (bare === "localhost" || bare.endsWith(".localhost")) return true;
  if (isIP(bare) === 4) return bare.startsWith("127.");
  if (isIP(bare) === 6) return bare === "::1" || bare.startsWith("::ffff:127.");
  return false;
}

/** Where `socket.connect(...)` was asked to go, from any of its call shapes. A Unix socket path has no host. */
function target(args: unknown[]): { host: string; port: number | null } | null {
  let first = args[0];
  // net.connect() and tls.connect() pass their arguments already normalised, as an array.
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === "object") {
    const options = first as { host?: string; hostname?: string; port?: number | string; path?: string };
    if (options.path) return null;
    return { host: options.host ?? options.hostname ?? "localhost", port: Number(options.port ?? 0) || null };
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return null;
  const host = typeof args[1] === "string" ? args[1] : "localhost";
  return { host, port: Number(first) || null };
}

export interface EgressGuard {
  /** Every connection refused since the guard went on. */
  readonly blocked: EgressAttempt[];
  /** Every connection let through, as host:port. */
  readonly allowed: string[];
  /** Takes the guard off. */
  restore(): void;
}

/**
 * The egress monitor: refuses, inside this process, every TCP connection that leaves the machine. Every client
 * Node has (fetch, so the AI SDK; postgres; tls) opens its socket through `net.Socket.prototype.connect`, so
 * that's where it sits. A refused connection fails on the next tick with `EgressBlockedError`, before any DNS
 * lookup, so it can't hang; it's recorded in `blocked`. `allow` adds hosts beyond loopback (a database on
 * another machine of the closed network, say).
 *
 * It's a check, not a wall: code can still reach the network around it (a child process, a native module). The
 * wall is the network itself: the `airgap` Compose profile, whose network has no route out.
 */
export function guardEgress(options: { allow?: (host: string) => boolean } = {}): EgressGuard {
  const allowExtra = options.allow ?? (() => false);
  const blocked: EgressAttempt[] = [];
  const allowed: string[] = [];
  const original = Socket.prototype.connect;
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    const to = target(args);
    if (to === null || isLoopback(to.host) || allowExtra(to.host)) {
      if (to) allowed.push(`${to.host}:${to.port}`);
      return (original as (...a: unknown[]) => Socket).apply(this, args);
    }
    blocked.push({ ...to, at: new Date() });
    const error = new EgressBlockedError(to.host, to.port);
    process.nextTick(() => this.destroy(error));
    return this;
  } as typeof original;
  return {
    blocked,
    allowed,
    restore() {
      Socket.prototype.connect = original;
    },
  };
}
