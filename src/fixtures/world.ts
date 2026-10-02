/**
 * The fictional world in `fixtures/world.yaml`: tenants, their directory and their folders.
 *
 * Ids are never stored; they derive from the world (uuid5 of `<tenant>:<kind>:<name>`), so the
 * database, the corpus manifest and fake-workspace agree without a lookup table.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { v5 as uuidv5 } from "uuid";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export type Role = "read" | "write";
export type RealmRole = "employee" | "admin";

export interface Grant {
  readonly user?: string;
  readonly group?: string;
  readonly role: Role;
}

export interface Folder {
  readonly path: string;
  readonly inherit: boolean;
  readonly grants: readonly Grant[];
}

export interface User {
  readonly username: string;
  readonly name: string;
  readonly title: string;
  readonly groups: readonly string[];
  readonly roles: readonly RealmRole[];
  readonly persona: string | null;
  readonly enabled: boolean;
  readonly email: string;
}

export interface Tenant {
  readonly slug: string;
  readonly name: string;
  readonly domain: string;
  readonly password: string;
  readonly facts: readonly string[];
  readonly groups: readonly string[];
  readonly users: readonly User[];
  readonly folders: readonly Folder[];
}

export interface ResolvedGrant {
  readonly principalType: "user" | "group";
  readonly principalId: string;
  /** The username, or the group's path. */
  readonly principalName: string;
  readonly role: Role;
  /** The folder the grant came from; null when it's the folder's own. */
  readonly inheritedFrom: string | null;
}

export class WorldError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(problems.join("\n"));
    this.name = "WorldError";
    this.problems = problems;
  }
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const USERNAME = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const ROLE_RANK: Record<Role, number> = { read: 0, write: 1 };

export const DEFAULT_WORLD_PATH = fileURLToPath(new URL("../../fixtures/world.yaml", import.meta.url));

/** Group and folder paths look like `/A/B`: absolute, no trailing slash, no blank names. */
export function pathProblem(path: string): string | null {
  const names = path.split("/");
  if (names[0] !== "" || names.length < 2 || names.slice(1).some((n) => !n || n !== n.trim())) {
    return `'${path}' isn't a path like /A/B`;
  }
  return null;
}

export function parentPath(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
}

const GrantSchema = z
  .strictObject({
    user: z.string().nullish(),
    group: z.string().nullish(),
    role: z.enum(["read", "write"]),
  })
  .refine((grant) => (grant.user == null) !== (grant.group == null), "a grant names exactly one of user or group");

const FolderSchema = z.strictObject({
  path: z.string(),
  inherit: z.boolean().default(true),
  grants: z.array(GrantSchema).default([]),
});

const UserSchema = z.strictObject({
  username: z.string().regex(USERNAME),
  name: z.string(),
  title: z.string().min(1),
  groups: z.array(z.string()),
  roles: z.array(z.enum(["employee", "admin"])).default(["employee"]),
  persona: z.string().nullish(),
  enabled: z.boolean().default(true),
});

const TenantSchema = z
  .strictObject({
    name: z.string().min(1),
    domain: z.string().min(1),
    password: z.string().min(1),
    facts: z.array(z.string()).default([]),
    groups: z.array(z.string()),
    users: z.array(UserSchema),
    folders: z.array(FolderSchema).default([]),
  })
  .superRefine((tenant, ctx) => {
    for (const problem of tenantProblems(tenant)) {
      ctx.addIssue({ code: "custom", message: problem });
    }
  });

const WorldSchema = z.strictObject({
  version: z.literal(1),
  id_namespace: z.uuid(),
  today: z.iso.date(),
  tenants: z.record(z.string().regex(SLUG), TenantSchema),
});

type TenantData = z.infer<typeof TenantSchema>;
type WorldData = z.infer<typeof WorldSchema>;

function tenantProblems(tenant: TenantData): string[] {
  const problems: string[] = [];
  const groups = new Set(tenant.groups);
  for (const path of duplicates(tenant.groups)) {
    problems.push(`group ${path} is listed twice`);
  }
  for (const path of tenant.groups) {
    const bad = pathProblem(path);
    const parent = parentPath(path);
    if (bad) {
      problems.push(`group ${bad}`);
    } else if (parent !== "/" && !groups.has(parent)) {
      problems.push(`group ${path} has no parent group ${parent}`);
    }
  }

  for (const username of duplicates(tenant.users.map((user) => user.username))) {
    problems.push(`username ${username} is used twice`);
  }
  for (const user of tenant.users) {
    const words = user.name.split(/\s+/).filter(Boolean);
    if (user.name.split(" ").length < 2 || user.name !== words.join(" ")) {
      problems.push(`user ${user.username}: name '${user.name}' needs a first and a last name`);
    }
    for (const group of user.groups) {
      if (!groups.has(group)) {
        problems.push(`user ${user.username} is in group ${group}, which doesn't exist`);
      }
    }
  }

  const folders = new Set(tenant.folders.map((folder) => folder.path));
  const usernames = new Set(tenant.users.map((user) => user.username));
  for (const path of duplicates(tenant.folders.map((folder) => folder.path))) {
    problems.push(`folder ${path} is listed twice`);
  }
  for (const folder of tenant.folders) {
    const bad = pathProblem(folder.path);
    const parent = parentPath(folder.path);
    if (folder.path === "/") {
      problems.push("folder /: the root can't be listed; it shares nothing");
    } else if (bad) {
      problems.push(`folder ${bad}`);
    } else if (parent !== "/" && !folders.has(parent)) {
      problems.push(`folder ${folder.path} has no parent folder ${parent}`);
    }
    for (const grant of folder.grants) {
      if (grant.user != null && !usernames.has(grant.user)) {
        problems.push(`folder ${folder.path}: grant to unknown user ${grant.user}`);
      }
      if (grant.group != null && !groups.has(grant.group)) {
        problems.push(`folder ${folder.path}: grant to unknown group ${grant.group}`);
      }
    }
  }
  return problems;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function toTenant(slug: string, data: TenantData): Tenant {
  return {
    slug,
    name: data.name,
    domain: data.domain,
    password: data.password,
    facts: data.facts,
    groups: data.groups,
    users: data.users.map((user) => ({
      username: user.username,
      name: user.name,
      title: user.title,
      groups: user.groups,
      roles: user.roles,
      persona: user.persona ?? null,
      enabled: user.enabled,
      email: `${user.username}@${data.domain}`,
    })),
    folders: data.folders.map((folder) => ({
      path: folder.path,
      inherit: folder.inherit,
      grants: folder.grants.map(({ user, group, role }) => (user != null ? { user, role } : { group: group!, role })),
    })),
  };
}

export class World {
  readonly version = 1;
  readonly idNamespace: string;
  /** An ISO date, `YYYY-MM-DD`. */
  readonly today: string;
  readonly tenants: Readonly<Record<string, Tenant>>;

  constructor(data: WorldData) {
    this.idNamespace = data.id_namespace.toLowerCase();
    this.today = data.today;
    this.tenants = Object.fromEntries(Object.entries(data.tenants).map(([slug, t]) => [slug, toTenant(slug, t)]));
    deepFreeze(this);
  }

  tenant(slug: string): Tenant {
    const tenant = Object.hasOwn(this.tenants, slug) ? this.tenants[slug] : undefined;
    if (!tenant) throw new Error(`no tenant '${slug}'`);
    return tenant;
  }

  user(tenant: string, username: string): User {
    const user = this.tenant(tenant).users.find((u) => u.username === username);
    if (!user) throw new Error(`tenant '${tenant}' has no user '${username}'`);
    return user;
  }

  folder(tenant: string, path: string): Folder {
    const folder = this.tenant(tenant).folders.find((f) => f.path === path);
    if (!folder) throw new Error(`tenant '${tenant}' has no folder '${path}'`);
    return folder;
  }

  userId(tenant: string, username: string): string {
    this.user(tenant, username);
    return this.id(tenant, "user", username);
  }

  groupId(tenant: string, path: string): string {
    if (!this.tenant(tenant).groups.includes(path)) {
      throw new Error(`tenant '${tenant}' has no group '${path}'`);
    }
    return this.id(tenant, "group", path);
  }

  /** Workspace items, by path; `/` is the root folder. */
  itemId(tenant: string, path: string): string {
    this.tenant(tenant);
    const bad = path === "/" ? null : pathProblem(path);
    if (bad) throw new Error(bad);
    return this.id(tenant, "item", path);
  }

  /**
   * The parent's grants (when the folder inherits), then its own; the root shares nothing.
   *
   * A principal granted more than once keeps its first position and the stronger role; on a tie
   * the first grant wins, so access is attributed to the folder it came from.
   */
  effectiveGrants(tenant: string, folder: string): readonly ResolvedGrant[] {
    if (folder === "/") return [];
    const spec = this.folder(tenant, folder);
    const grants: ResolvedGrant[] = [];
    if (spec.inherit) {
      const parent = parentPath(folder);
      for (const grant of this.effectiveGrants(tenant, parent)) {
        grants.push(grant.inheritedFrom === null ? { ...grant, inheritedFrom: parent } : grant);
      }
    }
    grants.push(...spec.grants.map((grant) => this.resolve(tenant, grant)));

    const merged = new Map<string, ResolvedGrant>();
    for (const grant of grants) {
      const key = `${grant.principalType}:${grant.principalId}`;
      const current = merged.get(key);
      if (!current || ROLE_RANK[grant.role] > ROLE_RANK[current.role]) merged.set(key, grant);
    }
    return [...merged.values()];
  }

  private resolve(tenant: string, grant: Grant): ResolvedGrant {
    if (grant.user !== undefined) {
      const principalId = this.userId(tenant, grant.user);
      return { principalType: "user", principalId, principalName: grant.user, role: grant.role, inheritedFrom: null };
    }
    const path = grant.group!;
    const principalId = this.groupId(tenant, path);
    return { principalType: "group", principalId, principalName: path, role: grant.role, inheritedFrom: null };
  }

  private id(tenant: string, kind: "user" | "group" | "item", name: string): string {
    return uuidv5(`${tenant}:${kind}:${name}`, this.idNamespace);
  }
}

/** One line per problem, prefixed with where it is (`tenants.kestrel.users.3.name`). */
function problemsOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.map(String).join(".");
    return where ? `${where}: ${issue.message}` : issue.message;
  });
}

/** Read and validate the world, throwing `WorldError` with every problem found. */
export function loadWorld(path: string = DEFAULT_WORLD_PATH): World {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new WorldError([`${path}: can't read it: ${(error as Error).message}`]);
  }
  let raw: unknown;
  try {
    // Duplicate keys are an error (`uniqueKeys` is on by default); a hand-edited fixture wants one.
    raw = parseYaml(text);
  } catch (error) {
    throw new WorldError([`${path}: not valid YAML: ${(error as Error).message}`]);
  }
  const parsed = WorldSchema.safeParse(raw);
  if (!parsed.success) throw new WorldError(problemsOf(parsed.error));
  return new World(parsed.data);
}
