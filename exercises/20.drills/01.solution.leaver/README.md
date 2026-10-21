---
title: Someone off the exec team still reads its documents
type: lab
---

# Someone off the exec team still reads its documents: the solution

**The cause.** Directory sync stopped pruning the closure. `replace()` in `src/core/directory/sync.ts` brings two tables to the directory's snapshot, `group_members` (direct memberships) and `group_closure` (every membership at any depth). Its delete loop was changed to delete from `groupMembers` whatever table it was given: a copy-paste slip. For `group_members` that's right. For `group_closure` it deletes nothing, since the row it names was already gone from `group_members`. So Priya's direct row went, the audit recorded the removal, the directory version moved on, and the closure row `(/Kestrel/Exec, priya.nair, depth 1)` stayed. Access is decided on the closure.

## The path a good debugger takes

1. **Reproduce it.** As Priya, the Heron memo comes back. That rules out a stale browser or a cached answer: retrieval itself let the memo through.
2. **Where is the decision?** Section 09's one rule: `readable()` in Postgres, at query time, over `group_closure` and `document_acl`. So the cause is in those rows, or in the code that writes them. The model, the reranker and the UI are ruled out.
3. **`/labs/acls` as Priya** shows `/Kestrel/Exec` among her groups, and the memo allowed through it. The memo's ACL is untouched (still exec only), so `document_acl` is ruled out too. What's wrong is her membership.
4. **Did the sync see the change?** `acl_audit` has a `membership` row, action `removed`, for (/Kestrel/Exec, priya.nair), from the sync. So the directory fetch worked and the diff found her. The sync's input is ruled out: the bug is in what it wrote.
5. **Compare what it wrote.** `group_members` has no (Exec, priya) row; `group_closure` still has (Exec, priya, depth 1). Two tables written by the same function, from the same snapshot, disagree. That points at the function.
6. **The log says it tried.** Run `pnpm sync delta kestrel` and the dev server logs `directory synced` with closure `removed: 1`, and again on the next sync, and the next. The count is what the sync meant to delete, so a delete that runs and removes nothing reports success every time.
7. **Read `replace()` with both tables in mind.** The delete names `groupMembers` where it should name `table`.

## The fix

```ts
for (const row of gone) {
  await tx.delete(table).where(and(eq(table.groupId, row.groupId), eq(table.memberId, row.memberId)));
}
```

Restart `pnpm dev`, then sync again (`pnpm sync delta kestrel`): the fixed code finds the closure row that shouldn't be there and deletes it, and the directory version moves on, so the principal cache drops her old set. The check also runs the fault's test: remove and re-add Priya, and remove Leo Martin from AP, whose closure rows reach two levels up (Finance and Kestrel), so a fix that only handled depth 1 fails.

## The lesson

- **Derived data needs its own check.** The closure is computed from the memberships. Nothing compared the two, so they drifted silently, and the one the decision reads was the wrong one. A test or a nightly query that rebuilds the closure and diffs it with the table would have caught it the first day.
- **"Removed: 1" counted intent, not effect.** Log what a statement did (`RETURNING`, a row count), not what you asked it to do.
- **The audit told the truth about the input,** and that's what made it useful here: it ruled the whole fetch side out in one query.
