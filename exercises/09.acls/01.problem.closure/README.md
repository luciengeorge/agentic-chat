---
title: Directory sync and the closure
type: graded
slots:
  directory/closure: closure.ts
---

# Directory sync and the closure

👨‍💼 The travel policy lives in `/HR/Policies`, shared with the group `/Kestrel`: everyone. But Leo Martin, the finance intern, isn't a member of `/Kestrel`. He's a member of `/Kestrel/Finance/AP`, which is a member of `/Kestrel/Finance`, which is a member of `/Kestrel`. Every search Leo makes has to know that, fast, for every document it looks at.

## Terms

- A **principal** is anyone an ACL can name: a user or a group. The **directory** (Microsoft Entra ID or Okta, the services companies keep their staff accounts and groups in; here fake-workspace's Graph-style API) lists them and who is a direct member of what.
- A **direct membership** (an **edge**) says one principal is in one group. Groups can be members of groups.
- The **closure** is every (group, member) pair those edges imply, at any depth: a member of AP is in Finance at depth 2 and in Kestrel at depth 3. **Directory sync** stores it in `group_closure`.
- `/transitiveMembers` is Graph's own answer to "who is in this group, at any depth". We build the closure ourselves and check it against that.

## Do this

🐨 Write `computeClosure` in `playground/closure.ts`. Directory sync (`fetchDirectory`, then `applyDirectory` in `sync.ts`) is written; it calls your function and writes its rows.

## A worked example

Kestrel's directory has 42 principals (31 users, 11 groups) and 44 direct memberships. Only 7 of them point into `/Kestrel`: Ella Brooks, and six department groups. The closure holds 92 rows, and puts 41 members in `/Kestrel`: all 31 users and the 10 groups below it.

Leo has one direct membership and three closure rows:

| Group                 | Depth | Why                   |
| --------------------- | ----- | --------------------- |
| `/Kestrel/Finance/AP` | 1     | his own membership    |
| `/Kestrel/Finance`    | 2     | AP is in Finance      |
| `/Kestrel`            | 3     | Finance is in Kestrel |

Run the tests with `pnpm ex test 09.1`. They read the real directory from fake-workspace, in process.
