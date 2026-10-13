import { describe, expect, it } from "vitest";

import { computeClosure } from "./closure";

const sorted = (rows: ReturnType<typeof computeClosure>) =>
  rows.map((row) => `${row.groupId}>${row.memberId}@${row.depth}`).sort();

describe("computeClosure", () => {
  it("adds every ancestor of a nested member, with its depth", () => {
    const rows = computeClosure([
      { groupId: "kestrel", memberId: "finance" },
      { groupId: "finance", memberId: "ap" },
      { groupId: "ap", memberId: "leo" },
    ]);
    expect(sorted(rows)).toEqual(
      ["ap>leo@1", "finance>ap@1", "finance>leo@2", "kestrel>ap@2", "kestrel>finance@1", "kestrel>leo@3"].sort(),
    );
  });

  it("keeps the shortest depth when a member is reached two ways", () => {
    const rows = computeClosure([
      { groupId: "exec", memberId: "finance" },
      { groupId: "finance", memberId: "daniel" },
      { groupId: "exec", memberId: "daniel" },
    ]);
    expect(sorted(rows)).toEqual(["exec>daniel@1", "exec>finance@1", "finance>daniel@1"]);
  });

  it("survives a cycle without a self row", () => {
    const rows = computeClosure([
      { groupId: "a", memberId: "b" },
      { groupId: "b", memberId: "a" },
      { groupId: "b", memberId: "user" },
    ]);
    expect(rows.every((row) => row.groupId !== row.memberId)).toBe(true);
    expect(sorted(rows)).toEqual(["a>b@1", "a>user@2", "b>a@1", "b>user@1"]);
  });

  it("has nothing for no memberships", () => {
    expect(computeClosure([])).toEqual([]);
  });
});
