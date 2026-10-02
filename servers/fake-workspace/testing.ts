import type { AddressInfo } from "node:net";

/**
 * Test support: a small world and corpus in the build's shape, a webhook receiver on localhost, and
 * a clock whose waits tests control.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { stringify } from "yaml";

import { type World, loadWorld } from "@/fixtures/world";

import type { DeliveryPolicy } from "./delivery";

import { type AppEnv, type Runtime, createApp } from "./app";
import { Clock } from "./clock";
import { sha256 } from "./site";

type Site = "kestrel" | "harbour";
type OwnGrant = readonly ["user" | "group", string, "read" | "write"];

export const BASE_URL = "http://fw";

const WORLD = {
  version: 1,
  id_namespace: "2b0f5a64-0f6e-4c55-9f43-0d6d1c1d3f10",
  today: "2026-09-30",
  tenants: {
    kestrel: {
      name: "Kestrel Pay",
      domain: "kestrelpay.example",
      password: "dev-password",
      groups: [
        "/Kestrel",
        "/Kestrel/Exec",
        "/Kestrel/Finance",
        "/Kestrel/Finance/AP",
        "/Kestrel/Finance/FP&A",
        "/Kestrel/HR",
      ],
      users: [
        { username: "amara.okafor", name: "Amara Okafor", title: "Chief Executive Officer", groups: ["/Kestrel/Exec"] },
        {
          username: "daniel.reyes",
          name: "Daniel Reyes",
          title: "Chief Financial Officer",
          groups: ["/Kestrel/Exec", "/Kestrel/Finance"],
        },
        {
          username: "tom.whitfield",
          name: "Tom Whitfield",
          title: "Financial Controller",
          groups: ["/Kestrel/Finance"],
        },
        { username: "leo.martin", name: "Leo Martin", title: "Finance Intern", groups: ["/Kestrel/Finance/AP"] },
        { username: "marco.bianchi", name: "Marco Bianchi", title: "HR Manager", groups: ["/Kestrel/HR"] },
        {
          username: "peter.hall",
          name: "Peter Hall",
          title: "Former FP&A Analyst",
          groups: ["/Kestrel/Finance/FP&A"],
          enabled: false,
        },
      ],
    },
    harbour: {
      name: "Harbour Health",
      domain: "harbourhealth.example",
      password: "dev-password",
      groups: ["/Harbour"],
      users: [{ username: "nina.osei", name: "Nina Osei", title: "Clinic Manager", groups: ["/Harbour"] }],
    },
  },
};

const AUTHORS: Record<Site, string> = { kestrel: "tom.whitfield", harbour: "nina.osei" };
/** The root's author, as in the build: the tenant's first enabled admin. */
const ADMINS: Record<Site, string> = { kestrel: "amara.okafor", harbour: "nina.osei" };

/**
 * (path, own grants, inherit), parents before children. /Company's files are out of order on
 * purpose: children must come back sorted by name, case-insensitively.
 */
const TREE: Record<Site, [string, OwnGrant[], boolean][]> = {
  kestrel: [
    ["/", [], false],
    ["/Company", [["group", "/Kestrel", "read"]], true],
    ["/Company/echo.md", [], true],
    ["/Company/Bravo.md", [], true],
    ["/Company/alpha.md", [], true],
    ["/Company/Delta.md", [], true],
    ["/Company/charlie.md", [], true],
    ["/Exec", [["group", "/Kestrel/Exec", "write"]], true],
    ["/Exec/Project Heron memo.pdf", [], true],
    [
      "/Finance",
      [
        ["group", "/Kestrel/Finance", "read"],
        ["user", "tom.whitfield", "write"],
      ],
      true,
    ],
    ["/Finance/Reports", [["group", "/Kestrel/Exec", "read"]], true],
    ["/Finance/Reports/Q3 report.pdf", [], true],
    ["/Finance/FP&A", [["group", "/Kestrel/Finance/FP&A", "write"]], false],
    ["/Finance/FP&A/plan.md", [], true],
    ["/HR", [["group", "/Kestrel/HR", "write"]], true],
    ["/HR/Casework", [], true],
    ["/HR/Casework/case note.pdf", [["user", "marco.bianchi", "read"]], false],
  ],
  harbour: [
    ["/", [], false],
    ["/Policies", [["group", "/Harbour", "read"]], true],
    ["/Policies/expenses.pdf", [], true],
  ],
};

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".md": "text/markdown" };

/** Fast retries and a short handshake, so failures show up quickly. */
export const FAST: DeliveryPolicy = {
  maxAttempts: 3,
  baseDelayS: 0.01,
  maxDelayS: 0.02,
  timeoutS: 2,
  retryTimeoutS: 2,
  validationTimeoutS: 0.5,
};

/** For waits on another request or the receiver: the deadline only bounds a failure. */
export const WAIT = { timeout: 10_000, interval: 10 };

export function until(condition: () => boolean): Promise<void> {
  return vi.waitFor(() => expect(condition()).toBe(true), WAIT);
}

/** A promise that `open` settles; the tsconfig's ES2022 lib has no `Promise.withResolvers`. */
function latch(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/**
 * Records every wait. A wait ends at once or, on a gated clock, when the test opens the gate (or the
 * wait is cancelled), so a test can act while a delivery waits to retry.
 */
export class ManualClock extends Clock {
  readonly waits: number[] = [];
  private gate: ReturnType<typeof latch> | null;

  constructor({ gated = false } = {}) {
    super();
    this.gate = gated ? latch() : null;
  }

  open(): void {
    this.gate?.open();
    this.gate = null;
  }

  override async sleep(seconds: number, signal?: AbortSignal): Promise<void> {
    this.waits.push(seconds);
    signal?.throwIfAborted();
    const gate = this.gate;
    if (!gate) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(signal!.reason);
      signal?.addEventListener("abort", abort, { once: true });
      void gate.promise.then(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
    });
  }
}

export interface Corpus {
  readonly dir: string;
  readonly worldPath: string;
  readonly world: World;
  id(site: Site, path: string): string;
  user(site: Site, username: string): string;
  group(site: Site, path: string): string;
  content(site: Site, path: string): Buffer;
  paths(site: Site): string[];
}

/** Writes `world.yaml`, and `manifest.json` with its blobs for TREE, into `dir`. */
export function buildCorpus(dir: string): Corpus {
  mkdirSync(join(dir, "blobs"), { recursive: true });
  const worldPath = join(dir, "world.yaml");
  writeFileSync(worldPath, stringify(WORLD));
  const world = loadWorld(worldPath);
  const corpus: Corpus = {
    dir,
    worldPath,
    world,
    id: (site, path) => world.itemId(site, path),
    user: (site, username) => world.userId(site, username),
    group: (site, path) => world.groupId(site, path),
    content: (site, path) => Buffer.from(`${site}:${path}\n`),
    paths: (site) => TREE[site].map(([path]) => path),
  };

  const sites: Record<string, unknown> = {};
  for (const site of ["kestrel", "harbour"] as const) {
    const items = TREE[site].map(([path, grants, inherit]) => {
      const slash = path.lastIndexOf("/");
      const name = path.slice(slash + 1);
      const author = corpus.user(site, path === "/" ? ADMINS[site] : AUTHORS[site]);
      const item: Record<string, unknown> = {
        id: corpus.id(site, path),
        path,
        name: name || "root",
        parent_id: path === "/" ? null : corpus.id(site, path.slice(0, slash) || "/"),
        kind: name.includes(".") ? "file" : "folder",
        created: "2026-09-01T09:00:00Z",
        modified: "2026-09-02T10:30:00Z",
        created_by: author,
        modified_by: author,
        sharing: {
          inherit,
          grants: grants.map(([kind, principal, role]) => ({
            principal_type: kind,
            principal_id: kind === "user" ? corpus.user(site, principal) : corpus.group(site, principal),
            principal_name: principal,
            role,
          })),
        },
      };
      if (item.kind === "file") {
        const content = corpus.content(site, path);
        const sha = sha256(content);
        const ext = extname(name);
        writeFileSync(join(dir, "blobs", `${sha}${ext}`), content);
        item.file = {
          mime_type: MIME[ext],
          size: content.length,
          sha256: sha,
          blob: `blobs/${sha}${ext}`,
          ...(ext === ".pdf" ? { pages: 1 } : {}),
        };
        Object.assign(item, {
          doc_id: name.toLowerCase().replaceAll(" ", "-"),
          format: ext.slice(1),
          traps: [],
          valid_from: null,
          valid_to: null,
        });
      }
      return item;
    });
    const tenant = world.tenant(site);
    const users = Object.fromEntries(
      tenant.users.map((user) => [
        corpus.user(site, user.username),
        { username: user.username, display_name: user.name },
      ]),
    );
    const groups = Object.fromEntries(tenant.groups.map((path) => [corpus.group(site, path), { path }]));
    sites[site] = { items, users, groups };
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: 1, sites }, null, 2));
  return corpus;
}

interface RequestOptions {
  json?: unknown;
  headers?: Record<string, string>;
}

/** An in-process client for one app, sending its bearer token unless a request sets its own. */
export interface Client {
  readonly runtime: Runtime;
  request(method: string, path: string, options?: RequestOptions): Promise<Response>;
  get(path: string, options?: RequestOptions): Promise<Response>;
  post(path: string, options?: RequestOptions): Promise<Response>;
  put(path: string, options?: RequestOptions): Promise<Response>;
  patch(path: string, options?: RequestOptions): Promise<Response>;
  delete(path: string, options?: RequestOptions): Promise<Response>;
}

export interface ClientOptions {
  corpusDir?: string;
  env?: AppEnv;
  token?: string | null;
  policy?: DeliveryPolicy;
  clock?: Clock;
}

/** What a webhook endpoint on localhost received, and how it answers. */
export interface Receiver {
  readonly url: string;
  /** echo: the token as text/plain; html: the token as text/html; held: no answer until released. */
  validation: "echo" | "wrong" | "empty" | "html" | "held";
  /** Replies to notifications, then 202. */
  statuses: number[];
  holdNotifications: boolean;
  readonly tokens: string[];
  readonly notifications: { value: Record<string, unknown>[] }[];
  /** Lets every held answer go. Closing the receiver releases them too. */
  release(): void;
  close(): Promise<void>;
}

/** A real HTTP server on a free localhost port. */
export async function serveReceiver(): Promise<Receiver> {
  const released = latch();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const reply = (status: number, body: string, kind = "text/plain") => {
        res.writeHead(status, { "Content-Type": `${kind}; charset=utf-8` }).end(body);
      };
      const token = new URL(req.url!, "http://receiver").searchParams.get("validationToken");
      if (token !== null) {
        receiver.tokens.push(token);
        if (receiver.validation === "held") await released.promise;
        const replies = { wrong: `${token}x`, empty: "" } as Record<string, string>;
        reply(200, replies[receiver.validation] ?? token, receiver.validation === "html" ? "text/html" : "text/plain");
        return;
      }
      receiver.notifications.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (receiver.holdNotifications) await released.promise;
      reply(receiver.statuses.shift() ?? 202, "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const receiver: Receiver = {
    url: `http://127.0.0.1:${port}/hooks?tenant=kestrel`,
    validation: "echo",
    statuses: [],
    holdNotifications: false,
    tokens: [],
    notifications: [],
    release: () => released.open(),
    close: async () => {
      released.open();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return receiver;
}

export interface FakeWorkspace {
  /** The corpus every client loads unless told otherwise. */
  readonly corpus: Corpus;
  /** A scratch directory for the test, removed after it. */
  readonly tmp: string;
  /** A fresh app, with its own in-memory state, and a client for it. Kestrel's by default. */
  client(options?: ClientOptions): Client;
  receiver(): Promise<Receiver>;
}

/** Per test: a corpus in a scratch directory; afterwards, every app and receiver is closed. */
export function setupFakeWorkspace(): FakeWorkspace {
  let tmp = "";
  let corpus: Corpus | undefined;
  const runtimes: Runtime[] = [];
  const receivers: Receiver[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fake-workspace-"));
    corpus = buildCorpus(join(tmp, "corpus"));
  });

  afterEach(async () => {
    // Apps first: closing them cancels deliveries that a receiver may be holding.
    for (const runtime of runtimes.splice(0)) await runtime.notifier.close();
    for (const receiver of receivers.splice(0)) await receiver.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  return {
    get corpus() {
      return corpus!;
    },
    get tmp() {
      return tmp;
    },
    client({ corpusDir, env = "dev", token = "dev-workspace-kestrel", policy = FAST, clock } = {}) {
      const { app, runtime } = createApp({
        env,
        corpusDir: corpusDir ?? corpus!.dir,
        worldPath: corpus!.worldPath,
        policy,
        clock: clock ?? new ManualClock(),
      });
      runtimes.push(runtime);
      const request = async (method: string, path: string, { json, headers }: RequestOptions = {}) => {
        const sent = new Headers(headers);
        if (token !== null && !sent.has("authorization")) sent.set("Authorization", `Bearer ${token}`);
        if (json !== undefined) sent.set("Content-Type", "application/json");
        const body = json === undefined ? undefined : JSON.stringify(json);
        return app.fetch(new Request(new URL(path, BASE_URL), { method, headers: sent, body }));
      };
      return {
        runtime,
        request,
        get: (path, options) => request("GET", path, options),
        post: (path, options) => request("POST", path, options),
        put: (path, options) => request("PUT", path, options),
        patch: (path, options) => request("PATCH", path, options),
        delete: (path, options) => request("DELETE", path, options),
      };
    },
    async receiver() {
      const receiver = await serveReceiver();
      receivers.push(receiver);
      return receiver;
    },
  };
}
