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
  const children = new Map<string, string[]>();
  for (const { groupId, memberId } of edges) children.set(groupId, [...(children.get(groupId) ?? []), memberId]);

  const rows: ClosureRow[] = [];
  for (const groupId of children.keys()) {
    const seen = new Set([groupId]);
    let frontier = [groupId];
    for (let depth = 1; frontier.length; depth++) {
      const next: string[] = [];
      for (const node of frontier) {
        for (const member of children.get(node) ?? []) {
          if (seen.has(member)) continue;
          seen.add(member);
          rows.push({ groupId, memberId: member, depth });
          next.push(member);
        }
      }
      frontier = next;
    }
  }
  return rows;
}
