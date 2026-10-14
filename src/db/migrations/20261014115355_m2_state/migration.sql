CREATE TABLE "agent_budgets" (
	"tenant_id" uuid,
	"user_id" uuid,
	"day" date,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"token_limit" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_budgets_pkey" PRIMARY KEY("tenant_id","user_id","day"),
	CONSTRAINT "agent_budgets_tokens_check" CHECK (tokens_used >= 0 AND token_limit >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_budgets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "agent_switches" (
	"tenant_id" uuid PRIMARY KEY,
	"enabled" boolean NOT NULL,
	"reason" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_switches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"input" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_run_id_call_id_key" UNIQUE("run_id","call_id"),
	CONSTRAINT "approvals_status_check" CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
	CONSTRAINT "approvals_decided_check" CHECK ((status = 'pending') = (decided_at IS NULL))
);
--> statement-breakpoint
ALTER TABLE "approvals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "memory_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"text" text NOT NULL,
	"source_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_notes_text_check" CHECK (char_length(text) BETWEEN 1 AND 500)
);
--> statement-breakpoint
ALTER TABLE "memory_notes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "run_events" (
	"tenant_id" uuid NOT NULL,
	"run_id" uuid,
	"seq" integer,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"step_key" text,
	CONSTRAINT "run_events_pkey" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_events_run_id_step_key_key" UNIQUE("run_id","step_key"),
	CONSTRAINT "run_events_seq_check" CHECK (seq >= 1),
	CONSTRAINT "run_events_type_check" CHECK (type IN ('user_message', 'assistant_turn', 'tool_result', 'approval_requested', 'approval_decided', 'status', 'compaction', 'error')),
	CONSTRAINT "run_events_data_check" CHECK (jsonb_typeof(data) = 'object' AND data ->> 'type' = type)
);
--> statement-breakpoint
ALTER TABLE "run_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"parent_run_id" uuid,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"workflow_run_id" text,
	"caps" jsonb DEFAULT '{}' NOT NULL,
	"active_ms" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "runs_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "runs_kind_check" CHECK (kind IN ('chat', 'automation', 'subagent')),
	CONSTRAINT "runs_status_check" CHECK (status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out')),
	CONSTRAINT "runs_caps_check" CHECK (jsonb_typeof(caps) = 'object')
);
--> statement-breakpoint
ALTER TABLE "runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "approvals_pending_idx" ON "approvals" ("expires_at") WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX "memory_notes_user_idx" ON "memory_notes" ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_id_message_id_key" ON "run_events" ("run_id",(data ->> 'messageId')) WHERE type = 'user_message';--> statement-breakpoint
CREATE INDEX "runs_user_idx" ON "runs" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_conversation_idx" ON "runs" ("conversation_id");--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" ("parent_run_id");--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "agent_budgets" ADD CONSTRAINT "agent_budgets_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id","user_id") REFERENCES "principals"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "agent_switches" ADD CONSTRAINT "agent_switches_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id","run_id") REFERENCES "runs"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "memory_notes" ADD CONSTRAINT "memory_notes_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id","user_id") REFERENCES "principals"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_tenant_id_run_id_fkey" FOREIGN KEY ("tenant_id","run_id") REFERENCES "runs"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id","user_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "conversations"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_tenant_id_parent_run_id_fkey" FOREIGN KEY ("tenant_id","parent_run_id") REFERENCES "runs"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_budgets" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "agent_switches" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "approvals" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "memory_notes" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "run_events" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "runs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Drizzle can't declare FORCE (see the app_role migration). The default privileges already grant ac_app these
-- tables; the GRANT says so here too, for a database whose tables were made by another owner.
ALTER TABLE "runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "run_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approvals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memory_notes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_budgets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_switches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "runs", "run_events", "approvals", "memory_notes", "agent_budgets", "agent_switches" TO ac_app;
