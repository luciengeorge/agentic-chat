// @vitest-environment node
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { SourceFile } from "#learn/connectors/types";

import { createGraphClient, type Permission, itemPath } from "#learn/connectors/graph";
import { grantedIds, graphConnector, toSourceFile } from "#learn/connectors/graph-connector";
import { KESTREL_TOKEN, REAL_BASE_URL, setupRealWorkspace } from "@/core/connectors/testing";
import { loadWorld } from "@/fixtures/world";

const workspace = setupRealWorkspace();
const world = loadWorld();
const TOM = world.userId("kestrel", "tom.whitfield");
const MARCO = world.userId("kestrel", "marco.bianchi");
const EXEC = world.groupId("kestrel", "/Kestrel/Exec");

function start() {
  const fw = workspace.start();
  const graph = createGraphClient({ baseUrl: REAL_BASE_URL, site: "kestrel", token: KESTREL_TOKEN, fetch: fw.fetch });
  return { fw, graph, source: graphConnector(graph) };
}

const BOARD_MEMO = "/Exec/Project Heron Board Memo.pdf";
const PLAN = "/Exec/Project Heron Integration Plan v0.4.docx";

describe("Graph as a Connector", () => {
  it("turns a drive item into a SourceFile: its id, name, path, MIME type and eTag", async () => {
    const { fw, graph } = start();
    const item = await graph.item(fw.id(BOARD_MEMO));
    expect(toSourceFile(item, itemPath(item)), "the version is the eTag: it changes on any change").toEqual({
      id: fw.id(BOARD_MEMO),
      name: "Project Heron Board Memo.pdf",
      path: BOARD_MEMO,
      mimeType: "application/pdf",
      version: item.eTag,
      contentHash: expect.any(String),
    });
  });

  it("gives the content hash in lower-case hex: the sha256 of the bytes the source serves", async () => {
    const { fw, graph, source } = start();
    const item = await graph.item(fw.id(BOARD_MEMO));
    const { bytes } = await source.content(item.id);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(toSourceFile(item, BOARD_MEMO).contentHash, "Graph writes it in upper case: sha256Of lowers it").toBe(
      sha256,
    );
  });

  it("refuses a folder: it isn't a document", async () => {
    const { fw, graph } = start();
    const folder = await graph.item(fw.id("/Exec"));
    expect(() => toSourceFile(folder, "/Exec"), "a folder has no `file` facet: throw").toThrow();
  });

  it("gives a renamed file a new path and version, and the same id and hash", async () => {
    const { fw, graph } = start();
    const before = toSourceFile(await graph.item(fw.id(PLAN)), PLAN);
    await fw.control("POST", `/sites/kestrel/items/${fw.id(PLAN)}/rename`, {
      name: "Project Heron Integration Plan v0.5.docx",
    });
    const item = await graph.item(fw.id(PLAN));
    const after = toSourceFile(item, itemPath(item));
    expect(after.path).toBe("/Exec/Project Heron Integration Plan v0.5.docx");
    expect(after.version, "a rename is a change, so the version moves on: the eTag, not the cTag").not.toBe(
      before.version,
    );
    expect(after.id).toBe(before.id);
    expect(after.contentHash, "same bytes, same hash: nothing to ingest again").toBe(before.contentHash);
  });

  it("names everyone a file's permissions grant: own and inherited, read and write", async () => {
    const { fw, graph } = start();
    const permissions = await graph.permissions(fw.id(PLAN));
    expect(permissions.map((p) => [p.roles[0], p.inheritedFrom ? "inherited" : "own"])).toEqual([
      ["write", "inherited"],
      ["read", "own"],
    ]);
    expect(
      grantedIds(permissions),
      "the Exec group's write is inherited from /Exec; Tom's read is the file's own",
    ).toEqual([EXEC, TOM].sort());
  });

  it("names each one once, sorted, and nobody for a sharing link", () => {
    const grant = (id: string, kind: "user" | "group", role = "read"): Permission => ({
      id: `p-${id}-${role}`,
      roles: [role],
      grantedToV2: kind === "user" ? { user: { id } } : { group: { id, displayName: "Exec" } },
    });
    const link: Permission = { id: "link", roles: ["read"], grantedToV2: {} };
    expect(grantedIds([grant(TOM, "user"), grant(EXEC, "group", "write"), grant(TOM, "user", "write"), link])).toEqual(
      [EXEC, TOM].sort(),
    );
    expect(grantedIds([link]), "a link names nobody the app can check").toEqual([]);
  });

  it("crawls Kestrel's drive into 40 source files, and the board memo is the Exec group's alone", async () => {
    const { fw, source } = start();
    const files: SourceFile[] = [];
    for await (const page of source.crawl()) files.push(...page);
    expect(files).toHaveLength(40);
    expect(files.map((f) => f.path).sort()).toEqual(fw.files());
    expect(files.every((f) => /^[0-9a-f]{64}$/.test(f.contentHash))).toBe(true);

    expect(await source.permissions(fw.id(BOARD_MEMO))).toEqual([EXEC]);
    expect(await source.permissions(fw.id(PLAN))).toEqual([EXEC, TOM].sort());
    // Inheritance broken on the case note: only Marco, HR's manager, may read it.
    expect(await source.permissions(fw.id("/HR/Casework/HR-CASE-2026-014 Grievance Meeting Note.pdf"))).toEqual([
      MARCO,
    ]);
  });
});
