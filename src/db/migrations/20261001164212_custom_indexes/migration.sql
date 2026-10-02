-- Indexes the Drizzle schema doesn't declare: it can't express INCLUDE, and `member` lives in the
-- generated auth schema. The drift test lists them, so a new one here needs a line there too.

-- "Which groups is this user in?" runs on every authorised query, and this answers it index-only.
-- tenant_id rides along for the RLS policy, which would otherwise visit the heap once forced.
CREATE INDEX "group_closure_member_idx" ON "group_closure" ("member_id", "group_id") INCLUDE ("tenant_id");
--> statement-breakpoint
-- One organization per user. The beforeAddMember hook gives the friendly error; this is the
-- guarantee when two adds race.
CREATE UNIQUE INDEX "member_user_id_key" ON "member" ("user_id");
