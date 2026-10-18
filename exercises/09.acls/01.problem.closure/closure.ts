// 👨‍💼 Kestrel's travel policy is shared with /Kestrel. Nobody is a direct member of /Kestrel but Ella Brooks:
//    everyone else is in a team, inside a department, inside /Kestrel. Leo Martin, the finance intern, is in
//    /Kestrel/Finance/AP and nothing else. For search to show him the policy, something has to know that a member
//    of AP is a member of Finance, and so of Kestrel.

/** A direct membership: `memberId` (a user or a group) is in `groupId`. */
export interface Edge {
  groupId: string;
  memberId: string;
}

export interface ClosureRow {
  groupId: string;
  memberId: string;
  /** 1 for a direct member, 2 for a member of a direct subgroup, and so on: the shortest way down. */
  depth: number;
}

/**
 * Every (ancestor group, descendant) pair the direct memberships imply: a member of /Finance/AP is also in
 * /Finance. No self rows, even when a cycle leads a group back to itself, and each pair once at its smallest
 * depth. Breadth first from each group, so the first visit is the shortest.
 */
export function computeClosure(edges: readonly Edge[]): ClosureRow[] {
  // 🐨 Index the edges by group: each group's direct members.
  // 🐨 For every group that has members, walk down from it level by level (breadth first): its direct members are
  //    depth 1, their members depth 2, and so on. Add one row for each member the first time you reach it, at
  //    the depth you reached it at. A member you've already reached from this group is skipped, and so is the
  //    group itself.
  //
  // 💰 `new Map<string, string[]>()` and `map.get(key) ?? []`; `new Set([first])`, `set.has(x)`, `set.add(x)`;
  //    `map.keys()` for the groups.
  //
  // 🦉 Why a closure at all. A document's ACL names groups ("/Kestrel read"). Deciding at query time means asking
  //    "is this user in /Kestrel, at any depth?" for every candidate. Walking the tree inside every search would
  //    be a recursive query per request. So directory sync writes every (ancestor, member) pair down once, in
  //    `group_closure`, and the decision is a plain lookup.
  // 🦉 Why breadth first. The first time a level-by-level walk reaches a member is by its shortest path, so its
  //    depth is right with no comparing. Depth first (recursion) can reach a member down a long path first
  //    (kestrel > finance > fpa > daniel, depth 3) and then skip the short one (kestrel > exec > daniel, 2).
  // 🦉 Why remember what you've reached. A member reached two ways would get two rows, and a cycle (A in B, B in
  //    A, which directories allow) would loop forever. Starting the set with the group itself also keeps it from
  //    being its own member.
  // 🦉 Who reads it. `applyDirectory` (in `sync.ts`) writes these rows to `group_closure`, and every access
  //    decision in step 3 joins on that table.
  //
  // 📜 https://learn.microsoft.com/en-us/graph/api/group-list-transitivemembers
  //
  // 🚨 The tests check every level of nesting, one row at the shortest depth for a member reached two ways, a
  //    cycle, no memberships, and Kestrel's real directory against Graph's /transitiveMembers for every group.
  throw new Error(`computeClosure(${edges.length} memberships) isn't written yet`);
}
