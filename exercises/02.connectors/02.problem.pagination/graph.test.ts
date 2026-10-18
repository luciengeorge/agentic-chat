// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type CrawledFile, createGraphClient } from "#learn/connectors/graph";
import { KESTREL_TOKEN, REAL_BASE_URL, setupRealWorkspace } from "@/core/connectors/testing";

const workspace = setupRealWorkspace();

/** A client on the real Kestrel drive that logs each request and the nextLink its answer carried. */
function start(pageSize: number) {
  const fw = workspace.start();
  const log: Array<{ url: string; nextLink: string | undefined }> = [];
  const graph = createGraphClient({
    baseUrl: REAL_BASE_URL,
    site: "kestrel",
    token: KESTREL_TOKEN,
    pageSize,
    fetch: async (url, init) => {
      if (log.length >= 500) throw new Error("500 requests: is the crawl following the same link again and again?");
      const response = await fw.fetch(url, init);
      const body = (await response.clone().json()) as { "@odata.nextLink"?: string };
      log.push({ url, nextLink: body["@odata.nextLink"] });
      return response;
    },
  });
  return { fw, graph, log };
}

async function crawl(graph: ReturnType<typeof createGraphClient>) {
  const pages: CrawledFile[][] = [];
  for await (const page of graph.crawlPages()) pages.push(page);
  return pages;
}

describe("a full crawl, a page at a time", () => {
  it("reads a listing to its last page: the root's 7 folders at $top=5 come in two", async () => {
    const { graph, log } = start(5);
    const children = await graph.children("root");
    expect(children.map((c) => c.name)).toEqual(["Company", "Engineering", "Exec", "Finance", "HR", "Legal", "Sales"]);
    expect(log, "one request per page: the first, then its nextLink").toHaveLength(2);
    expect(log[1].url, "request the nextLink exactly as Graph gave it").toBe(log[0].nextLink);
    expect(log[1].nextLink, "the last page has no nextLink: that's where it stops").toBeUndefined();
  });

  it("requests every link as given, and nothing after a page without one", async () => {
    const { graph, log } = start(2);
    await crawl(graph);
    const links = new Set(log.flatMap((entry) => (entry.nextLink ? [entry.nextLink] : [])));
    const followed = log.filter((entry) => links.has(entry.url));
    expect(followed.length, "every nextLink was requested once").toBe(links.size);
    const firsts = log.filter((entry) => !links.has(entry.url));
    expect(
      firsts.every((entry) => entry.url.endsWith("/children?$top=2")),
      "every other request is a folder's first page",
    ).toBe(true);
    expect(firsts, "one first page per folder: 18").toHaveLength(18);
  });

  it("finds every one of the 40 files once, from every folder, whatever the page size", async () => {
    for (const size of [1, 2, 5, 100]) {
      const { fw, graph } = start(size);
      const files = (await crawl(graph)).flat();
      expect(files.map((f) => f.path).sort(), `at $top=${size}`).toEqual(fw.files());
      expect(new Set(files.map((f) => f.item.id)).size).toBe(40);
    }
  });

  it("never yields an empty page, nor a folder", async () => {
    const { graph } = start(5);
    const pages = await crawl(graph);
    expect(
      pages.every((page) => page.length > 0),
      "a page of only folders yields nothing",
    ).toBe(true);
    expect(pages.flat().every((f) => f.item.file !== undefined)).toBe(true);
  });

  it("keeps a file once when a rename during the crawl hands it back a second time", async () => {
    const { fw, graph } = start(2);
    const calendar = fw.id("/Company/2026 Holiday Calendar.pdf");
    const ids: string[] = [];
    for await (const page of graph.crawlPages()) {
      ids.push(...page.map((f) => f.item.id));
      if (page.some((f) => f.item.id === calendar)) {
        // Renamed past the bookmark: /Company's last page lists it again.
        await fw.control("POST", `/sites/kestrel/items/${calendar}/rename`, { name: "zz Holiday Calendar 2026.pdf" });
      }
    }
    expect(
      ids.filter((id) => id === calendar),
      "remember the ids you've seen",
    ).toHaveLength(1);
    expect(ids).toHaveLength(40);
  });

  it("crawls Kestrel at $top=5 in 20 requests: 18 folders, two of them on two pages", async () => {
    const { graph, log } = start(5);
    const pages = await crawl(graph);
    expect(log).toHaveLength(20);
    expect(pages.flat()).toHaveLength(40);
    expect(pages, "one page of files per listing page that holds any: the root's two hold only folders").toHaveLength(
      18,
    );
    // Read only each listing's first page and Legal and Sales (on the root's second page) never get
    // listed, nor /Company's sixth file: 28 of the 40.
  });
});
