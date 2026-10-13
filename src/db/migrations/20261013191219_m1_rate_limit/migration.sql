CREATE TABLE "rate_limit_buckets" (
	"tenant_id" uuid,
	"user_id" uuid,
	"bucket" text,
	"tokens" double precision NOT NULL,
	"refilled_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_buckets_pkey" PRIMARY KEY("tenant_id","user_id","bucket"),
	CONSTRAINT "rate_limit_buckets_tokens_check" CHECK (tokens >= 0)
);
--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "rate_limit_buckets" ADD CONSTRAINT "rate_limit_buckets_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id","user_id") REFERENCES "principals"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "rate_limit_buckets" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Drizzle can't declare FORCE (see the app_role migration).
ALTER TABLE "rate_limit_buckets" FORCE ROW LEVEL SECURITY;
