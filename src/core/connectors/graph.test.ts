// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type Client, setupFakeWorkspace } from "../../../servers/fake-workspace/testing";
import {
  createGraphClient,
  type DeltaEntry,
  graphConnector,
  GraphRequestError,
  itemPath,
  ResyncRequiredError,
} from "./graph";
import { fetchFrom } from "./testing";
import { ConnectorError, type SourceFile } from "./types";

const fw = setupFakeWorkspace();

function connector(client: Client, options: { pageSize?: number; maxRetries?: number; token?: string } = {}) {
  const waits: number[] = [];
  const graph = createGraphClient({
    baseUrl: "http://fw",
    site: "kestrel",
    token: options.token ?? "dev-workspace-kestrel",
    fetch: fetchFrom(client),
    sleep: async (ms) => void waits.push(ms),
    pageSize: options.pageSize,
    maxRetries: options.maxRetries,
  });
  return { graph, waits };
}

async function control(client: Client, method: string, path: string, json?: unknown) {
  const response = await client.request(method, `/_control${path}`, { json });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
}

const files = (paths: string[]) => paths.filter((path) => /\.[a-z]+$/.test(path)).sort();

describe("the graph connector", () => {
  it("crawls every file, following nextLink across small pages", async () => {
    const client = fw.client();
    const { graph } = connector(client, { pageSize: 2 });
    const crawled = [];
    for await (const file of graph.crawl()) crawled.push(file);

    expect(crawled.map((file) => file.path).sort()).toEqual(files(fw.corpus.paths("kestrel")));
    const heron = crawled.find((file) => file.path === "/Exec/Project Heron memo.pdf")!;
    expect(heron.item.id).toBe(fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf"));
    expect(heron.item.file?.mimeType).toBe("application/pdf");
  });

  it("decodes the parent path, as in /Finance/FP&A", async () => {
    const client = fw.client();
    const { graph } = connector(client);
    const item = await graph.item(fw.corpus.id("kestrel", "/Finance/FP&A/plan.md"));
    expect(item.parentReference?.path).toBe("/drive/root:/Finance/FP%26A");
    expect(itemPath(item)).toBe("/Finance/FP&A/plan.md");
  });

  it("waits as Retry-After says when throttled, then succeeds", async () => {
    const client = fw.client();
    await control(client, "POST", "/faults", {
      site: "kestrel",
      kind: "throttle",
      path_prefix: "/v1.0/sites/kestrel/drive",
      count: 2,
      retry_after_s: 3,
    });
    const { graph, waits } = connector(client);
    expect((await graph.children("root")).length).toBeGreaterThan(0);
    expect(waits).toEqual([3000, 3000]);
  });

  it("gives up after its retries with a retryable error carrying Retry-After", async () => {
    const client = fw.client();
    await control(client, "POST", "/faults", { site: "kestrel", kind: "throttle", retry_after_s: 7 });
    const { graph, waits } = connector(client, { maxRetries: 1 });
    const error = await graph.children("root").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GraphRequestError);
    expect(error).toMatchObject({ status: 429, retryable: true, retryAfterMs: 7000 });
    expect(waits).toEqual([7000]);
  });

  it("fails at once, not retryable, on a token for another site", async () => {
    const client = fw.client();
    const { graph, waits } = connector(client, { token: "dev-workspace-harbour" });
    await expect(graph.children("root")).rejects.toMatchObject({ status: 403, code: "accessDenied", retryable: false });
    expect(waits).toEqual([]);
  });

  it("calls a request that got no answer retryable", async () => {
    const graph = createGraphClient({
      baseUrl: "http://fw",
      site: "kestrel",
      token: "t",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(graph.children("root")).rejects.toMatchObject({ status: 0, retryable: true });
  });

  it("reads renames, moves, deletes and sharing changes from delta, after taking the latest link", async () => {
    const client = fw.client();
    const { graph } = connector(client, { pageSize: 2 });
    const link = await graph.latestDeltaLink();
    const { corpus } = fw;
    const alpha = corpus.id("kestrel", "/Company/alpha.md");
    const bravo = corpus.id("kestrel", "/Company/Bravo.md");
    const plan = corpus.id("kestrel", "/Finance/FP&A/plan.md");
    const heron = corpus.id("kestrel", "/Exec/Project Heron memo.pdf");

    await control(client, "POST", `/sites/kestrel/items/${alpha}/rename`, { name: "alpha renamed.md" });
    await control(client, "POST", `/sites/kestrel/items/${bravo}/move`, {
      parent_id: corpus.id("kestrel", "/Exec"),
    });
    await control(client, "DELETE", `/sites/kestrel/items/${plan}`);
    await control(client, "PUT", `/sites/kestrel/items/${heron}/sharing`, {
      inherit: true,
      grants: [
        {
          principal_type: "user",
          principal_id: corpus.user("kestrel", "leo.martin"),
          principal_name: "leo.martin",
          role: "read",
        },
      ],
    });

    const { changes, deltaLink } = await graph.delta(link);
    const byId = new Map(changes.map((entry) => [entry.id, entry]));
    expect(byId.get(alpha)).toMatchObject({ name: "alpha renamed.md" });
    expect(byId.get(bravo)).toMatchObject({ parentReference: { id: corpus.id("kestrel", "/Exec") } });
    expect(byId.get(plan)).toMatchObject({ deleted: { state: "deleted" } });
    expect(byId.get(heron)).toMatchObject({ "@microsoft.graph.sharedChanged": "True" });
    // Moving Bravo under /Exec changed what it inherits: a sharing change, and still one entry.
    expect(changes.filter((entry) => entry.id === bravo)).toHaveLength(1);

    expect((await graph.delta(deltaLink)).changes).toEqual([]);
  });

  it("throws ResyncRequiredError on a link from before a reset", async () => {
    const client = fw.client();
    const { graph } = connector(client);
    const link = await graph.latestDeltaLink();
    await control(client, "POST", "/reset");
    const error = await graph.delta(link).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResyncRequiredError);
    expect(error).toMatchObject({ status: 410 });
  });

  it("keeps an entry once when pages repeat it", async () => {
    const entry = (name: string): DeltaEntry => ({
      id: "same",
      name,
      eTag: name,
      size: 1,
      lastModifiedDateTime: "2026-01-01T00:00:00Z",
    });
    const pages = [
      { value: [entry("first")], "@odata.nextLink": "http://fw/next" },
      { value: [entry("second")], "@odata.deltaLink": "http://fw/done" },
    ];
    const graph = createGraphClient({
      baseUrl: "http://fw",
      site: "kestrel",
      token: "t",
      fetch: async () => Response.json(pages.shift()),
    });
    const { changes, deltaLink } = await graph.delta("http://fw/start");
    expect(changes).toEqual([entry("second")]);
    expect(deltaLink).toBe("http://fw/done");
  });

  it("lists the directory: users, groups and direct members", async () => {
    const client = fw.client();
    const { graph } = connector(client, { pageSize: 2 });
    const users = await graph.users();
    expect(users.find((user) => user.userPrincipalName.startsWith("peter.hall@"))).toMatchObject({
      accountEnabled: false,
    });
    const groups = await graph.groups();
    expect(groups.map((group) => group.displayName).sort()).toContain("/Kestrel/Finance/AP");
    const finance = groups.find((group) => group.displayName === "/Kestrel/Finance")!;
    const members = await graph.members(finance.id);
    expect(members.map((member) => member.displayName).sort()).toEqual([
      "/Kestrel/Finance/AP",
      "/Kestrel/Finance/FP&A",
      "Daniel Reyes",
      "Tom Whitfield",
    ]);
  });
});

describe("the graph client as a Connector", () => {
  it("crawls a listing page at a time, each file once, as source files", async () => {
    const client = fw.client();
    const source = graphConnector(connector(client, { pageSize: 2 }).graph);
    const pages: SourceFile[][] = [];
    for await (const page of source.crawl()) pages.push(page);

    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((page) => page.length >= 1 && page.length <= 2)).toBe(true);
    const all = pages.flat();
    expect(all.map((file) => file.path).sort()).toEqual(files(fw.corpus.paths("kestrel")));
    expect(new Set(all.map((file) => file.id)).size).toBe(all.length);
    const heron = all.find((file) => file.path === "/Exec/Project Heron memo.pdf")!;
    expect(heron).toMatchObject({
      id: fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf"),
      name: "Project Heron memo.pdf",
      mimeType: "application/pdf",
    });
    expect(heron.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("turns a delta into files with their paths and deletes: a renamed folder re-paths its files", async () => {
    const client = fw.client();
    const source = graphConnector(connector(client, { pageSize: 2 }).graph);
    const cursor = await source.latestCursor();
    const { corpus } = fw;
    const alpha = corpus.id("kestrel", "/Company/alpha.md");
    const plan = corpus.id("kestrel", "/Finance/FP&A/plan.md");
    const heron = corpus.id("kestrel", "/Exec/Project Heron memo.pdf");

    await control(client, "POST", `/sites/kestrel/items/${alpha}/rename`, { name: "alpha renamed.md" });
    await control(client, "POST", `/sites/kestrel/items/${corpus.id("kestrel", "/Finance/FP&A")}/rename`, {
      name: "Planning",
    });
    await control(client, "DELETE", `/sites/kestrel/items/${heron}`);

    const { changes, cursor: next } = await source.delta(cursor);
    const fileAt = (id: string) =>
      changes.flatMap((change) => (change.type === "file" && change.file.id === id ? [change.file.path] : []));
    expect(fileAt(alpha)).toEqual(["/Company/alpha renamed.md"]);
    expect(fileAt(plan)).toEqual(["/Finance/Planning/plan.md"]);
    expect(changes).toContainEqual({ type: "deleted", id: heron });
    expect((await source.delta(next)).changes).toEqual([]);
  });

  it("throws the interface's ResyncRequiredError for an expired cursor", async () => {
    const client = fw.client();
    const source = graphConnector(connector(client).graph);
    const cursor = await source.latestCursor();
    await control(client, "POST", "/reset");
    const error = await source.delta(cursor).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ResyncRequiredError);
    expect(error).toBeInstanceOf(ConnectorError);
  });

  it("lists who may read a file as directory ids", async () => {
    const client = fw.client();
    const source = graphConnector(connector(client).graph);
    expect(await source.permissions(fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf"))).toEqual([
      fw.corpus.group("kestrel", "/Kestrel/Exec"),
    ]);
  });
});
