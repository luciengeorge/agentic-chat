/**
 * Section 09's test world: a throwaway database holding Kestrel's and Harbour's real directory and drive, synced
 * from fake-workspace over the committed corpus and `world.yaml`, in process. Every principal, membership, closure
 * row, document and ACL row is what a real sync writes, so a step's README can quote real counts: who reads how many
 * of the 40 Kestrel documents, how many principals leo.martin holds.
 *
 * With `chunks`, every document but the FCA filing is parsed and chunked by the reference code and embedded by the
 * hashing fake, so retrieval runs over real text (the filing's 5,274 chunks would take longer than the tests).
 */
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";

import type { Db } from "@/db/create";
import type { Tx } from "@/db/tenant";

import { chunk } from "#learn/chunk/chunk";
import { fullSync } from "#learn/connectors/drive-sync";
import { createGraphClient, type GraphClient } from "#learn/connectors/graph";
import { graphConnector } from "#learn/connectors/graph-connector";
import { applyDirectory, fetchDirectory } from "#learn/directory/sync";
import { hashingEmbedder } from "#learn/embed/fake";
import { parse } from "#learn/parse/parse";
import { corpusFile, recordedOcr } from "@/core/parse/corpus.test-helpers";
import { chunks as chunkTable } from "@/db/schema";
import { createTestDatabase, type TestDatabase } from "@/db/testing";
import { loadWorld } from "@/fixtures/world";

import { createApp, DEFAULT_CORPUS_DIR } from "../../../servers/fake-workspace/app";
import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../../servers/fake-workspace/control";
import { FAST, ManualClock } from "../../../servers/fake-workspace/testing";

export type Site = "kestrel" | "harbour";

/** The hashing fake at the app's dimensions: what the world's chunks are embedded with. */
export const WORLD_EMBEDDER = hashingEmbedder(1536);

/** Left out of `chunks`: its 3,000 pages take longer to parse and embed than every other document together. */
export const FILING_PATH = "/Legal/Regulatory/FCA Annual Regulatory Return 2026.pdf";

export interface AclWorld {
  t: TestDatabase;
  tenants: Record<Site, string>;
  /** A user's principal id (the directory's id, which is also the better-auth user id). */
  user(username: string, site?: Site): string;
  /** A group's principal id, by path. */
  group(path: string, site?: Site): string;
  /** A document's id, by path. */
  documentId(path: string, site?: Site): Promise<string>;
  /** Runs `fn` as the app role, inside the tenant. */
  inTenant<T>(site: Site, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** A fake-workspace control call (`/_control<path>`) on Kestrel's site; throws unless it succeeds. */
  control(method: string, path: string, json?: unknown): Promise<Response>;
  /** The site's item id for a path, from the corpus manifest. */
  itemId(path: string, site?: Site): string;
  graph(site?: Site): GraphClient;
  /** Directory sync for the site: what the sync workflow's directory step does. */
  syncDirectory(site?: Site, prepare?: (tx: Tx) => Promise<void>): ReturnType<typeof applyDirectory>;
  /** A full drive sync for the site, in one transaction, after `prepare` (say, `setSyncRun`). */
  syncDrive(site?: Site, prepare?: (tx: Tx) => Promise<void>): ReturnType<typeof fullSync>;
}

interface ManifestItem {
  id: string;
  path: string;
  kind: string;
  doc_id?: string;
}

/**
 * The world's own tenant scoping, the same `SET LOCAL` as `withTenantOn` but independent of it, so building the
 * world doesn't run the learner's code while section 09.6 is active.
 */
function scoped<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}

const world = loadWorld();
const manifest = JSON.parse(readFileSync(join(DEFAULT_CORPUS_DIR, "manifest.json"), "utf8")) as {
  sites: Record<Site, { items: ManifestItem[] }>;
};

/**
 * Builds the world once for the test file (`beforeAll`) and drops it after (`afterAll`). Documents are marked
 * `ready`, as ingestion would leave them, unless `ready` is false. With `drive: false` only the directories are
 * synced, and the drives are left for the test.
 */
export function setupAclWorld(options: { chunks?: boolean; ready?: boolean; drive?: boolean } = {}): {
  get(): AclWorld;
} {
  let current: AclWorld | null = null;
  let close: (() => Promise<void>) | null = null;

  beforeAll(async () => {
    const t = await createTestDatabase();
    const rows = await t.sql<{ id: string; slug: Site }[]>`
      INSERT INTO organization (name, slug, created_at)
      VALUES ('Kestrel Pay', 'kestrel', now()), ('Harbour Health', 'harbour', now())
      RETURNING id, slug`;
    const tenants = Object.fromEntries(rows.map((row) => [row.slug, row.id])) as Record<Site, string>;
    const { app, runtime } = createApp({ env: "dev", clock: new ManualClock(), policy: FAST });
    close = async () => {
      await runtime.notifier.close();
      await t.drop();
    };
    const fetch = async (url: string, init?: RequestInit) => app.fetch(new Request(new URL(url, "http://fw"), init));
    const graph = (site: Site = "kestrel") =>
      createGraphClient({ baseUrl: "http://fw", site, token: `dev-workspace-${site}`, fetch });
    const inTenant = <T>(site: Site, fn: (tx: Tx) => Promise<T>) => scoped(t.appDb, tenants[site], fn);

    const w: AclWorld = {
      t,
      tenants,
      user: (username, site = "kestrel") => world.userId(site, username),
      group: (path, site = "kestrel") => world.groupId(site, path),
      async documentId(path, site = "kestrel") {
        const [row] = await t.sql<{ id: string }[]>`
          SELECT id FROM documents WHERE tenant_id = ${tenants[site]} AND path = ${path}`;
        if (!row) throw new Error(`no document at ${path} in ${site}`);
        return row.id;
      },
      inTenant,
      async control(method, path, json) {
        const response = await app.fetch(
          new Request(`http://fw/_control${path}`, {
            method,
            headers: { [CONTROL_HEADER]: DEV_CONTROL_TOKEN, "content-type": "application/json" },
            ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          }),
        );
        if (!response.ok) throw new Error(`${method} /_control${path}: ${response.status} ${await response.text()}`);
        return response;
      },
      itemId(path, site = "kestrel") {
        const item = manifest.sites[site].items.find((candidate) => candidate.path === path);
        if (!item) throw new Error(`no item at ${path} in ${site}'s corpus`);
        return item.id;
      },
      graph,
      async syncDirectory(site = "kestrel", prepare) {
        const snapshot = await fetchDirectory(graph(site));
        return inTenant(site, async (tx) => {
          await prepare?.(tx);
          return applyDirectory(tx, tenants[site], snapshot, new Date());
        });
      },
      syncDrive: (site = "kestrel", prepare) =>
        inTenant(site, async (tx) => {
          await prepare?.(tx);
          return fullSync(tx, tenants[site], graphConnector(graph(site)));
        }),
    };

    try {
      for (const site of ["kestrel", "harbour"] as const) {
        await w.syncDirectory(site);
        if (options.drive !== false) await w.syncDrive(site);
      }
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message;
      throw new Error(`building the test world (directory and drive sync) failed: ${cause}`, {
        cause: error,
      });
    }
    if (options.ready !== false) await t.sql`UPDATE documents SET status = 'ready'`;
    if (options.chunks) await loadChunks(t, tenants);
    current = w;
  }, 120_000);

  afterAll(async () => {
    await close?.();
  });

  return {
    get() {
      if (!current) throw new Error("the ACL world isn't built yet: call get() inside a test");
      return current;
    },
  };
}

async function loadChunks(t: TestDatabase, tenants: Record<Site, string>) {
  const documents = await t.sql<{ id: string; tenant_id: string; path: string; mime_type: string; version: number }[]>`
    SELECT id, tenant_id, path, mime_type, version FROM documents WHERE path <> ${FILING_PATH}`;
  for (const document of documents) {
    const site = (Object.keys(tenants) as Site[]).find((key) => tenants[key] === document.tenant_id)!;
    const item = manifest.sites[site].items.find((candidate) => candidate.path === document.path);
    if (!item?.doc_id) throw new Error(`no corpus file for ${document.path}`);
    const parsed = await parse(corpusFile(item.doc_id).bytes(), document.mime_type, recordedOcr(item.doc_id));
    const pieces = chunk(parsed);
    const vectors = await WORLD_EMBEDDER.embed(pieces.map((piece) => piece.text));
    await t.db.insert(chunkTable).values(
      pieces.map((piece, i) => ({
        tenantId: document.tenant_id,
        documentId: document.id,
        documentVersion: document.version,
        ordinal: piece.ordinal,
        text: piece.text,
        pageStart: piece.pageStart,
        pageEnd: piece.pageEnd,
        section: piece.section,
        tokenCount: piece.tokenCount,
        embedding: vectors[i],
        embeddingModelVersion: WORLD_EMBEDDER.version,
      })),
    );
  }
}
