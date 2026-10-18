// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createGraphClient } from "#learn/connectors/graph";
import { type ClosureRow, computeClosure } from "#learn/directory/closure";
import { fetchDirectory } from "#learn/directory/sync";
import { setupRealWorkspace } from "@/core/connectors/testing";

const workspace = setupRealWorkspace();

const rows = (closure: ClosureRow[]) => closure.map((row) => `${row.groupId}>${row.memberId}@${row.depth}`).sort();

describe("computeClosure", () => {
  it("puts a member of a nested group in every group above it, with how far down it is", () => {
    const closure = computeClosure([
      { groupId: "kestrel", memberId: "finance" },
      { groupId: "finance", memberId: "ap" },
      { groupId: "ap", memberId: "leo" },
    ]);
    expect(rows(closure), "follow memberships down every level, not just one").toEqual(
      ["ap>leo@1", "finance>ap@1", "finance>leo@2", "kestrel>ap@2", "kestrel>finance@1", "kestrel>leo@3"].sort(),
    );
  });

  it("gives a member reached two ways one row, at the shorter depth", () => {
    const closure = computeClosure([
      { groupId: "kestrel", memberId: "finance" },
      { groupId: "kestrel", memberId: "exec" },
      { groupId: "finance", memberId: "fpa" },
      { groupId: "fpa", memberId: "daniel" },
      { groupId: "exec", memberId: "daniel" },
    ]);
    const daniel = closure.filter((row) => row.groupId === "kestrel" && row.memberId === "daniel");
    expect(daniel.length, "one row per (group, member)").toBe(1);
    expect(daniel[0].depth, "kestrel > exec > daniel is 2; kestrel > finance > fpa > daniel is 3: keep 2").toBe(2);
  });

  it("stops on a cycle, and never says a group is in itself", () => {
    const closure = computeClosure([
      { groupId: "a", memberId: "b" },
      { groupId: "b", memberId: "a" },
      { groupId: "b", memberId: "user" },
    ]);
    expect(
      closure.filter((row) => row.groupId === row.memberId),
      "a group reached again through a cycle is not its own member",
    ).toEqual([]);
    expect(rows(closure)).toEqual(["a>b@1", "a>user@2", "b>a@1", "b>user@1"]);
  });

  it("has nothing for no memberships", () => {
    expect(computeClosure([])).toEqual([]);
  });

  it("builds Kestrel's 92 closure rows from 44 direct memberships, each group matching Graph's /transitiveMembers", async () => {
    const graph = createGraphClient({
      baseUrl: "http://fw",
      site: "kestrel",
      token: "dev-workspace-kestrel",
      fetch: workspace.start().fetch,
    });
    const { principals, edges } = await fetchDirectory(graph);
    expect(principals).toHaveLength(42);
    expect(edges).toHaveLength(44);

    const closure = computeClosure(edges);
    expect(closure).toHaveLength(92);
    const name = new Map(principals.map((p) => [p.id, p.name]));
    for (const group of await graph.groups()) {
      const want = (await graph.transitiveMembers(group.id)).map((member) => member.id).sort();
      const got = closure.filter((row) => row.groupId === group.id).map((row) => row.memberId);
      expect(got.sort(), `${group.displayName}'s members, through every level`).toEqual(want);
    }

    const kestrel = principals.find((p) => p.name === "/Kestrel")!.id;
    expect(edges.filter((edge) => edge.groupId === kestrel)).toHaveLength(7);
    expect(closure.filter((row) => row.groupId === kestrel)).toHaveLength(41);
    const leo = principals.find((p) => p.name === "leo.martin")!.id;
    expect(
      closure
        .filter((row) => row.memberId === leo)
        .map((row) => `${name.get(row.groupId)} at ${row.depth}`)
        .sort(),
    ).toEqual(["/Kestrel at 3", "/Kestrel/Finance at 2", "/Kestrel/Finance/AP at 1"]);
  });
});
