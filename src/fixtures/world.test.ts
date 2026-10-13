// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { v5 as uuidv5 } from "uuid";
import { afterAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { type ResolvedGrant, type User, World, WorldError, loadWorld } from "./world";

const NAMESPACE = "7d491e87-db78-4901-a173-34260d9df5d1";

const BASE = {
  version: 1,
  id_namespace: NAMESPACE,
  today: "2026-09-30",
  tenants: {
    acme: {
      name: "Acme",
      domain: "acme.example",
      password: "pw",
      groups: ["/Acme", "/Acme/Ops", "/Acme/Ops/Night"],
      users: [
        { username: "ann.lee", name: "Ann Lee", title: "Boss", groups: ["/Acme/Ops"] },
        {
          username: "bob.ray",
          name: "Bob Ray",
          title: "Night Lead",
          groups: ["/Acme/Ops/Night"],
          roles: ["employee", "admin"],
          enabled: false,
        },
      ],
      folders: [
        {
          path: "/Ops",
          grants: [
            { group: "/Acme/Ops", role: "read" },
            { user: "ann.lee", role: "write" },
          ],
        },
        {
          path: "/Ops/Night",
          grants: [
            { group: "/Acme/Ops/Night", role: "write" },
            { group: "/Acme/Ops", role: "write" },
          ],
        },
        { path: "/Ops/Night/Logs" },
        {
          path: "/Ops/Private",
          inherit: false,
          grants: [
            { user: "bob.ray", role: "read" },
            { user: "bob.ray", role: "write" },
          ],
        },
        {
          path: "/Shared",
          grants: [
            { group: "/Acme", role: "read" },
            { group: "/Acme", role: "read" },
          ],
        },
      ],
    },
    zeta: {
      name: "Zeta",
      domain: "zeta.example",
      password: "pw",
      groups: ["/Zeta"],
      users: [{ username: "ann.lee", name: "Ann Lee", title: "Ops", groups: [] }],
    },
  },
};

type Data = typeof BASE & Record<string, unknown>;

const dir = mkdtempSync(join(tmpdir(), "world-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let written = 0;
function write(content: unknown): string {
  const path = join(dir, `world-${++written}.yaml`);
  writeFileSync(path, typeof content === "string" ? content : stringify(content));
  return path;
}

function problemsFor(content: unknown): readonly string[] {
  try {
    loadWorld(write(content));
  } catch (error) {
    if (error instanceof WorldError) return error.problems;
    throw error;
  }
  throw new Error("the world loaded");
}

const world = loadWorld(write(BASE));

function grant(kind: "user" | "group", name: string, role: "read" | "write", from: string | null): ResolvedGrant {
  const principalId = kind === "user" ? world.userId("acme", name) : world.groupId("acme", name);
  return { principalType: kind, principalId, principalName: name, role, inheritedFrom: from };
}

describe("the committed world", () => {
  const committed = loadWorld();

  it("loads", () => {
    expect(Object.keys(committed.tenants).sort()).toEqual(["harbour", "kestrel"]);
    expect(committed.user("kestrel", "peter.hall").enabled).toBe(false);
    expect(committed.user("kestrel", "tariq.aziz").roles).toEqual(["employee", "admin"]);
    expect(committed.user("kestrel", "leo.martin").email).toBe("leo.martin@kestrelpay.example");
  });

  it("keeps the ids the Python world gave", () => {
    expect(committed.userId("kestrel", "leo.martin")).toBe("0ae8fa04-8d89-5fd9-b3f0-17a15e8a72f6");
    expect(committed.groupId("kestrel", "/Kestrel/Exec")).toBe("0c0199be-c8c7-5561-a0d7-6c1424e5565b");
  });

  it("agrees with the committed manifest on every id", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../fixtures/corpus/build/manifest.json", import.meta.url), "utf8"),
    );
    for (const [slug, tenant] of Object.entries(committed.tenants)) {
      const site = manifest.sites[slug];
      expect(site.users).toEqual(
        Object.fromEntries(
          tenant.users.map((u) => [committed.userId(slug, u.username), { username: u.username, display_name: u.name }]),
        ),
      );
      expect(site.groups).toEqual(
        Object.fromEntries(tenant.groups.map((path) => [committed.groupId(slug, path), { path }])),
      );
      for (const item of site.items) {
        expect(item.id).toBe(committed.itemId(slug, item.path));
      }
    }
    const heron = manifest.sites.kestrel.items.find((item: { traps?: string[] }) => item.traps?.includes("acl-leak"));
    expect(heron.id).toBe(committed.itemId("kestrel", "/Exec/Project Heron Board Memo.pdf"));
  });

  it("resolves its sharing", () => {
    const fpa = committed.effectiveGrants("kestrel", "/Finance/FP&A");
    expect(fpa.map((g) => [g.principalName, g.role, g.inheritedFrom])).toEqual([
      ["/Kestrel/Finance/FP&A", "write", null],
      ["daniel.reyes", "read", null],
    ]);
    const casework = committed.effectiveGrants("kestrel", "/HR/Casework");
    expect(casework.map((g) => [g.principalName, g.inheritedFrom])).toEqual([["/Kestrel/HR", "/HR"]]);
  });
});

describe("ids", () => {
  it("are uuid5 of tenant, kind and name", () => {
    expect(world.userId("acme", "ann.lee")).toBe(uuidv5("acme:user:ann.lee", NAMESPACE));
    expect(world.groupId("acme", "/Acme/Ops")).toBe(uuidv5("acme:group:/Acme/Ops", NAMESPACE));
    expect(world.itemId("acme", "/")).toBe(uuidv5("acme:item:/", NAMESPACE));
    expect(world.itemId("acme", "/Ops/a.pdf")).toBe(uuidv5("acme:item:/Ops/a.pdf", NAMESPACE));
    expect(world.userId("acme", "ann.lee")).not.toBe(world.userId("zeta", "ann.lee"));
  });

  it("refuse unknown names", () => {
    expect(() => world.userId("acme", "nobody")).toThrow(/nobody/);
    expect(() => world.groupId("acme", "/Acme/Nope")).toThrow(/\/Acme\/Nope/);
    expect(() => world.itemId("globex", "/")).toThrow(/globex/);
    expect(() => world.itemId("acme", "Ops/")).toThrow(/isn't a path/);
    expect(() => world.effectiveGrants("acme", "/Nope")).toThrow(/\/Nope/);
    expect(() => world.tenant("toString")).toThrow(/toString/);
  });
});

describe("users", () => {
  it("have defaults and an email in their tenant's domain", () => {
    const ann = world.user("acme", "ann.lee");
    expect([ann.roles, ann.enabled, ann.persona]).toEqual([["employee"], true, null]);
    expect(ann.email).toBe("ann.lee@acme.example");
    expect(world.user("zeta", "ann.lee").email).toBe("ann.lee@zeta.example");
  });
});

describe("effective grants", () => {
  it("are empty at the root", () => {
    expect(world.effectiveGrants("acme", "/")).toEqual([]);
  });

  it("name no origin for a folder's own", () => {
    expect(world.effectiveGrants("acme", "/Ops")).toEqual([
      grant("group", "/Acme/Ops", "read", null),
      grant("user", "ann.lee", "write", null),
    ]);
  });

  it("put inherited ones first, and a stronger own grant wins", () => {
    expect(world.effectiveGrants("acme", "/Ops/Night")).toEqual([
      grant("group", "/Acme/Ops", "write", null),
      grant("user", "ann.lee", "write", "/Ops"),
      grant("group", "/Acme/Ops/Night", "write", null),
    ]);
  });

  it("reach through grandparents", () => {
    expect(world.effectiveGrants("acme", "/Ops/Night/Logs")).toEqual([
      grant("group", "/Acme/Ops", "write", "/Ops/Night"),
      grant("user", "ann.lee", "write", "/Ops"),
      grant("group", "/Acme/Ops/Night", "write", "/Ops/Night"),
    ]);
  });

  it("drop the parent's when inherit is false", () => {
    expect(world.effectiveGrants("acme", "/Ops/Private")).toEqual([grant("user", "bob.ray", "write", null)]);
  });

  it("list a principal granted twice with equal roles once", () => {
    expect(world.effectiveGrants("acme", "/Shared")).toEqual([grant("group", "/Acme", "read", null)]);
  });
});

function mutated(change: string): Data {
  const data: Data = structuredClone(BASE);
  const acme = data.tenants.acme as Record<string, any>;
  const tenants = data.tenants as Record<string, unknown>;
  switch (change) {
    case "group parent":
      acme.groups.push("/Acme/Sales/EMEA");
      break;
    case "group path":
      acme.groups.push("/Acme/");
      break;
    case "group twice":
      acme.groups.push("/Acme/Ops");
      break;
    case "username twice":
      acme.users.push({ ...acme.users[0], title: "Clone" });
      break;
    case "unknown user group":
      acme.users[0].groups = ["/Acme/Ghosts"];
      break;
    case "single name":
      acme.users[0].name = "Ann";
      break;
    case "folder parent":
      acme.folders.push({ path: "/Sales/EMEA" });
      break;
    case "root folder":
      acme.folders.push({ path: "/" });
      break;
    case "folder twice":
      acme.folders.push({ path: "/Ops" });
      break;
    case "grant user":
      acme.folders[0].grants.push({ user: "zed.zed", role: "read" });
      break;
    case "grant group":
      acme.folders[0].grants.push({ group: "/Zeta", role: "read" });
      break;
    case "grant both":
      acme.folders[0].grants.push({ user: "ann.lee", group: "/Acme", role: "read" });
      break;
    case "grant role":
      acme.folders[0].grants[0].role = "owner";
      break;
    case "realm role":
      acme.users[0].roles = ["superuser"];
      break;
    case "extra field":
      acme.users[0].nickname = "annie";
      break;
    case "username case":
      acme.users[0].username = "Ann.Lee";
      break;
    case "tenant slug":
      tenants["Acme Corp"] = tenants.zeta;
      delete tenants.zeta;
      break;
    case "version":
      data.version = 2;
      break;
    default:
      throw new Error(change);
  }
  return data;
}

describe("validation", () => {
  it.for([
    ["group parent", "tenants.acme: group /Acme/Sales/EMEA has no parent group /Acme/Sales"],
    ["group path", "tenants.acme: group '/Acme/' isn't a path like /A/B"],
    ["group twice", "tenants.acme: group /Acme/Ops is listed twice"],
    ["username twice", "tenants.acme: username ann.lee is used twice"],
    ["unknown user group", "tenants.acme: user ann.lee is in group /Acme/Ghosts, which doesn't exist"],
    ["single name", "tenants.acme: user ann.lee: name 'Ann' needs a first and a last name"],
    ["folder parent", "tenants.acme: folder /Sales/EMEA has no parent folder /Sales"],
    ["root folder", "tenants.acme: folder /: the root can't be listed"],
    ["folder twice", "tenants.acme: folder /Ops is listed twice"],
    ["grant user", "tenants.acme: folder /Ops: grant to unknown user zed.zed"],
    ["grant group", "tenants.acme: folder /Ops: grant to unknown group /Zeta"],
    ["grant both", "tenants.acme.folders.0.grants.2: a grant names exactly one of user or group"],
    ["grant role", "tenants.acme.folders.0.grants.0.role: Invalid option"],
    ["realm role", "tenants.acme.users.0.roles.0: Invalid option"],
    ["extra field", 'tenants.acme.users.0: Unrecognized key: "nickname"'],
    ["username case", "tenants.acme.users.0.username: Invalid string"],
    ["tenant slug", "tenants.Acme Corp: Invalid key"],
    ["version", "version: Invalid input: expected 1"],
  ])("reports %s", ([change, expected]) => {
    const problems = problemsFor(mutated(change));
    expect(
      problems.some((problem) => problem.includes(expected)),
      problems.join("\n"),
    ).toBe(true);
  });

  it("reports every problem at once", () => {
    const data = structuredClone(BASE) as Record<string, any>;
    const { acme, zeta } = data.tenants;
    acme.groups.push("/Acme/Sales/EMEA");
    acme.users[0].groups = ["/Acme/Ghosts"];
    acme.folders[0].grants.push({ user: "zed.zed", role: "read" });
    zeta.users[0].title = "";
    expect(problemsFor(data)).toEqual([
      "tenants.acme: group /Acme/Sales/EMEA has no parent group /Acme/Sales",
      "tenants.acme: user ann.lee is in group /Acme/Ghosts, which doesn't exist",
      "tenants.acme: folder /Ops: grant to unknown user zed.zed",
      "tenants.zeta.users.0.title: Too small: expected string to have >=1 characters",
    ]);
  });

  it("refuses duplicate YAML keys", () => {
    expect(problemsFor("version: 1\nversion: 1\n")).toEqual([expect.stringMatching(/Map keys must be unique/)]);
  });

  it("refuses invalid YAML", () => {
    expect(problemsFor("tenants: [\n")).toEqual([expect.stringMatching(/not valid YAML/)]);
  });

  it("refuses a missing file", () => {
    expect(() => loadWorld(join(dir, "missing.yaml"))).toThrow(/can't read/);
  });
});

it("is frozen", () => {
  expect(world).toBeInstanceOf(World);
  expect(() => {
    (world as { today: string }).today = "2027-01-01";
  }).toThrow(TypeError);
  expect(() => {
    (world.tenant("acme").users as User[]).push(world.user("acme", "ann.lee"));
  }).toThrow(TypeError);
});
