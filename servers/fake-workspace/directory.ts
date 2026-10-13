import type { Context, Hono } from "hono";

/**
 * Each site's directory: its tenant's users and groups from `fixtures/world.yaml`. The manifest
 * names them but carries no memberships, titles or `enabled`, so the world is the source.
 */
import { type World, parentPath } from "@/fixtures/world";

import type { Runtime } from "./app";

import { GraphError, badRequest, notFound } from "./errors";
import { type Json, keysetPage, siteAccess, top } from "./http";
import { type SortKey, compareKeys, nameKey } from "./site";

export interface DirectoryUser {
  readonly kind: "user";
  readonly id: string;
  readonly username: string;
  readonly email: string;
  readonly name: string;
  readonly title: string;
  readonly enabled: boolean;
  /** The groups it's a direct member of, by path. */
  readonly groups: readonly string[];
}

export interface DirectoryGroup {
  readonly kind: "group";
  readonly id: string;
  readonly path: string;
}

export type Member = DirectoryUser | DirectoryGroup;

export function displayName(member: Member): string {
  return member.kind === "user" ? member.name : member.path;
}

/** Listed like children: by display name, case-insensitively, then id. */
export function memberKey(member: Member): SortKey {
  return [nameKey(displayName(member)), member.id];
}

export class Directory {
  /** Replaced, never edited in place, when the control API changes a membership. A reset builds a new directory. */
  users: readonly DirectoryUser[];
  readonly groups: readonly DirectoryGroup[];

  constructor(world: World, tenant: string) {
    const { users, groups } = world.tenant(tenant);
    this.users = users.map((user) => ({
      kind: "user",
      id: world.userId(tenant, user.username),
      username: user.username,
      email: user.email,
      name: user.name,
      title: user.title,
      enabled: user.enabled,
      groups: user.groups,
    }));
    this.groups = groups.map((path) => ({ kind: "group", id: world.groupId(tenant, path), path }));
  }

  group(id: string): DirectoryGroup {
    const group = this.groups.find((g) => g.id === id);
    if (!group) throw notFound("No such group.");
    return group;
  }

  /**
   * Makes a user a direct member of the group, or stops it being one. Subgroups follow their paths, so only users
   * move. Graph reports no drive change for this, so it reaches neither delta nor notifications.
   */
  setMembership(group: DirectoryGroup, memberId: string, member: boolean): void {
    if (this.groups.some((g) => g.id === memberId)) {
      throw badRequest("A subgroup's membership follows its path; only users can be added or removed.");
    }
    const user = this.users.find((u) => u.id === memberId);
    if (!user) throw notFound("No such user.");
    if (user.groups.includes(group.path) === member) {
      if (member) throw new GraphError(409, "conflict", "The user is already a direct member of the group.");
      throw notFound("The user isn't a direct member of the group.");
    }
    const groups = member ? [...user.groups, group.path] : user.groups.filter((path) => path !== group.path);
    this.users = this.users.map((u) => (u === user ? { ...u, groups } : u));
  }

  /** A group's subgroups (one level down its path) and the users who list it. */
  members(group: DirectoryGroup): Member[] {
    const subgroups = this.groups.filter((g) => parentPath(g.path) === group.path);
    return [...subgroups, ...this.users.filter((u) => u.groups.includes(group.path))];
  }

  /** Every group below it and every user in it or in one of those, each once. */
  transitiveMembers(group: DirectoryGroup): Member[] {
    const below = this.groups.filter((g) => g.path.startsWith(`${group.path}/`));
    const paths = new Set([group.path, ...below.map((g) => g.path)]);
    return [...below, ...this.users.filter((u) => u.groups.some((path) => paths.has(path)))];
  }
}

function userJson(user: DirectoryUser): Json {
  return {
    id: user.id,
    userPrincipalName: user.email,
    displayName: user.name,
    jobTitle: user.title,
    accountEnabled: user.enabled,
  };
}

function groupJson(group: DirectoryGroup): Json {
  return { id: group.id, displayName: group.path };
}

/** Members mix users and groups, so each says which it is, as Graph's directoryObjects do. */
function memberJson(member: Member): Json {
  return member.kind === "user"
    ? { "@odata.type": "#microsoft.graph.user", ...userJson(member) }
    : { "@odata.type": "#microsoft.graph.group", ...groupJson(member) };
}

/**
 * Graph's directory, scoped by the same per-site tokens as the drive: `/users`, `/groups`, and a
 * group's direct `/members` and nested `/transitiveMembers`, all paged like children.
 */
export function directoryRoutes(app: Hono, rt: Runtime): void {
  async function list<T extends Member>(
    c: Context,
    entries: (dir: Directory) => readonly T[],
    json: (entry: T) => Json,
  ) {
    const site = await siteAccess(c, rt);
    const size = top(c);
    const sorted = [...entries(rt.workspace.directories.get(site.name)!)].sort((a, b) =>
      compareKeys(memberKey(a), memberKey(b)),
    );
    const { page, nextLink } = keysetPage(c, sorted, memberKey, size);
    const body: Json = { value: page.map(json) };
    if (nextLink) body["@odata.nextLink"] = nextLink;
    return c.json(body);
  }

  const groupId = (c: Context) => c.req.param("groupId")!;

  app.get("/v1.0/sites/:site/users", (c) => list(c, (dir) => dir.users, userJson));
  app.get("/v1.0/sites/:site/groups", (c) => list(c, (dir) => dir.groups, groupJson));
  app.get("/v1.0/sites/:site/groups/:groupId/members", (c) =>
    list(c, (dir) => dir.members(dir.group(groupId(c))), memberJson),
  );
  app.get("/v1.0/sites/:site/groups/:groupId/transitiveMembers", (c) =>
    list(c, (dir) => dir.transitiveMembers(dir.group(groupId(c))), memberJson),
  );
}
