// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadWorld } from "@/fixtures/world";

import { DEFAULT_CORPUS_DIR, createApp } from "./app";
import { type Client, setupFakeWorkspace } from "./testing";

const DIRECTORY = "/v1.0/sites/kestrel";

type Entry = Record<string, any>;

const fw = setupFakeWorkspace();

/** Every entry of a listing, following nextLinks, and the size of each page. */
async function listAll(client: Client, url: string): Promise<[Entry[], number[]]> {
  const entries: Entry[] = [];
  const sizes: number[] = [];
  for (let next: string | undefined = url; next;) {
    const response = await client.get(next);
    expect(response.status, await response.clone().text()).toBe(200);
    const page = await response.json();
    entries.push(...page.value);
    sizes.push(page.value.length);
    next = page["@odata.nextLink"];
  }
  return [entries, sizes];
}

const names = (entries: Entry[]) => entries.map((entry) => entry.displayName);

describe("users", () => {
  it("are listed by display name, the disabled ones too", async () => {
    const { corpus } = fw;
    const [users] = await listAll(fw.client(), `${DIRECTORY}/users`);
    expect(names(users)).toEqual([
      "Amara Okafor",
      "Daniel Reyes",
      "Leo Martin",
      "Marco Bianchi",
      "Peter Hall",
      "Tom Whitfield",
    ]);
    expect(users[0]).toStrictEqual({
      id: corpus.user("kestrel", "amara.okafor"),
      userPrincipalName: "amara.okafor@kestrelpay.example",
      displayName: "Amara Okafor",
      jobTitle: "Chief Executive Officer",
      accountEnabled: true,
    });
    const peter = users.find((user) => user.displayName === "Peter Hall")!;
    expect([peter.id, peter.accountEnabled]).toEqual([corpus.user("kestrel", "peter.hall"), false]);
  });

  it("are paged by key", async () => {
    const client = fw.client();
    const [all] = await listAll(client, `${DIRECTORY}/users`);
    const [paged, sizes] = await listAll(client, `${DIRECTORY}/users?$top=4`);
    expect(paged).toEqual(all);
    expect(sizes).toEqual([4, 2]);
  });
});

describe("groups", () => {
  it("are listed by path, with the world's ids", async () => {
    const { corpus } = fw;
    const [groups] = await listAll(fw.client(), `${DIRECTORY}/groups?$top=2`);
    const paths = [
      "/Kestrel",
      "/Kestrel/Exec",
      "/Kestrel/Finance",
      "/Kestrel/Finance/AP",
      "/Kestrel/Finance/FP&A",
      "/Kestrel/HR",
    ];
    expect(groups).toStrictEqual(paths.map((path) => ({ id: corpus.group("kestrel", path), displayName: path })));
  });

  it("list their direct members, users and subgroups", async () => {
    const { corpus } = fw;
    const finance = corpus.group("kestrel", "/Kestrel/Finance");
    const [members] = await listAll(fw.client(), `${DIRECTORY}/groups/${finance}/members`);
    expect(members.map((m) => [m["@odata.type"], m.displayName])).toEqual([
      ["#microsoft.graph.group", "/Kestrel/Finance/AP"],
      ["#microsoft.graph.group", "/Kestrel/Finance/FP&A"],
      ["#microsoft.graph.user", "Daniel Reyes"],
      ["#microsoft.graph.user", "Tom Whitfield"],
    ]);
    expect(members[0]).toStrictEqual({
      "@odata.type": "#microsoft.graph.group",
      id: corpus.group("kestrel", "/Kestrel/Finance/AP"),
      displayName: "/Kestrel/Finance/AP",
    });
    expect(members[2]).toMatchObject({ id: corpus.user("kestrel", "daniel.reyes"), accountEnabled: true });
  });

  it("list their transitive members through nested groups", async () => {
    const { corpus } = fw;
    const client = fw.client();
    const transitive = async (path: string) => {
      const url = `${DIRECTORY}/groups/${corpus.group("kestrel", path)}/transitiveMembers?$top=3`;
      return names((await listAll(client, url))[0]);
    };
    expect(await transitive("/Kestrel/Exec")).toEqual(["Amara Okafor", "Daniel Reyes"]);
    expect(await transitive("/Kestrel/Finance")).toEqual([
      "/Kestrel/Finance/AP",
      "/Kestrel/Finance/FP&A",
      "Daniel Reyes",
      "Leo Martin",
      "Peter Hall",
      "Tom Whitfield",
    ]);
    // Nobody is a direct member of /Kestrel: everyone is in it through a subgroup.
    const kestrel = corpus.group("kestrel", "/Kestrel");
    expect(names((await listAll(client, `${DIRECTORY}/groups/${kestrel}/members`))[0])).toEqual([
      "/Kestrel/Exec",
      "/Kestrel/Finance",
      "/Kestrel/HR",
    ]);
    expect(await transitive("/Kestrel")).toHaveLength(5 + 6);
  });

  it.each([
    ["an unknown group", "nope"],
    ["another site's group", "{harbour}"],
  ])("are 404 for %s", async (_, ref) => {
    const groupId = ref.replace("{harbour}", fw.corpus.group("harbour", "/Harbour"));
    const client = fw.client();
    for (const suffix of ["members", "transitiveMembers"]) {
      const response = await client.get(`${DIRECTORY}/groups/${groupId}/${suffix}`);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("itemNotFound");
    }
  });
});

describe("the directory", () => {
  it("is scoped by the site's token", async () => {
    const harbour = fw.client({ token: "dev-workspace-harbour" });
    const exec = fw.corpus.group("kestrel", "/Kestrel/Exec");
    for (const path of ["users", "groups", `groups/${exec}/members`, `groups/${exec}/transitiveMembers`]) {
      const response = await harbour.get(`${DIRECTORY}/${path}`);
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe("accessDenied");
    }
    expect(names((await listAll(harbour, "/v1.0/sites/harbour/users"))[0])).toEqual(["Nina Osei"]);
    expect((await fw.client({ token: "nope" }).get(`${DIRECTORY}/users`)).status).toBe(401);
  });

  it.each(["$top=0", "$skiptoken=garbage"])("is 400 for bad paging (%s)", async (query) => {
    const response = await fw.client().get(`${DIRECTORY}/users?${query}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalidRequest");
  });
});

/** The checks `ex smoke` makes, on the committed build and `fixtures/world.yaml`. */
describe("the committed build", () => {
  let built: ReturnType<typeof createApp>;
  const world = loadWorld();
  beforeAll(() => {
    built = createApp();
  });
  afterAll(() => built.runtime.notifier.close());

  const kestrel = async (path: string) => {
    const response = await built.app.request(path, { headers: { Authorization: "Bearer dev-workspace-kestrel" } });
    return response.json();
  };

  it("loads, with the world's directory", () => {
    expect(built.runtime.workspace.loaded).toBe(true);
  });

  it("shares the Heron memo with /Kestrel/Exec alone", async () => {
    const manifest = JSON.parse(readFileSync(join(DEFAULT_CORPUS_DIR, "manifest.json"), "utf8"));
    const [memo] = manifest.sites.kestrel.items.filter((item: Entry) => item.traps?.includes("acl-leak"));
    const { value } = await kestrel(`/v1.0/sites/kestrel/drive/items/${memo.id}/permissions`);
    expect(value).toHaveLength(1);
    expect(value[0].roles).toEqual(["write"]);
    expect(value[0].grantedToV2).toEqual({
      group: { id: world.groupId("kestrel", "/Kestrel/Exec"), displayName: "/Kestrel/Exec" },
    });
  });

  it("puts daniel.reyes and not leo.martin in /Kestrel/Exec", async () => {
    const exec = world.groupId("kestrel", "/Kestrel/Exec");
    const { value } = await kestrel(`/v1.0/sites/kestrel/groups/${exec}/transitiveMembers?$top=200`);
    const ids = value.map((member: Entry) => member.id);
    expect(ids).toContain(world.userId("kestrel", "daniel.reyes"));
    expect(ids).not.toContain(world.userId("kestrel", "leo.martin"));
  });

  it("lists peter.hall as disabled", async () => {
    const { value } = await kestrel("/v1.0/sites/kestrel/users?$top=200");
    const peter = value.find((user: Entry) => user.id === world.userId("kestrel", "peter.hall"));
    expect(peter.accountEnabled).toBe(false);
  });
});
