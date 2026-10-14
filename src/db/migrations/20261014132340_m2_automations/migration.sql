CREATE TABLE "automation_fires" (
	"tenant_id" uuid NOT NULL,
	"automation_id" uuid,
	"fire_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automation_fires_pkey" PRIMARY KEY("automation_id","fire_key")
);
--> statement-breakpoint
ALTER TABLE "automation_fires" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"prompt" text NOT NULL,
	"trigger" text NOT NULL,
	"cron" text,
	"folder" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone,
	"last_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "automations_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "automations_trigger_check" CHECK (trigger IN ('schedule', 'drive_change')),
	CONSTRAINT "automations_cron_check" CHECK ((trigger = 'schedule') = (cron IS NOT NULL)),
	CONSTRAINT "automations_folder_check" CHECK (trigger <> 'drive_change' OR folder IS NOT NULL),
	CONSTRAINT "automations_name_check" CHECK (char_length(name) BETWEEN 1 AND 100),
	CONSTRAINT "automations_prompt_check" CHECK (char_length(prompt) BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "automations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
CREATE INDEX "automations_owner_idx" ON "automations" ("owner_id","created_at");--> statement-breakpoint
CREATE INDEX "automations_enabled_idx" ON "automations" ("trigger") WHERE enabled;--> statement-breakpoint
CREATE INDEX "runs_automation_idx" ON "runs" ("automation_id","created_at");--> statement-breakpoint
ALTER TABLE "automation_fires" ADD CONSTRAINT "automation_fires_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "automation_fires" ADD CONSTRAINT "automation_fires_tenant_id_automation_id_fkey" FOREIGN KEY ("tenant_id","automation_id") REFERENCES "automations"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_tenant_id_owner_id_fkey" FOREIGN KEY ("tenant_id","owner_id") REFERENCES "principals"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automation_fires" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "automations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Drizzle can't declare FORCE (see the app_role migration). The GRANT is for a database whose tables were made by
-- another owner; the default privileges already cover this one.
ALTER TABLE "automations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "automation_fires" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "automations", "automation_fires" TO ac_app;
