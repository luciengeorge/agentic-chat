// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type Client, setupFakeWorkspace } from "./testing";

const fw = setupFakeWorkspace();

type Entry = Record<string, any>;

async function members(client: Client, group: string, kind: "members" | "transitiveMembers" = "members") {
  const response = await client.get(`/v1.0/sites/kestrel/groups/${fw.corpus.group("kestrel", group)}/${kind}?$top=200`);
  expect(response.status).toBe(200);
  return ((await response.json()).value as Entry[]).map((entry) => entry.displayName).sort();
}

const path = (group: string, member?: string) =>
  `/_control/sites/kestrel/groups/${fw.corpus.group("kestrel", group)}/members${member ? `/${member}` : ""}`;

describe("the control API's group membership", () => {
  it("removes a user from a group, in members and in every ancestor's transitiveMembers", async () => {
    const client = fw.client();
    const leo = fw.corpus.user("kestrel", "leo.martin");
    expect(await members(client, "/Kestrel/Finance/AP")).toEqual(["Leo Martin"]);
    expect(await members(client, "/Kestrel/Finance", "transitiveMembers")).toContain("Leo Martin");

    expect((await client.delete(path("/Kestrel/Finance/AP", leo))).status).toBe(204);

    expect(await members(client, "/Kestrel/Finance/AP")).toEqual([]);
    expect(await members(client, "/Kestrel/Finance", "transitiveMembers")).not.toContain("Leo Martin");
    expect(await members(client, "/Kestrel", "transitiveMembers")).not.toContain("Leo Martin");
  });

  it("adds a user back, and refuses one who is already a member", async () => {
    const client = fw.client();
    const leo = fw.corpus.user("kestrel", "leo.martin");
    expect((await client.post(path("/Kestrel/Exec"), { json: { member_id: leo } })).status).toBe(201);
    expect(await members(client, "/Kestrel/Exec")).toContain("Leo Martin");
    const again = await client.post(path("/Kestrel/Exec"), { json: { member_id: leo } });
    expect(again.status).toBe(409);
  });

  it("answers 404 for a user who isn't a member, and 400 for a subgroup, which follows its path", async () => {
    const client = fw.client();
    const marco = fw.corpus.user("kestrel", "marco.bianchi");
    expect((await client.delete(path("/Kestrel/Exec", marco))).status).toBe(404);
    const ap = fw.corpus.group("kestrel", "/Kestrel/Finance/AP");
    expect((await client.delete(path("/Kestrel/Finance", ap))).status).toBe(400);
  });

  it("is undone by a reset, and shows up in neither delta nor notifications", async () => {
    const client = fw.client();
    const leo = fw.corpus.user("kestrel", "leo.martin");
    const latest = await (await client.get("/v1.0/sites/kestrel/drive/root/delta?token=latest")).json();
    await client.delete(path("/Kestrel/Finance/AP", leo));
    const delta = await (await client.get(latest["@odata.deltaLink"])).json();
    expect(delta.value).toEqual([]);
    expect((await (await client.get("/_control/deliveries")).json()).value).toEqual([]);

    expect((await client.post("/_control/reset")).status).toBe(200);
    expect(await members(client, "/Kestrel/Finance/AP")).toEqual(["Leo Martin"]);
  });

  it("goes through the control API's gate", async () => {
    const leo = fw.corpus.user("kestrel", "leo.martin");
    expect((await fw.client({ sendControl: false }).delete(path("/Kestrel/Finance/AP", leo))).status).toBe(403);
    expect((await fw.client({ env: "test" }).delete(path("/Kestrel/Finance/AP", leo))).status).toBe(403);
    const fromAfar = await fw.client().delete(path("/Kestrel/Finance/AP", leo), {
      headers: { origin: "https://evil.example" },
    });
    expect(fromAfar.status).toBe(403);
  });
});
