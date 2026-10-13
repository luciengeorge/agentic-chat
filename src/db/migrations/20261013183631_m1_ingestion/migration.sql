CREATE TABLE "document_blobs" (
	"tenant_id" uuid,
	"sha256" text,
	"bytes" bytea NOT NULL,
	"size" integer NOT NULL,
	"mime_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_blobs_pkey" PRIMARY KEY("tenant_id","sha256"),
	CONSTRAINT "document_blobs_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "document_blobs_size_check" CHECK (size = octet_length(bytes))
);
--> statement-breakpoint
ALTER TABLE "document_blobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "claimed_by" text;--> statement-breakpoint
ALTER TABLE "outbox" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "subscription_id" text;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "client_state_hash" text;--> statement-breakpoint
ALTER TABLE "sync_state" ADD COLUMN "subscription_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "document_blobs" ADD CONSTRAINT "document_blobs_tenant_id_organization_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "organization"("id");--> statement-breakpoint
CREATE POLICY "tenant_isolation" ON "document_blobs" AS PERMISSIVE FOR ALL TO public USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);