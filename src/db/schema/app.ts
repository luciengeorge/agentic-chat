import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bytea,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgPolicy,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

import { organization } from "./auth";

// Tenants are better-auth organizations. Every table here is tenant data, with RLS enabled and, through the
// `app_role` migration, forced (Drizzle can't declare FORCE). The policy binds the app role `ac_app`, which neither
// owns the tables nor has BYPASSRLS. The owner `ac` is the image's superuser, so it still sees every row: only
// `systemDb` connects as it.
const tenantIsolation = () =>
  pgPolicy("tenant_isolation", {
    using: sql`tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid`,
  });

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => organization.id);

const id = () =>
  uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// `$onUpdate` runs only through the ORM: a raw UPDATE or an upsert must set updated_at itself.
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/** One counter for every tenant's ACL changes. Each change sets its document's `acl_version` (and
 * its `document_acl` rows) to `nextval`, so the values order changes across all documents. The cache
 * must stay 1: with a larger one each session draws from its own block, and values stop following
 * the order of the calls. */
export const aclVersionSeq = pgSequence("acl_version_seq", { cache: 1 });

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    partitionKey: text("partition_key").notNull(),
    createdAt: createdAt(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    /** Set once the relay gives up on the row (unknown kind, or out of attempts). */
    failedAt: timestamp("failed_at", { withTimezone: true }),
    /** The workflow run that claimed the row. The relay delivers at least once, so a second run finds it taken. */
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
  },
  (t) => [
    index("outbox_pending_idx")
      .on(t.createdAt)
      .where(sql`published_at IS NULL AND failed_at IS NULL`),
    tenantIsolation(),
  ],
);

/** A user or group mirrored from the tenant's directory. */
export const principals = pgTable(
  "principals",
  {
    id: id(),
    tenantId: tenantId(),
    kind: text("kind").notNull(),
    externalId: text("external_id").notNull(),
    /** The username for a user, the path for a group. */
    name: text("name").notNull(),
    displayName: text("display_name").notNull(),
    email: text("email"),
    enabled: boolean("enabled").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("principals_kind_check", sql`kind IN ('user', 'group')`),
    unique("principals_tenant_id_kind_external_id_key").on(t.tenantId, t.kind, t.externalId),
    // Tables that point at principals reference (tenant_id, id), so a row can't point into another
    // tenant. RLS can't catch that: FK checks bypass it.
    unique("principals_tenant_id_id_key").on(t.tenantId, t.id),
    tenantIsolation(),
  ],
);

/** A direct membership. The member is a user or a group. */
export const groupMembers = pgTable(
  "group_members",
  {
    tenantId: tenantId(),
    groupId: uuid("group_id").notNull(),
    memberId: uuid("member_id").notNull(),
  },
  (t) => [
    primaryKey({ name: "group_members_pkey", columns: [t.groupId, t.memberId] }),
    foreignKey({
      name: "group_members_tenant_id_group_id_fkey",
      columns: [t.tenantId, t.groupId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    foreignKey({
      name: "group_members_tenant_id_member_id_fkey",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    index("group_members_member_idx").on(t.memberId),
    tenantIsolation(),
  ],
);

/** Computed from `group_members`: every ancestor group with every descendant user and group. There
 * are no self rows, so `depth` is at least 1, and a cycle must be skipped when building it.
 *
 * Its member index, `(member_id, group_id) INCLUDE (tenant_id)`, is in a custom migration: Drizzle
 * can't declare INCLUDE. */
export const groupClosure = pgTable(
  "group_closure",
  {
    tenantId: tenantId(),
    groupId: uuid("group_id").notNull(),
    memberId: uuid("member_id").notNull(),
    depth: integer("depth").notNull(),
  },
  (t) => [
    primaryKey({ name: "group_closure_pkey", columns: [t.groupId, t.memberId] }),
    check("group_closure_depth_check", sql`depth >= 1`),
    check("group_closure_no_self_check", sql`group_id <> member_id`),
    foreignKey({
      name: "group_closure_tenant_id_group_id_fkey",
      columns: [t.tenantId, t.groupId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    foreignKey({
      name: "group_closure_tenant_id_member_id_fkey",
      columns: [t.tenantId, t.memberId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    tenantIsolation(),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: id(),
    tenantId: tenantId(),
    source: text("source").notNull(),
    externalId: text("external_id").notNull(),
    title: text("title").notNull(),
    path: text("path").notNull(),
    mimeType: text("mime_type").notNull(),
    version: integer("version").notNull(),
    sourceVersion: text("source_version").notNull(),
    contentHash: text("content_hash").notNull(),
    storageKey: text("storage_key"),
    status: text("status").notNull(),
    /** From `acl_version_seq` at the last ACL change; 0 until the document has an ACL. */
    aclVersion: bigint("acl_version", { mode: "number" }).notNull().default(0),
    validFrom: date("valid_from"),
    validTo: date("valid_to"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    check("documents_status_check", sql`status IN ('pending', 'ingesting', 'ready', 'failed', 'deleted')`),
    unique("documents_tenant_id_source_external_id_key").on(t.tenantId, t.source, t.externalId),
    unique("documents_tenant_id_id_key").on(t.tenantId, t.id),
    tenantIsolation(),
  ],
);

/** The only authorisation decision point. ACL copies next to the indexes only pre-filter recall. */
export const documentAcl = pgTable(
  "document_acl",
  {
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    principalId: uuid("principal_id").notNull(),
    effect: text("effect").notNull(),
    /** Its document's `acl_version` when the row was written. */
    aclVersion: bigint("acl_version", { mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ name: "document_acl_pkey", columns: [t.documentId, t.principalId] }),
    check("document_acl_effect_check", sql`effect IN ('allow', 'deny')`),
    foreignKey({
      name: "document_acl_tenant_id_document_id_fkey",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "document_acl_tenant_id_principal_id_fkey",
      columns: [t.tenantId, t.principalId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    index("document_acl_principal_idx").on(t.principalId),
    tenantIsolation(),
  ],
);

/** A document's raw bytes, content-addressed: `documents.storage_key` is the sha256 (hex). */
export const documentBlobs = pgTable(
  "document_blobs",
  {
    tenantId: tenantId(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    size: integer("size").notNull(),
    mimeType: text("mime_type").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: "document_blobs_pkey", columns: [t.tenantId, t.sha256] }),
    check("document_blobs_sha256_check", sql`sha256 ~ '^[0-9a-f]{64}$'`),
    check("document_blobs_size_check", sql`size = octet_length(bytes)`),
    tenantIsolation(),
  ],
);

export const chunks = pgTable(
  "chunks",
  {
    id: id(),
    tenantId: tenantId(),
    documentId: uuid("document_id").notNull(),
    documentVersion: integer("document_version").notNull(),
    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),
    /** Both pages or neither: md and docx have no pages. */
    pageStart: integer("page_start"),
    pageEnd: integer("page_end"),
    section: text("section"),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    embeddingModelVersion: text("embedding_model_version"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("chunks_document_id_document_version_ordinal_key").on(t.documentId, t.documentVersion, t.ordinal),
    check(
      "chunks_pages_check",
      sql`(page_start IS NULL) = (page_end IS NULL) AND (page_end IS NULL OR page_end >= page_start)`,
    ),
    foreignKey({
      name: "chunks_tenant_id_document_id_fkey",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [documents.tenantId, documents.id],
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
);

export const syncState = pgTable(
  "sync_state",
  {
    tenantId: tenantId(),
    connector: text("connector").notNull(),
    scope: text("scope").notNull(),
    cursor: text("cursor"),
    deltaToken: text("delta_token"),
    lastFullCrawlAt: timestamp("last_full_crawl_at", { withTimezone: true }),
    lastDeltaAt: timestamp("last_delta_at", { withTimezone: true }),
    /** The change-notification subscription, and a sha256 of the clientState it was created with. */
    subscriptionId: text("subscription_id"),
    clientStateHash: text("client_state_hash"),
    subscriptionExpiresAt: timestamp("subscription_expires_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ name: "sync_state_pkey", columns: [t.tenantId, t.connector, t.scope] }), tenantIsolation()],
);

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    title: text("title"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("conversations_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "conversations_tenant_id_user_id_fkey",
      columns: [t.tenantId, t.userId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    index("conversations_user_idx").on(t.userId),
    tenantIsolation(),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id").notNull(),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    /** Client-supplied, so a retried send can't add the message twice. NULLs never collide. */
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("messages_conversation_id_seq_key").on(t.conversationId, t.seq),
    unique("messages_conversation_id_idempotency_key_key").on(t.conversationId, t.idempotencyKey),
    check("messages_role_check", sql`role IN ('user', 'assistant', 'system', 'tool')`),
    // NOT NULL lets JSON null through.
    check("messages_content_check", sql`jsonb_typeof(content) IN ('object', 'array')`),
    foreignKey({
      name: "messages_tenant_id_conversation_id_fkey",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
);

export const retrievalAudit = pgTable(
  "retrieval_audit",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    queryHash: text("query_hash").notNull(),
    returnedIds: uuid("returned_ids").array().notNull(),
    deniedIds: uuid("denied_ids").array().notNull(),
    /** `acl_version_seq`'s high-water mark, read after the retrieval query in the same transaction:
     * `SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM acl_version_seq`. Read first under
     * READ COMMITTED, it's too low (docs/m0b-contract.md has the details). */
    aclVersion: bigint("acl_version", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: "retrieval_audit_tenant_id_user_id_fkey",
      columns: [t.tenantId, t.userId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    index("retrieval_audit_user_idx").on(t.userId),
    tenantIsolation(),
  ],
);
