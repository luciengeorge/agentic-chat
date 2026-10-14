CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"queue" text NOT NULL,
	"key" text,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_state_check" CHECK (state IN ('queued', 'running', 'done', 'dead')),
	CONSTRAINT "jobs_payload_check" CHECK (jsonb_typeof(payload) = 'object'),
	CONSTRAINT "jobs_attempts_check" CHECK (attempts >= 0 AND max_attempts >= 1),
	CONSTRAINT "jobs_lease_check" CHECK ((state = 'running') = (locked_until IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "jobs_queued_idx" ON "jobs" ("queue","run_at") WHERE state = 'queued';--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" ("queue","locked_until") WHERE state = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_queued_key_idx" ON "jobs" ("queue","key") WHERE state = 'queued' AND key IS NOT NULL;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "jobs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Drizzle can't declare FORCE (see the app_role migration). Workers claim across tenants on the owner (systemDb);
-- the app role enqueues inside its tenant.
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "jobs" TO ac_app;
