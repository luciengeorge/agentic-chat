import { readFileSync } from "node:fs";
import { afterEach } from "vitest";

import type { Runtime } from "../../../servers/fake-workspace/app";
import type { Client } from "../../../servers/fake-workspace/testing";
import type { Fetch } from "./graph";

import { createApp, DEFAULT_CORPUS_DIR } from "../../../servers/fake-workspace/app";
import { CONTROL_HEADER, DEV_CONTROL_TOKEN } from "../../../servers/fake-workspace/control";
import { FAST, ManualClock } from "../../../servers/fake-workspace/testing";

export { serveReceiver } from "../../../servers/fake-workspace/testing";

/** A fetch that sends each request to an in-process fake-workspace app. */
export function fetchFrom(client: Client): Fetch {
  return (url, init = {}) =>
    client.request(init.method ?? "GET", url, {
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body as string | undefined,
    });
}

export const REAL_BASE_URL = "http://fw";
export const KESTREL_TOKEN = "dev-workspace-kestrel";

interface ManifestItem {
  id: string;
  path: string;
  kind: "file" | "folder";
}

export interface RealWorkspace {
  runtime: Runtime;
  /** Graph requests to the app, as `fetch`. */
  fetch: Fetch;
  /** A control API call (`/_control<path>`); throws unless it succeeds. */
  control(method: string, path: string, json?: unknown): Promise<Response>;
  /** Kestrel's item id for a path, from the committed manifest. */
  id(path: string): string;
  /** Kestrel's files, by path. */
  files(): string[];
}

/**
 * fake-workspace over the committed corpus and `world.yaml`, as `pnpm fake-workspace` serves it, in process: the
 * real Kestrel drive (18 folders, 40 files), for tests whose numbers the section 02 READMEs quote. Each `start()`
 * is a fresh app; every one is closed after the test.
 */
export function setupRealWorkspace(): { start(): RealWorkspace } {
  const runtimes: Runtime[] = [];
  afterEach(async () => {
    for (const runtime of runtimes.splice(0)) await runtime.notifier.close();
  });
  const manifest = JSON.parse(readFileSync(`${DEFAULT_CORPUS_DIR}/manifest.json`, "utf8")) as {
    sites: { kestrel: { items: ManifestItem[] } };
  };
  const items = manifest.sites.kestrel.items;
  return {
    start() {
      const { app, runtime } = createApp({ env: "dev", clock: new ManualClock(), policy: FAST });
      runtimes.push(runtime);
      const fetch: Fetch = async (url, init) => app.fetch(new Request(new URL(url, REAL_BASE_URL), init));
      return {
        runtime,
        fetch,
        async control(method, path, json) {
          const response = await app.fetch(
            new Request(`${REAL_BASE_URL}/_control${path}`, {
              method,
              headers: { [CONTROL_HEADER]: DEV_CONTROL_TOKEN, "content-type": "application/json" },
              ...(json === undefined ? {} : { body: JSON.stringify(json) }),
            }),
          );
          if (!response.ok) throw new Error(`${method} /_control${path}: ${response.status} ${await response.text()}`);
          return response;
        },
        id(path) {
          const item = items.find((candidate) => candidate.path === path);
          if (!item) throw new Error(`no item at ${path} in the corpus`);
          return item.id;
        },
        files: () =>
          items
            .filter((item) => item.kind === "file")
            .map((item) => item.path)
            .sort(),
      };
    },
  };
}
