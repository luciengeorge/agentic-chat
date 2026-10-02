// @vitest-environment node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { type Client, buildCorpus, setupFakeWorkspace } from "./testing";

const CONTROL = "/_control/sites/kestrel/items";
const SITE = "/v1.0/sites/kestrel/drive";
const NEW_FILE = { parent_id: "root", name: "x", content_base64: "", mime_type: "text/plain" };
const STRANGER = { principal_type: "user", principal_id: "x", principal_name: "x", role: "read" };

const fw = setupFakeWorkspace();

/** Every item, its children and its permissions, walked from the root. */
async function snapshot(client: Client): Promise<unknown[]> {
  const seen: unknown[] = [];
  const queue = ["root"];
  while (queue.length) {
    const itemId = queue.shift()!;
    const item = await (await client.get(`${SITE}/items/${itemId}`)).json();
    const children = await (await client.get(`${SITE}/items/${itemId}/children?$top=200`)).json();
    const permissions = await (await client.get(`${SITE}/items/${itemId}/permissions`)).json();
    seen.push([item, permissions]);
    queue.push(...children.value.map((child: { id: string }) => child.id));
  }
  return seen;
}

function group(groupId: string, name: string) {
  return {
    inherit: true,
    grants: [{ principal_type: "group", principal_id: groupId, principal_name: name, role: "read" }],
  };
}

/** Replaces `before` in the manifest, which must contain it. */
function editManifest(dir: string, before: string, after: string): void {
  const manifest = join(dir, "manifest.json");
  const text = readFileSync(manifest, "utf8");
  expect(text).toContain(before);
  writeFileSync(manifest, text.replace(before, after));
}

it("the control API is dev only", async () => {
  const client = fw.client({ env: "test" });
  for (const [method, path] of [
    ["POST", "/_control/reset"],
    ["GET", "/_control/deliveries"],
  ] as const) {
    const response = await client.request(method, path);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("accessDenied");
  }
  expect((await client.get(`${SITE}/root`)).status).toBe(200);
});

describe("reset", () => {
  it("restores the manifest and clears the rest", async () => {
    const client = fw.client();
    const receiver = await fw.receiver();
    const before = await snapshot(client);
    await client.post("/_control/clock", { json: { now: "2026-10-01T12:00:00Z" } });
    const subscription = {
      changeType: "updated",
      notificationUrl: receiver.url,
      resource: "sites/kestrel/drive/root",
      expirationDateTime: "2026-10-02T12:00:00Z",
      clientState: "s",
    };
    expect((await client.post("/v1.0/subscriptions", { json: subscription })).status).toBe(201);
    const memo = fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    await client.post(`${CONTROL}/${memo}/rename`, { json: { name: "Heron.pdf" } });
    await client.delete(`${CONTROL}/${fw.corpus.id("kestrel", "/HR")}`);
    const created = await (await client.post(CONTROL, { json: { ...NEW_FILE, name: "x.md" } })).json();
    await client.post("/_control/faults", { json: { kind: "throttle", after_requests: 100 } });
    await client.post("/_control/flush");
    expect((await (await client.get("/_control/deliveries")).json()).value).not.toEqual([]);

    const response = await client.post("/_control/reset");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ corpus_loaded: true, sites: { harbour: 3, kestrel: 17 } });
    expect(await snapshot(client)).toEqual(before);
    expect((await client.get(`${SITE}/items/${created.id}`)).status).toBe(404);
    expect((await (await client.get("/_control/deliveries")).json()).value).toEqual([]);
    await client.post(`${CONTROL}/${memo}/rename`, { json: { name: "Heron.pdf" } });
    await client.post("/_control/flush");
    expect((await (await client.get("/_control/deliveries")).json()).value).toEqual([]);
    for (let i = 0; i < 3; i++) expect((await client.get(`${SITE}/root`)).status).toBe(200);
    // The clock is unpinned again: new timestamps come from the real clock.
    const renamed = await (await client.get(`${SITE}/items/${memo}`)).json();
    expect(renamed.lastModifiedDateTime).not.toMatch(/^2026-10-01T12:00/);
  });

  it("loads a corpus built after start", async () => {
    const later = join(fw.tmp, "later");
    const client = fw.client({ corpusDir: later });
    expect((await client.get(`${SITE}/root`)).status).toBe(503);
    const failed = await client.post("/_control/reset");
    expect(failed.status).toBe(503);
    expect((await failed.json()).error.message).toContain("manifest.json");
    buildCorpus(later);
    expect((await client.post("/_control/reset")).status).toBe(200);
    expect((await client.get(`${SITE}/root`)).status).toBe(200);
    expect((await (await client.get("/health")).json()).corpus_loaded).toBe(true);
  });

  it("reports a broken manifest", async () => {
    editManifest(fw.corpus.dir, '"parent_id": null', '"parent_id": "nope"');
    const response = await fw.client().post("/_control/reset");
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("serviceNotReady");
  });

  it.each([
    // A grant to a group the site doesn't list.
    ["an unknown group", '"path": "/Kestrel/HR"', '"path": "/Kestrel/People"', "/Kestrel/HR"],
    // No groups at all: the manifest's schema requires them.
    ["no groups", '"groups": {', '"teams": {', "groups"],
    // The directory comes from the world, so the two must name the same users.
    ["a user the world doesn't have", '"username": "leo.martin"', '"username": "leo.marten"', "world.yaml"],
  ])("refuses a manifest with %s", async (_, before, after, problem) => {
    editManifest(fw.corpus.dir, before, after);
    const client = fw.client();
    expect((await (await client.get("/health")).json()).corpus_loaded).toBe(false);
    const response = await client.post("/_control/reset");
    expect(response.status).toBe(503);
    expect((await response.json()).error.message).toContain(problem);
  });
});

it("the clock pins timestamps", async () => {
  const client = fw.client();
  const pinned = await client.post("/_control/clock", { json: { now: "2026-10-01T12:00:00+01:00" } });
  expect(await pinned.json()).toEqual({ now: "2026-10-01T11:00:00Z", pinned: true });
  const created = await (await client.post(CONTROL, { json: { ...NEW_FILE, name: "x.md" } })).json();
  expect(created.createdDateTime).toBe("2026-10-01T11:00:00Z");
  expect(created.lastModifiedDateTime).toBe("2026-10-01T11:00:00Z");
  expect(Object.keys(created.createdBy)).toEqual(["application"]);
  const unpinned = await (await client.post("/_control/clock", { json: { now: null } })).json();
  expect(unpinned.pinned).toBe(false);
  expect(unpinned.now).not.toBe("2026-10-01T11:00:00Z");
});

describe("mutations", () => {
  it("create a file", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const body = {
      parent_id: corpus.id("kestrel", "/Company"),
      name: "Rota.md",
      content_base64: Buffer.from("# rota").toString("base64"),
      mime_type: "text/markdown",
    };
    const response = await client.post(CONTROL, { json: body });
    expect(response.status).toBe(201);
    const item = await response.json();
    expect(item.file.mimeType).toBe("text/markdown");
    expect(item.parentReference).toEqual({ id: corpus.id("kestrel", "/Company"), path: "/drive/root:/Company" });
    expect(await (await client.get(`${SITE}/items/${item.id}/content`)).text()).toBe("# rota");
    const permissions = (await (await client.get(`${SITE}/items/${item.id}/permissions`)).json()).value;
    expect(permissions.map((p: { inheritedFrom: { id: string } }) => p.inheritedFrom.id)).toEqual([
      corpus.id("kestrel", "/Company"),
    ]);
  });

  it("accept a grant to one of the site's groups", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const hr = corpus.id("kestrel", "/HR");
    const body = group(corpus.group("kestrel", "/Kestrel/Exec"), "/Kestrel/Exec");
    expect((await client.put(`${CONTROL}/${hr}/sharing`, { json: body })).status).toBe(200);
    const permissions = (await (await client.get(`${SITE}/items/${hr}/permissions`)).json()).value;
    expect(
      permissions.map((p: { grantedToV2: { group: { displayName: string } } }) => p.grantedToV2.group.displayName),
    ).toEqual(["/Kestrel/Exec"]);
  });

  it.each([
    ["POST", "/{note}/move", { parent_id: "{casework}/x" }, 404, "itemNotFound"],
    ["POST", "/{hr}/move", { parent_id: "{casework}" }, 400, "invalidRequest"],
    ["POST", "/{hr}/move", { parent_id: "{note}" }, 400, "invalidRequest"],
    ["POST", "/{note}/move", { parent_id: "{casework}", name: "a/b" }, 400, "invalidRequest"],
    ["POST", "/{hr}/rename", { name: "COMPANY" }, 409, "nameAlreadyExists"],
    ["POST", "/root/rename", { name: "x" }, 400, "invalidRequest"],
    ["POST", "/root/move", { parent_id: "{hr}" }, 400, "invalidRequest"],
    ["DELETE", "/root", undefined, 400, "invalidRequest"],
    ["DELETE", "/nope", undefined, 404, "itemNotFound"],
    ["PUT", "/{hr}/content", { content_base64: "eA==" }, 400, "invalidRequest"],
    ["PUT", "/{note}/content", { content_base64: "%%%" }, 400, "invalidRequest"],
    ["POST", "", { ...NEW_FILE, parent_id: "{note}" }, 400, "invalidRequest"],
    ["POST", "", { ...NEW_FILE, name: "hr" }, 409, "nameAlreadyExists"],
    ["PUT", "/{hr}/sharing", { inherit: true, grants: [STRANGER] }, 400, "invalidRequest"],
    ["PUT", "/{hr}/sharing", group("nope", "/Kestrel/HR"), 400, "invalidRequest"],
    // Harbour's group, id and name both right, on a Kestrel item.
    ["PUT", "/{hr}/sharing", group("{harbour}", "/Harbour"), 400, "invalidRequest"],
    // A Kestrel group's id under another group's name.
    ["PUT", "/{hr}/sharing", group("{exec}", "/Kestrel/HR"), 400, "invalidRequest"],
  ])("%s %s with %j is %i", async (method, path, body, status, code) => {
    const { corpus } = fw;
    const ids: Record<string, string> = {
      hr: corpus.id("kestrel", "/HR"),
      casework: corpus.id("kestrel", "/HR/Casework"),
      note: corpus.id("kestrel", "/HR/Casework/case note.pdf"),
      exec: corpus.group("kestrel", "/Kestrel/Exec"),
      harbour: corpus.group("harbour", "/Harbour"),
    };
    const fill = (value: unknown): unknown => {
      if (typeof value === "string") return value.replace(/\{(\w+)\}/g, (_, name: string) => ids[name]!);
      if (Array.isArray(value)) return value.map(fill);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v)]));
      return value;
    };
    const response = await fw.client().request(method, CONTROL + fill(path), { json: fill(body) });
    expect(response.status, await response.clone().text()).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it("are 404 on an unknown site", async () => {
    expect((await fw.client().delete("/_control/sites/nowhere/items/root")).status).toBe(404);
  });
});
