// 👨‍💼 "Nothing leaves the network" is a promise Kestrel makes to its regulator, so it needs proof, not a config
//    flag. The real wall is the network: a Compose network with no route out. Inside the app, a monitor watches
//    every connection, refuses any that would leave the machine, and keeps a list, so a run that tried shows up.

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
  // 🐨 Strip the square brackets an IPv6 address may come in (`[::1]`) and lower-case it. Then it's this machine
  //    when it's `localhost` or ends in `.localhost`, when it's an IPv4 address starting `127.`, or when it's the
  //    IPv6 loopback `::1` (or an IPv4 loopback written as IPv6, `::ffff:127.0.0.1`). Anything else isn't.
  //
  // 🐨 The classic mistake is matching text: `host.startsWith("127")` lets `127.example.com` through, and
  //    `host.includes("localhost")` lets `localhost.evil.com` through. Check that it really is an address first.
  //
  // 💰 `import { isIP, Socket } from "node:net"` at the top (this step uses both). `isIP(text)` is 4, 6, or 0 for
  //    "not an address"; `text.replace(/^\[|\]$/g, "")`.
  //
  // 🦉 Why loopback is the line. 127.0.0.0/8 and ::1 never leave the network card: the kernel hands the packets
  //    straight back. That's where LM Studio (127.0.0.1:1234), ParadeDB (localhost:5432) and fake-workspace
  //    (:8100) listen, so the app can run whole, and nothing else is allowed by default. A name is only safe when
  //    it's one the system resolves to loopback without asking a DNS server: `localhost` and `*.localhost`.
  throw new Error(`isLoopback(${host}) isn't written yet`);
}

/** Where `socket.connect(...)` was asked to go, from any of its call shapes. A Unix socket path has no host. */
export function connectTarget(args: unknown[]): { host: string; port: number | null } | null {
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
  // 🐨 Keep the original `Socket.prototype.connect`, and two lists, `blocked` and `allowed`.
  // 🐨 Replace `Socket.prototype.connect` with a `function` (not an arrow: you need its `this`, the socket) that
  //    finds where the call is going with `connectTarget(args)`:
  //    - nowhere (a Unix socket), loopback, or a host `allow` accepts: push `host:port` onto `allowed` (when
  //      there's a host) and call the original with the same `this` and arguments, returning what it returns;
  //    - anywhere else: push `{ host, port, at: new Date() }` onto `blocked`, and on the next tick destroy the
  //      socket with an `EgressBlockedError`. Return the socket, as connect does.
  // 🐨 Return `{ blocked, allowed, restore }`, where `restore` puts the original back.
  //
  // 🐨 The classic mistakes: patching `net.connect` (tls.connect and postgres's `new Socket().connect()` never
  //    call it), throwing from inside connect (the error escapes the client's handlers instead of failing its
  //    request), and calling the original before deciding (the DNS lookup has already gone out).
  //
  // 💰 `original.apply(this, args)`; `process.nextTick(() => ...)`; `socket.destroy(error)` fails the socket
  //    with that error, which its owner (fetch, postgres) reports as its own failure. The replacement's type is
  //    `typeof original`.
  //
  // 🦉 Why the prototype. fetch (undici), tls, postgres.js and every SDK built on them end up in
  //    `Socket.prototype.connect`: `net.connect()` and `tls.connect()` are wrappers that make a socket and call
  //    it. Patching the one method every socket shares catches them all, and only TCP: a Unix socket has a path,
  //    not a host.
  // 🦉 Why fail on the next tick, and how fast that is. Callers attach their error handlers after `connect()`
  //    returns. A throw inside it reaches code that isn't expecting one; an error emitted on the next tick
  //    arrives the way a refused connection does, so fetch rejects and postgres reports it. Nothing has gone out
  //    yet, not even the DNS question, so it fails in a millisecond. But the caller may retry: the AI SDK waits
  //    2 s, then 4 s, and so on. The test at the end measures what that does to a refused request.
  // 🦉 It's a check, not a wall. A child process or a native module opens sockets without this method. The wall
  //    is the `airgap` Compose network (`internal: true`), where nothing has a route out; this monitor proves
  //    the app itself never tried.
  //
  // 📜 https://nodejs.org/api/net.html#socketconnect
  //
  // 🚨 The tests check loopback names and addresses (and look-alikes), a refusal that comes before any DNS
  //    lookup and on the socket rather than as a throw, every client shape (net, a bare Socket, tls), loopback
  //    let through and listed, `allow`, `restore`, and the retries: 3 refused attempts over 6 s for OpenAI's
  //    embeddings, 6 over 62 s for Cohere's rerank.
  throw new Error(`guardEgress(${options.allow ? "with allow" : "loopback only"}) isn't written yet`);
}
