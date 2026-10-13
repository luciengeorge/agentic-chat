-- The app's role (PLAN.md 09.6). The app connects as `ac_app`, which owns nothing and has no BYPASSRLS, so the
-- tenant policies bind it. Migrations, the seed and cross-tenant jobs connect as the owner through `systemDb`.
-- A role belongs to the whole server, so this creates it only once, without a password: `pnpm db:migrate`
-- (src/db/app-role.ts) gives it LOGIN and the password in DATABASE_URL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ac_app') THEN
    CREATE ROLE ac_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO ac_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ac_app;
--> statement-breakpoint
-- USAGE for nextval, SELECT to read acl_version_seq's high-water mark for the audit (USAGE alone is refused).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ac_app;
--> statement-breakpoint
-- Tables and sequences later migrations create (as this same owner) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ac_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ac_app;
--> statement-breakpoint
-- FORCE makes the policies bind a table's owner too. A superuser still bypasses them; ac_app never does.
-- A new tenant table needs its own line here (src/db/rls.test.ts checks every one).
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_acl" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "document_blobs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "group_closure" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "group_members" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "principals" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "retrieval_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sync_state" FORCE ROW LEVEL SECURITY;
