---
title: Directory sync and the closure
type: graded
slots:
  directory/closure: closure.ts
---

# Directory sync and the closure: the solution

`computeClosure` maps each group to its direct members. Then, for each group, it walks down a level at a time: a `seen` set starts with the group itself, the frontier starts as `[group]`, and each round adds a row `(group, member, depth)` for every child not yet seen, marks it seen, and makes it part of the next frontier. The walk ends when a round finds nothing new.

## Why it works

- **Every level.** The walk keeps going while the last round found someone, so a member three groups down is reached in round 3.
- **The shortest depth, with no comparing.** All of depth 1 is found before any of depth 2, so the first time the walk reaches a member is along its shortest path. Later paths to it are skipped.
- **One row per pair, and no loops.** `seen` stops a member reached twice from being added twice, and stops a cycle (A in B, B in A) from going round forever. It starts with the group, so a group is never its own member.
- **Built once, read every request.** Directory sync runs this and writes the rows; access decisions join on `group_closure` instead of walking the tree inside every search.

## The worked example

44 direct memberships give 92 closure rows; `/Kestrel`'s 7 direct members become 41. For each of the 11 groups, the members match Graph's `/transitiveMembers` exactly. Leo Martin is in AP at depth 1, Finance at 2 and Kestrel at 3, which is how he reaches the travel policy two levels up.

Sync writes the closure for a whole tenant in one transaction, beside the principals and direct memberships. A membership change (leo.martin leaving AP) removes his three rows, and step 2 shows how retrieval finds out.
