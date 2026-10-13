// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Client, type Corpus, setupFakeWorkspace } from "./testing";

const DELTA = "/v1.0/sites/kestrel/drive/root/delta";
const CONTROL = "/_control/sites/kestrel/items";
const PREFER = { Prefer: "deltashowremovedasdeleted, deltatraversepermissiongaps, deltashowsharingchanges" };
const SHARED = "@microsoft.graph.sharedChanged";

type Entry = Record<string, any>;

const fw = setupFakeWorkspace();

/** Follows nextLinks to the end of a round; returns its items and the deltaLink. */
async function sync(client: Client, url: string, { prefer = false } = {}): Promise<[Entry[], string]> {
  const items: Entry[] = [];
  for (;;) {
    const response = await client.get(url, { headers: prefer ? PREFER : {} });
    expect(response.status, await response.clone().text()).toBe(200);
    const page = await response.json();
    items.push(...page.value);
    if (page["@odata.deltaLink"]) {
      expect(page).not.toHaveProperty("@odata.nextLink");
      return [items, page["@odata.deltaLink"]];
    }
    url = page["@odata.nextLink"];
  }
}

async function latest(client: Client): Promise<string> {
  const page = await (await client.get(`${DELTA}?token=latest`)).json();
  expect(page.value).toEqual([]);
  return page["@odata.deltaLink"];
}

async function control(client: Client, method: string, path: string, json?: unknown): Promise<Response> {
  const response = await client.request(method, `${CONTROL}${path}`, { json });
  expect(response.ok, await response.clone().text()).toBe(true);
  return response;
}

async function item(client: Client, itemId: string, suffix = ""): Promise<Entry> {
  return (await client.get(`/v1.0/sites/kestrel/drive/items/${itemId}${suffix}`)).json();
}

function groupGrant(corpus: Corpus, path: string, role: string) {
  return { principal_type: "group", principal_id: corpus.group("kestrel", path), principal_name: path, role };
}

const ids = (items: Entry[]) => items.map((entry) => entry.id);
const shared = (items: Entry[]) => items.map((entry) => [entry.id, entry[SHARED]]);

describe("a full enumeration", () => {
  it("returns every item in creation order", async () => {
    const client = fw.client();
    let pages = 0;
    let url = `${DELTA}?$top=4`;
    const items: Entry[] = [];
    for (;;) {
      const page = await (await client.get(url)).json();
      pages += 1;
      items.push(...page.value);
      if (!page["@odata.nextLink"]) {
        expect(page).toHaveProperty("@odata.deltaLink");
        break;
      }
      expect(page).not.toHaveProperty("@odata.deltaLink");
      url = page["@odata.nextLink"];
      expect(url.startsWith("http://fw/v1.0/sites/kestrel/drive/root/delta?")).toBe(true);
    }
    expect(pages).toBe(5);
    expect(ids(items)).toEqual(fw.corpus.paths("kestrel").map((path) => fw.corpus.id("kestrel", path)));
    expect(items[0]!.root).toEqual({});
    for (const entry of items.slice(1)) {
      // Delta never sends paths (renaming a folder doesn't return its descendants) or cTags.
      expect(Object.keys(entry.parentReference)).toEqual(["id"]);
      expect(entry).not.toHaveProperty("cTag");
      expect(entry).not.toHaveProperty(SHARED);
    }
  });

  it("holds changes made during the round for the next one", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const first = await (await client.get(`${DELTA}?$top=5`)).json();
    const memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    await control(client, "POST", `/${memo}/rename`, { name: "Heron.pdf" });
    const [rest, link] = await sync(client, first["@odata.nextLink"]);
    expect(ids([...first.value, ...rest])).toEqual(corpus.paths("kestrel").map((path) => corpus.id("kestrel", path)));
    const [items] = await sync(client, link);
    expect(items.map((entry) => [entry.id, entry.name])).toEqual([[memo, "Heron.pdf"]]);
  });
});

describe("changes", () => {
  it("a latest token skips the current state", async () => {
    const client = fw.client();
    const link = await latest(client);
    expect(await sync(client, link)).toEqual([[], link]);
  });

  it("a created file appears", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const link = await latest(client);
    const body = {
      parent_id: corpus.id("kestrel", "/Company"),
      name: "new.md",
      content_base64: Buffer.from("hello").toString("base64"),
      mime_type: "text/markdown",
    };
    const created = await (await control(client, "POST", "", body)).json();
    const [items] = await sync(client, link);
    expect(ids(items)).toEqual([created.id]);
    expect(items[0]!.name).toBe("new.md");
    expect(items[0]!.size).toBe(5);
    expect(items[0]!.parentReference).toEqual({ id: corpus.id("kestrel", "/Company") });
  });

  it("a move shows the new parent", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    const execFolder = corpus.id("kestrel", "/Exec");
    const before = await item(client, report);
    const link = await latest(client);
    await control(client, "POST", `/${report}/move`, { parent_id: execFolder });
    let [items] = await sync(client, link);
    expect(items.map((entry) => [entry.id, entry.parentReference])).toEqual([[report, { id: execFolder }]]);
    expect(items[0]).not.toHaveProperty(SHARED);
    // Its effective sharing changed with its parent, which the Prefer header reveals.
    [items] = await sync(client, link, { prefer: true });
    expect(shared(items)).toEqual([[report, "True"]]);
    const after = await item(client, report);
    expect(after.parentReference.path).toBe("/drive/root:/Exec");
    expect(after.eTag).not.toBe(before.eTag);
    expect(after.cTag).toBe(before.cTag);
  });

  it("a moved folder's descendants appear only as sharing changes", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const reports = corpus.id("kestrel", "/Finance/Reports");
    const report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    const link = await latest(client);
    await control(client, "POST", `/${reports}/move`, { parent_id: corpus.id("kestrel", "/Exec") });
    let [items] = await sync(client, link);
    expect(ids(items)).toEqual([reports]);
    [items] = await sync(client, link, { prefer: true });
    expect(shared(items)).toEqual([
      [reports, "True"],
      [report, "True"],
    ]);
  });

  it("a move with the same effective sharing isn't a sharing change", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const note = corpus.id("kestrel", "/HR/Casework/case note.pdf"); // inherit: false
    const link = await latest(client);
    await control(client, "POST", `/${note}/move`, { parent_id: corpus.id("kestrel", "/HR") });
    const [items] = await sync(client, link, { prefer: true });
    expect(items.map((entry) => [entry.id, SHARED in entry])).toEqual([[note, false]]);
  });

  it("a rename appears once, with the latest name", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const reports = corpus.id("kestrel", "/Finance/Reports");
    const report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    const before = await item(client, reports);
    const link = await latest(client);
    await control(client, "POST", `/${reports}/rename`, { name: "Reports 2026" });
    await control(client, "POST", `/${reports}/rename`, { name: "Board reports" });
    const [items] = await sync(client, link);
    expect(items.map((entry) => [entry.id, entry.name])).toEqual([[reports, "Board reports"]]);
    expect(items[0]!.eTag).not.toBe(before.eTag);
    const child = await item(client, report);
    expect(child.parentReference.path).toBe("/drive/root:/Finance/Board%20reports");
  });

  it("a rename changes the eTag but not the cTag", async () => {
    const client = fw.client();
    const memo = fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    const before = await item(client, memo);
    await control(client, "POST", `/${memo}/rename`, { name: "Heron.pdf" });
    const after = await item(client, memo);
    expect(after.eTag).not.toBe(before.eTag);
    expect(after.cTag).toBe(before.cTag);
  });

  it("a new version changes both tags and the hash", async () => {
    const client = fw.client();
    const memo = fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    const before = await item(client, memo);
    const link = await latest(client);
    await control(client, "PUT", `/${memo}/content`, { content_base64: Buffer.from("version two").toString("base64") });
    const [items] = await sync(client, link);
    expect(ids(items)).toEqual([memo]);
    expect(items[0]!.size).toBe("version two".length);
    expect(items[0]!.file.mimeType).toBe("application/pdf");
    expect(items[0]!.file.hashes).not.toEqual(before.file.hashes);
    const after = await item(client, memo);
    expect(after.eTag).not.toBe(before.eTag);
    expect(after.cTag).not.toBe(before.cTag);
  });

  it("a folder delete cascades, children first", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const kestrel = (path: string) => corpus.id("kestrel", path);
    const link = await latest(client);
    await control(client, "DELETE", `/${kestrel("/HR")}`);
    const [items] = await sync(client, link);
    // Children first, so a folder is empty by the time its own delete arrives.
    expect(items).toStrictEqual([
      {
        id: kestrel("/HR/Casework/case note.pdf"),
        deleted: { state: "deleted" },
        parentReference: { id: kestrel("/HR/Casework") },
      },
      { id: kestrel("/HR/Casework"), deleted: { state: "deleted" }, parentReference: { id: kestrel("/HR") } },
      { id: kestrel("/HR"), deleted: { state: "deleted" }, parentReference: { id: kestrel("/") } },
    ]);
    for (const path of ["/HR", "/HR/Casework/case note.pdf"]) {
      expect((await client.get(`/v1.0/sites/kestrel/drive/items/${kestrel(path)}`)).status).toBe(404);
    }
    const root = await (await client.get("/v1.0/sites/kestrel/drive/root/children")).json();
    expect(root.value.map((child: Entry) => child.name)).toEqual(["Company", "Exec", "Finance"]);
    const [everything] = await sync(client, DELTA);
    expect(ids(everything)).not.toContain(kestrel("/HR"));
  });

  it("come in order of first change", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    const report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    const link = await latest(client);
    await control(client, "POST", `/${memo}/rename`, { name: "Heron.pdf" });
    await control(client, "POST", `/${report}/rename`, { name: "Q3.pdf" });
    await control(client, "POST", `/${memo}/rename`, { name: "Heron v2.pdf" });
    const [items] = await sync(client, link);
    expect(items.map((entry) => [entry.id, entry.name])).toEqual([
      [memo, "Heron v2.pdf"],
      [report, "Q3.pdf"],
    ]);
  });
});

describe("sharing changes", () => {
  it("need the Prefer header, and bump every inheriting eTag", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const finance = corpus.id("kestrel", "/Finance");
    const reports = corpus.id("kestrel", "/Finance/Reports");
    const report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    const plan = corpus.id("kestrel", "/Finance/FP&A/plan.md");
    const watched = [finance, reports, report, plan];
    const before = new Map(await Promise.all(watched.map(async (id) => [id, await item(client, id)] as const)));
    const link = await latest(client);
    const body = { inherit: true, grants: [groupGrant(corpus, "/Kestrel/Finance", "read")] };
    await control(client, "PUT", `/${finance}/sharing`, body);

    expect((await sync(client, link))[0]).toEqual([]);
    const [items] = await sync(client, link, { prefer: true });
    // The folder and everything that inherits from it; FP&A broke inheritance, so it's untouched.
    expect(shared(items)).toEqual([
      [finance, "True"],
      [reports, "True"],
      [report, "True"],
    ]);
    // Every item whose effective sharing changed gets a new eTag, so a connector that skips
    // unchanged eTags can't keep the revoked grant. Content is untouched, so cTags stay.
    const after = new Map(await Promise.all(watched.map(async (id) => [id, await item(client, id)] as const)));
    expect(watched.filter((id) => after.get(id)!.eTag !== before.get(id)!.eTag)).toEqual([finance, reports, report]);
    expect(after.get(report)!.cTag).toBe(before.get(report)!.cTag);
    const { value } = await item(client, report, "/permissions");
    expect(value.map((p: Entry) => p.grantedToV2.user?.id)).not.toContain(corpus.user("kestrel", "tom.whitfield"));
  });

  /** The same role from a nearer ancestor changes the permission's `inheritedFrom` and id. */
  it("include a grant moving to another ancestor", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const finance = corpus.id("kestrel", "/Finance");
    const reports = corpus.id("kestrel", "/Finance/Reports");
    const report = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    const tom = {
      principal_type: "user",
      principal_id: corpus.user("kestrel", "tom.whitfield"),
      principal_name: "tom.whitfield",
      role: "write",
    };
    const both = [groupGrant(corpus, "/Kestrel/Exec", "read"), groupGrant(corpus, "/Kestrel/Finance", "read")];
    await control(client, "PUT", `/${reports}/sharing`, { inherit: true, grants: both });
    const before = await item(client, report);
    const link = await latest(client);
    await control(client, "PUT", `/${finance}/sharing`, { inherit: true, grants: [tom] });
    const [items] = await sync(client, link, { prefer: true });
    expect(shared(items)).toEqual([
      [finance, "True"],
      [reports, "True"],
      [report, "True"],
    ]);
    expect((await item(client, report)).eTag).not.toBe(before.eTag);
    const { value } = await item(client, report, "/permissions");
    const sources = Object.fromEntries(
      value
        .filter((p: Entry) => p.grantedToV2.group)
        .map((p: Entry) => [p.grantedToV2.group.displayName, p.inheritedFrom.id]),
    );
    expect(sources["/Kestrel/Finance"]).toBe(reports);
  });

  it("show alongside a content change only with the Prefer header", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    const link = await latest(client);
    await control(client, "PUT", `/${memo}/content`, { content_base64: "eA==" });
    const body = { inherit: false, grants: [groupGrant(corpus, "/Kestrel/Exec", "read")] };
    await control(client, "PUT", `/${memo}/sharing`, body);
    let [items] = await sync(client, link);
    expect(items.map((entry) => [entry.id, SHARED in entry])).toEqual([[memo, false]]);
    [items] = await sync(client, link, { prefer: true });
    expect(shared(items)).toEqual([[memo, "True"]]);
  });
});

describe("tokens", () => {
  it("are 410 after a reset, with a Location to enumerate from", async () => {
    const client = fw.client();
    const link = await latest(client);
    expect((await client.post("/_control/reset")).status).toBe(200);
    const response = await client.get(link);
    expect(response.status).toBe(410);
    expect((await response.json()).error.code).toBe("resyncRequired");
    const fresh = response.headers.get("location")!;
    expect(fresh).not.toContain("token");
    const [items] = await sync(client, fresh);
    expect(items.length).toBeGreaterThan(0);
  });

  it("survive a restart only on the same corpus", async () => {
    const { corpus } = fw;
    const link = await latest(fw.client());
    expect((await fw.client().get(link)).status).toBe(200);
    const manifest = join(corpus.dir, "manifest.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8").replace("Tom Whitfield", "Tom W."));
    const restarted = fw.client();
    const stale = await restarted.get(link);
    expect(stale.status).toBe(410);
    expect((await stale.json()).error.innerError).toEqual({ code: "resyncChangesApplyDifferences" });
    const location = new URL(stale.headers.get("location")!);
    expect([location.host, location.pathname]).toEqual(["fw", DELTA]);
    expect(location.searchParams.has("token")).toBe(false);
    const [items] = await sync(restarted, location.href);
    expect(ids(items)).toEqual(corpus.paths("kestrel").map((path) => corpus.id("kestrel", path)));
  });

  /** Pins the clock, makes the renames, and returns the deltaLink that follows them. */
  async function history(client: Client, ...renames: [string, string][]): Promise<string> {
    await client.post("/_control/clock", { json: { now: "2026-10-01T12:00:00Z" } });
    const link = await latest(client);
    for (const [path, name] of renames) {
      await control(client, "POST", `/${fw.corpus.id("kestrel", path)}/rename`, { name });
    }
    return (await sync(client, link))[1];
  }

  /**
   * A restart starts the change log again. A token for a position the new log reaches by other
   * changes would skip them, so it's refused.
   */
  it.each([
    [
      "other items",
      [
        ["/Company/Bravo.md", "Bravo 2.md"],
        ["/Company/charlie.md", "charlie 2.md"],
      ],
    ],
    ["other names", [["/Company/alpha.md", "alpha 3.md"]]],
  ] as [string, [string, string][]][])("from another history (%s) are 410", async (_, restartedRenames) => {
    const after = await history(fw.client(), ["/Company/alpha.md", "alpha 2.md"]);
    const restarted = fw.client();
    await history(restarted, ...restartedRenames);
    const stale = await restarted.get(after);
    expect(stale.status, await stale.clone().text()).toBe(410);
    expect((await stale.json()).error.code).toBe("resyncRequired");
  });

  it("survive a restart that repeats the history", async () => {
    const renames: [string, string][] = [
      ["/Company/alpha.md", "alpha 2.md"],
      ["/Company/Bravo.md", "Bravo 2.md"],
    ];
    const after = await history(fw.client(), ...renames);
    const restarted = fw.client();
    expect(await history(restarted, ...renames)).toBe(after);
    expect(await sync(restarted, after)).toEqual([[], after]);
  });

  it.each(["not-a-token", "a2VzdHJlbA"])("malformed (%s) are 400", async (token) => {
    const response = await fw.client().get(`${DELTA}?token=${token}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalidRequest");
  });

  it("from another site are 400", async () => {
    const client = fw.client();
    const token = new URL(await latest(client)).searchParams.get("token");
    const harbour = { Authorization: "Bearer dev-workspace-harbour" };
    const response = await client.get(`/v1.0/sites/harbour/drive/root/delta?token=${token}`, { headers: harbour });
    expect(response.status).toBe(400);
  });
});

it("the same calls give the same ids, tags and tokens", async () => {
  const { corpus } = fw;
  const run = async (client: Client) => {
    await client.post("/_control/clock", { json: { now: "2026-10-01T12:00:00Z" } });
    const link = await latest(client);
    const body = {
      parent_id: corpus.id("kestrel", "/Exec"),
      name: "Heron board pack.pdf",
      content_base64: Buffer.from("pack").toString("base64"),
      mime_type: "application/pdf",
    };
    const created = await (await control(client, "POST", "", body)).json();
    await control(client, "POST", `/${corpus.id("kestrel", "/Finance/Reports")}/move`, {
      parent_id: corpus.id("kestrel", "/Exec"),
      name: "Reports",
    });
    const share = { inherit: true, grants: [groupGrant(corpus, "/Kestrel", "read")] };
    await control(client, "PUT", `/${corpus.id("kestrel", "/HR")}/sharing`, share);
    await control(client, "DELETE", `/${corpus.id("kestrel", "/Company/echo.md")}`);
    const page1 = await (await client.get(`${link}&$top=3`, { headers: PREFER })).json();
    const [items, final] = await sync(client, link, { prefer: true });
    const [full, fullLink] = await sync(client, `${DELTA}?$top=7`);
    return [created, page1, items, final, full, fullLink] as const;
  };

  const first = await run(fw.client());
  const second = await run(fw.client());
  expect(first).toEqual(second);
  expect(first[1]["@odata.nextLink"]).not.toBe(first[3]);
});
