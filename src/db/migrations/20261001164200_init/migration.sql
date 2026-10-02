CREATE SEQUENCE "public"."acl_version_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"document_version" integer NOT NULL,
	"ordinal" integer NOT NULL,
	"text" text NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"section" text,
	"token_count" integer NOT NULL,
	"embedding" vector(1536),
	"embedding_model_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chunks_document_id_document_version_ordinal_key" UNIQUE("document_id","document_version","ordinal"),
	CONSTRAINT "chunks_pages_check" CHECK ((page_start IS NULL) = (page_end IS NULL) AND (page_end IS NULL OR page_end >= page_start))
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_tenant_id_id_key" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_acl" (
	"tenant_id" uuid NOT NULL,
	"document_id" uuid,
	"principal_id" uuid,
	"effect" text NOT NULL,
	"acl_version" bigint NOT NULL,
	CONSTRAINT "document_acl_pkey" PRIMARY KEY("document_id","principal_id"),
	CONSTRAINT "document_acl_effect_check" CHECK (effect IN ('allow', 'deny'))
);
--> statement-breakpoint
ALTER TABLE "document_acl" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"title" text NOT NULL,
	"path" text NOT NULL,
	"mime_type" text NOT NULL,
	"version" integer NOT NULL,
	"source_version" text NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text,
	"status" text NOT NULL,
	"acl_version" bigint DEFAULT 0 NOT NULL,
	"valid_from" date,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "documents_tenant_id_source_external_id_key" UNIQUE("tenant_id","source","external_id"),
	CONSTRAINT "documents_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "documents_status_check" CHECK (status IN ('pending', 'ingesting', 'ready', 'failed', 'deleted'))
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_closure" (
	"tenant_id" uuid NOT NULL,
	"group_id" uuid,
	"member_id" uuid,
	"depth" integer NOT NULL,
	CONSTRAINT "group_closure_pkey" PRIMARY KEY("group_id","member_id"),
	CONSTRAINT "group_closure_depth_check" CHECK (depth >= 1),
	CONSTRAINT "group_closure_no_self_check" CHECK (group_id <> member_id)
);
--> statement-breakpoint
ALTER TABLE "group_closure" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "group_members" (
	"tenant_id" uuid NOT NULL,
	"group_id" uuid,
	"member_id" uuid,
	CONSTRAINT "group_members_pkey" PRIMARY KEY("group_id","member_id")
);
--> statement-breakpoint
ALTER TABLE "group_members" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_conversation_id_seq_key" UNIQUE("conversation_id","seq"),
	CONSTRAINT "messages_conversation_id_idempotency_key_key" UNIQUE("conversation_id","idempotency_key"),
	CONSTRAINT "messages_role_check" CHECK (role IN ('user', 'assistant', 'system', 'tool')),
	CONSTRAINT "messages_content_check" CHECK (jsonb_typeof(content) IN ('object', 'array'))
);
--> statement-breakpoint
ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"partition_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"failed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "outbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"enabled" boolean NOT NULL,
	"synced_at" timestamp with time zone NOT NULL,
	CONSTRAINT "principals_tenant_id_kind_external_id_key" UNIQUE("tenant_id","kind","external_id"),
	CONSTRAINT "principals_tenant_id_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "principals_kind_check" CHECK (kind IN ('user', 'group'))
);
--> statement-breakpoint
ALTER TABLE "principals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "retrieval_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"query_hash" text NOT NULL,
	"returned_ids" uuid[] NOT NULL,
	"denied_ids" uuid[] NOT NULL,
	"acl_version" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "retrieval_audit" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sync_state" (
	"tenant_id" uuid,
	"connector" text,
	"scope" text,
	"cursor" text,
	"delta_token" text,
	"last_full_crawl_at" timestamp with time zone,
	"last_delta_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sync_state_pkey" PRIMARY KEY("tenant_id","connector","scope")
);
--> statement-breakpoint
ALTER TABLE "sync_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "account" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"inviter_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"logo" text,
	"created_at" timestamp NOT NULL,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" text,
	"active_organization_id" text
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "conversations_user_idx" ON "conversations" ("user_id");--> statement-breakpoint
CREATE INDEX "document_acl_principal_idx" ON "document_acl" ("principal_id");--> statement-breakpoint
CREATE INDEX "group_members_member_idx" ON "group_members" ("member_id");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" ("created_at") WHERE published_at IS NULL AND failed_at IS NULL;--> statement-breakpoint
CREATE INDEX "retrieval_audit_user_idx" ON "retrieval_audit" ("user_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" ("organization_id");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_slug_uidx" ON "organization" ("slug");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id","document_id") REFERENCES "documents"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id","user_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "document_acl" ADD CONSTRAINT "document_acl_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "document_acl" ADD CONSTRAINT "document_acl_tenant_id_document_id_fkey" FOREIGN KEY ("tenant_id","document_id") REFERENCES "documents"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "document_acl" ADD CONSTRAINT "document_acl_tenant_id_principal_id_fkey" FOREIGN KEY ("tenant_id","principal_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "group_closure" ADD CONSTRAINT "group_closure_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "group_closure" ADD CONSTRAINT "group_closure_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id","group_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "group_closure" ADD CONSTRAINT "group_closure_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id","member_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_group_id_fkey" FOREIGN KEY ("tenant_id","group_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_tenant_id_member_id_fkey" FOREIGN KEY ("tenant_id","member_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_tenant_id_conversation_id_fkey" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "conversations"("tenant_id","id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "principals" ADD CONSTRAINT "principals_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "retrieval_audit" ADD CONSTRAINT "retrieval_audit_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "retrieval_audit" ADD CONSTRAINT "retrieval_audit_tenant_id_user_id_fkey" FOREIGN KEY ("tenant_id","user_id") REFERENCES "principals"("tenant_id","id");--> statement-breakpoint
ALTER TABLE "sync_state" ADD CONSTRAINT "sync_state_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fkey" FOREIGN KEY ("inviter_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "chunks" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "conversations" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_acl" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "documents" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "group_closure" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "group_members" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "messages" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "outbox" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "principals" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "retrieval_audit" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "sync_state" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);