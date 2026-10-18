CREATE TABLE "acl_audit" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "acl_audit_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"action" text NOT NULL,
	"document_id" uuid,
	"group_id" uuid,
	"member_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"acl_version" bigint,
	"sync_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "acl_audit_subject_check" CHECK (subject IN ('document', 'membership')),
	CONSTRAINT "acl_audit_action_check" CHECK ((subject = 'document' AND action IN ('stamp', 'clear') AND document_id IS NOT NULL)
        OR (subject = 'membership' AND action IN ('added', 'removed') AND group_id IS NOT NULL AND member_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "acl_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "directory_versions" (
	"tenant_id" uuid PRIMARY KEY,
	"version" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "directory_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ocr_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"page" integer NOT NULL,
	"confidence" double precision NOT NULL,
	"ocr_text" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"corrected_text" text,
	"reviewer_id" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ocr_reviews_document_id_document_version_page_key" UNIQUE("document_id","document_version","page"),
	CONSTRAINT "ocr_reviews_status_check" CHECK (status IN ('pending', 'accepted', 'corrected')),
	CONSTRAINT "ocr_reviews_corrected_check" CHECK ((status = 'corrected') = (corrected_text IS NOT NULL)),
	CONSTRAINT "ocr_reviews_reviewer_check" CHECK ((status = 'pending') = (reviewer_id IS NULL)),
	CONSTRAINT "ocr_reviews_page_check" CHECK (page >= 1)
);
--> statement-breakpoint
ALTER TABLE "ocr_reviews" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "class" text DEFAULT 'default' NOT NULL;--> statement-breakpoint
CREATE INDEX "acl_audit_document_idx" ON "acl_audit" ("document_id","id") WHERE document_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "acl_audit_group_idx" ON "acl_audit" ("group_id","id") WHERE group_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ocr_reviews_pending_idx" ON "ocr_reviews" ("created_at") WHERE status = 'pending';--> statement-breakpoint
ALTER TABLE "acl_audit" ADD CONSTRAINT "acl_audit_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "directory_versions" ADD CONSTRAINT "directory_versions_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "ocr_reviews" ADD CONSTRAINT "ocr_reviews_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "ocr_reviews" ADD CONSTRAINT "ocr_reviews_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id","document_id") REFERENCES "documents"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ocr_reviews" ADD CONSTRAINT "ocr_reviews_tenant_id_reviewer_id_fkey" FOREIGN KEY ("tenant_id","reviewer_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "acl_audit" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "directory_versions" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "ocr_reviews" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
-- Drizzle can't declare FORCE (see the app_role migration).
ALTER TABLE "acl_audit" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "directory_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ocr_reviews" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "directory_versions", "ocr_reviews" TO ac_app;--> statement-breakpoint
-- The audit is append-only for the app: it may add rows and read them, never change or remove one.
GRANT SELECT, INSERT ON "acl_audit" TO ac_app;--> statement-breakpoint
REVOKE UPDATE, DELETE, TRUNCATE ON "acl_audit" FROM ac_app;
