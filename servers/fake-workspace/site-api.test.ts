// @vitest-environment node
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { sha256 } from "./site";
import { type Client, type Corpus, setupFakeWorkspace } from "./testing";

const SITE = "/v1.0/sites/kestrel/drive";

const fw = setupFakeWorkspace();

function itemUrl(itemId: string, suffix = ""): string {
  return `${SITE}/items/${itemId}${suffix}`;
}

async function json(response: Response | Promise<Response>): Promise<any> {
  return (await response).json();
}

describe("auth", () => {
  it.each([null, "nope"])("a missing or unknown token (%s) is 401", async (token) => {
    const response = await fw.client({ token }).get(`${SITE}/root`);
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe("InvalidAuthenticationToken");
  });

  it("a non-bearer scheme is 401", async () => {
    const headers = { Authorization: "Basic dev-workspace-kestrel" };
    expect((await fw.client().get(`${SITE}/root`, { headers })).status).toBe(401);
  });

  it.each([
    ["dev-workspace-harbour", `${SITE}/root`],
    ["dev-workspace-harbour", `${SITE}/root/delta`],
    ["dev-workspace-kestrel", "/v1.0/sites/harbour/drive/root"],
    ["dev-workspace-kestrel", "/v1.0/sites/nowhere/drive/root"],
  ])("%s on %s is 403", async (token, path) => {
    const response = await fw.client({ token }).get(path);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("accessDenied");
  });

  it("each token opens its own site", async () => {
    const harbour = fw.client({ token: "dev-workspace-harbour" });
    expect((await harbour.get("/v1.0/sites/harbour/drive/root")).status).toBe(200);
  });
});

describe("items", () => {
  it("serves the root", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const root = await json(client.get(`${SITE}/root`));
    expect(root.id).toBe(corpus.id("kestrel", "/"));
    expect(root.root).toEqual({});
    expect(root.folder).toEqual({ childCount: 4 });
    expect(root).not.toHaveProperty("parentReference");
    expect(root).not.toHaveProperty("cTag");
    // As in the real build, the tenant's first enabled admin made the root.
    const amara = { user: { id: corpus.user("kestrel", "amara.okafor"), displayName: "Amara Okafor" } };
    expect([root.createdBy, root.lastModifiedBy]).toEqual([amara, amara]);
    expect(await json(client.get(itemUrl("root")))).toEqual(root);
  });

  it("serves a file", async () => {
    const { corpus } = fw;
    const itemId = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    const item = await json(fw.client().get(itemUrl(itemId)));
    const content = corpus.content("kestrel", "/Finance/Reports/Q3 report.pdf");
    const tom = { user: { id: corpus.user("kestrel", "tom.whitfield"), displayName: "Tom Whitfield" } };
    expect(item).toStrictEqual({
      id: itemId,
      name: "Q3 report.pdf",
      eTag: `"{${itemId.toUpperCase()}},1"`,
      cTag: `"c:{${itemId.toUpperCase()}},1"`,
      createdDateTime: "2026-09-01T09:00:00Z",
      lastModifiedDateTime: "2026-09-02T10:30:00Z",
      size: content.length,
      createdBy: tom,
      lastModifiedBy: tom,
      parentReference: { id: corpus.id("kestrel", "/Finance/Reports"), path: "/drive/root:/Finance/Reports" },
      file: { mimeType: "application/pdf", hashes: { sha256Hash: sha256(content).toUpperCase() } },
    });
  });

  it("serves a folder", async () => {
    const { corpus } = fw;
    const folder = await json(fw.client().get(itemUrl(corpus.id("kestrel", "/Finance"))));
    const sizes = ["/Finance/Reports/Q3 report.pdf", "/Finance/FP&A/plan.md"].map(
      (path) => corpus.content("kestrel", path).length,
    );
    expect(folder.folder).toEqual({ childCount: 2 });
    expect(folder.size).toBe(sizes[0]! + sizes[1]!);
    expect(folder.parentReference).toEqual({ id: corpus.id("kestrel", "/"), path: "/drive/root:" });
    expect(folder).not.toHaveProperty("cTag");
    expect(folder).not.toHaveProperty("file");
  });

  it("percent-encodes paths", async () => {
    const plan = await json(fw.client().get(itemUrl(fw.corpus.id("kestrel", "/Finance/FP&A/plan.md"))));
    expect(plan.parentReference.path).toBe("/drive/root:/Finance/FP%26A");
  });

  it("is 404 for an unknown item", async () => {
    const response = await fw.client().get(itemUrl("no-such-item"));
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("itemNotFound");
  });
});

describe("children", () => {
  const names = (page: { value: { name: string }[] }) => page.value.map((child) => child.name);

  it("are paged and sorted case-insensitively", async () => {
    const client = fw.client();
    let url = itemUrl(fw.corpus.id("kestrel", "/Company"), "/children?$top=2");
    const pages: string[][] = [];
    for (;;) {
      const page = await json(client.get(url));
      pages.push(names(page));
      if (!page["@odata.nextLink"]) break;
      url = page["@odata.nextLink"];
      expect(url.startsWith("http://fw/v1.0/sites/kestrel/drive/items/")).toBe(true);
      expect(url).toContain("$top=2&$skiptoken=");
    }
    expect(pages).toEqual([["alpha.md", "Bravo.md"], ["charlie.md", "Delta.md"], ["echo.md"]]);
  });

  /**
   * Each page starts after the last child returned, so changes between pages can't skip a child
   * that was there from the start, or return one twice. Children added behind the cursor aren't
   * returned: a crawl takes a delta token first to catch those.
   */
  it("paging survives changes between pages", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const company = corpus.id("kestrel", "/Company");
    const add = async (name: string) => {
      const body = { parent_id: company, name, content_base64: "", mime_type: "text/plain" };
      expect((await client.post("/_control/sites/kestrel/items", { json: body })).status).toBe(201);
    };
    const remove = async (name: string) => {
      const url = `/_control/sites/kestrel/items/${corpus.id("kestrel", `/Company/${name}`)}`;
      expect((await client.delete(url)).status).toBe(204);
    };
    const page = async (url: string): Promise<[string[], string | undefined]> => {
      const body = await json(client.get(url));
      return [names(body), body["@odata.nextLink"]];
    };

    const [first, toSecond] = await page(itemUrl(company, "/children?$top=2"));
    expect(first).toEqual(["alpha.md", "Bravo.md"]);
    await remove("alpha.md"); // behind the cursor: an offset would now skip charlie.md
    await add("aardvark.md");
    await add("Able.md"); // two more in front: an offset would repeat Bravo.md
    const [second, toThird] = await page(toSecond!);
    expect(second).toEqual(["charlie.md", "Delta.md"]);
    await remove("charlie.md");
    await add("Beta.md"); // behind the cursor again
    await add("foxtrot.md"); // ahead of it: returned
    expect(await page(toThird!)).toEqual([["echo.md", "foxtrot.md"], undefined]);
  });

  /**
   * Keyset paging returns an item again when a rename moves it past the cursor, as Graph may: a
   * crawl dedupes by id, keeping the latest copy.
   */
  it("a child renamed ahead of the cursor comes back", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const alpha = corpus.id("kestrel", "/Company/alpha.md");
    let body = await json(client.get(itemUrl(corpus.id("kestrel", "/Company"), "/children?$top=2")));
    expect(names(body)).toEqual(["alpha.md", "Bravo.md"]);
    const rename = `/_control/sites/kestrel/items/${alpha}/rename`;
    expect((await client.post(rename, { json: { name: "zulu.md" } })).status).toBe(200);
    const seen: { id: string; name: string }[] = [...body.value];
    while (body["@odata.nextLink"]) {
      body = await json(client.get(body["@odata.nextLink"]));
      seen.push(...body.value);
    }
    expect(seen.filter((child) => child.id === alpha)).toHaveLength(2);
    const latest = new Map(seen.map((child) => [child.id, child.name]));
    expect([...latest.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))).toEqual([
      "Bravo.md",
      "charlie.md",
      "Delta.md",
      "echo.md",
      "zulu.md",
    ]);
  });

  it("default to one page and accept the root alias", async () => {
    const client = fw.client();
    const byAlias = await json(client.get(`${SITE}/root/children`));
    const byId = await json(client.get(itemUrl(fw.corpus.id("kestrel", "/"), "/children")));
    expect(byAlias).toEqual(byId);
    expect(names(byAlias)).toEqual(["Company", "Exec", "Finance", "HR"]);
    expect(byAlias).not.toHaveProperty("@odata.nextLink");
  });

  it("cap $top at 200", async () => {
    const client = fw.client();
    const parent = fw.corpus.id("kestrel", "/Company");
    for (let n = 0; n < 201; n++) {
      const body = {
        parent_id: parent,
        name: `bulk-${String(n).padStart(3, "0")}.md`,
        content_base64: "eA==",
        mime_type: "text/markdown",
      };
      expect((await client.post("/_control/sites/kestrel/items", { json: body })).status).toBe(201);
    }
    const page = await json(client.get(itemUrl(parent, "/children?$top=500")));
    expect(page.value).toHaveLength(200);
    expect(page).toHaveProperty("@odata.nextLink");
  });

  it.each(["$top=0", "$top=x", "$skiptoken=garbage", "$skiptoken=WzFd", "$skiptoken=WzEsMl0"])(
    "bad paging (%s) is 400",
    async (query) => {
      const response = await fw.client().get(`${SITE}/root/children?${query}`);
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("invalidRequest");
    },
  );
});

describe("content", () => {
  it("matches its hash", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const path = "/Exec/Project Heron memo.pdf";
    const response = await client.get(itemUrl(corpus.id("kestrel", path), "/content"));
    const item = await json(client.get(itemUrl(corpus.id("kestrel", path))));
    expect(response.status).toBe(200);
    const content = Buffer.from(await response.arrayBuffer());
    expect(content).toEqual(corpus.content("kestrel", path));
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(sha256(content).toUpperCase()).toBe(item.file.hashes.sha256Hash);
    expect(content.length).toBe(item.size);
  });

  it("serves an uploaded version", async () => {
    const client = fw.client();
    const itemId = fw.corpus.id("kestrel", "/Company/alpha.md");
    const body = { content_base64: Buffer.from("# new").toString("base64"), mime_type: "text/plain" };
    await client.put(`/_control/sites/kestrel/items/${itemId}/content`, { json: body });
    const response = await client.get(itemUrl(itemId, "/content"));
    expect(await response.text()).toBe("# new");
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("isn't there for a folder", async () => {
    expect((await fw.client().get(`${SITE}/root/content`)).status).toBe(400);
  });
});

describe("permissions", () => {
  const DISPLAY: Record<string, string> = { "tom.whitfield": "Tom Whitfield", "marco.bianchi": "Marco Bianchi" };

  function grant(corpus: Corpus, kind: "user" | "group", name: string, role: string, inheritedFrom?: string) {
    const identity =
      kind === "user"
        ? { user: { id: corpus.user("kestrel", name), displayName: DISPLAY[name] } }
        : { group: { id: corpus.group("kestrel", name), displayName: name } };
    const permission: Record<string, unknown> = { roles: [role], grantedToV2: identity };
    if (inheritedFrom !== undefined) {
      const path = "/drive/root:" + inheritedFrom.replaceAll(" ", "%20");
      permission.inheritedFrom = { id: corpus.id("kestrel", inheritedFrom), path };
    }
    return permission;
  }

  async function permissions(client: Client, itemId: string): Promise<Record<string, unknown>[]> {
    const response = await client.get(itemUrl(itemId, "/permissions"));
    expect(response.status).toBe(200);
    const { value } = await response.json();
    for (const { id } of value) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    return value.map(({ id: _, ...rest }: Record<string, unknown>) => rest);
  }

  it("inherited ones name their source", async () => {
    const { corpus } = fw;
    const item = corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
    expect(await permissions(fw.client(), item)).toEqual([
      grant(corpus, "group", "/Kestrel/Finance", "read", "/Finance"),
      grant(corpus, "user", "tom.whitfield", "write", "/Finance"),
      grant(corpus, "group", "/Kestrel/Exec", "read", "/Finance/Reports"),
    ]);
  });

  it("own ones have no source", async () => {
    const { corpus } = fw;
    const folder = corpus.id("kestrel", "/Finance/Reports");
    expect(await permissions(fw.client(), folder)).toEqual([
      grant(corpus, "group", "/Kestrel/Finance", "read", "/Finance"),
      grant(corpus, "user", "tom.whitfield", "write", "/Finance"),
      grant(corpus, "group", "/Kestrel/Exec", "read"),
    ]);
  });

  it("broken inheritance keeps only own grants", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const note = corpus.id("kestrel", "/HR/Casework/case note.pdf");
    expect(await permissions(client, note)).toEqual([grant(corpus, "user", "marco.bianchi", "read")]);
    const plan = corpus.id("kestrel", "/Finance/FP&A/plan.md");
    const expected = grant(corpus, "group", "/Kestrel/Finance/FP&A", "write");
    expected.inheritedFrom = { id: corpus.id("kestrel", "/Finance/FP&A"), path: "/drive/root:/Finance/FP%26A" };
    expect(await permissions(client, plan)).toEqual([expected]);
  });

  it("the root shares nothing", async () => {
    expect(await permissions(fw.client(), "root")).toEqual([]);
  });

  it("ids are stable down the tree", async () => {
    const client = fw.client();
    const ids = async (path: string) => {
      const { value } = await json(client.get(itemUrl(fw.corpus.id("kestrel", path), "/permissions")));
      return value.map((p: { id: string }) => p.id);
    };
    expect((await ids("/Finance/Reports")).slice(0, 2)).toEqual(await ids("/Finance"));
  });

  it("the stronger role wins", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const memo = corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    const weaker = {
      principal_type: "group",
      principal_id: corpus.group("kestrel", "/Kestrel/Exec"),
      principal_name: "/Kestrel/Exec",
      role: "read",
    };
    const body = { inherit: true, grants: [weaker] };
    expect((await client.put(`/_control/sites/kestrel/items/${memo}/sharing`, { json: body })).ok).toBe(true);
    expect(await permissions(client, memo)).toEqual([grant(corpus, "group", "/Kestrel/Exec", "write", "/Exec")]);
  });
});

describe("without a corpus", () => {
  it("the site API is 503 and health says so", async () => {
    const client = fw.client({ corpusDir: join(fw.tmp, "missing") });
    for (const response of [
      await client.get(`${SITE}/root`),
      await client.get(`${SITE}/root/delta`),
      await client.post("/v1.0/subscriptions", { json: {} }),
      await client.get("/v1.0/sites/kestrel/users"),
    ]) {
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("serviceNotReady");
    }
    const health = await client.get("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", service: "fake-workspace", corpus_loaded: false });
  });

  it("health says when it loaded", async () => {
    expect(await json(fw.client().get("/health"))).toEqual({
      status: "ok",
      service: "fake-workspace",
      corpus_loaded: true,
    });
  });
});
