import { indexing, tokenizer } from "@paradedb/drizzle-paradedb";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bytea,
  check,
  date,
  doublePrecision,
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
  uniqueIndex,
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
    // Vector search (section 06): cosine, as the embeddings are compared by `<=>`.
    index("chunks_embedding_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
    // Lexical search (section 07). The text is split on Unicode word boundaries, stemmed and stripped of English
    // stopwords, so "KPC-2026-0142" becomes kpc, 2026, 0142. tenant_id and document_id ride along so the ACL
    // pre-filter (`document_id = ANY(...)`) and the RLS policy are answered inside the index.
    indexing
      .paradedbIndex("chunks_bm25_idx")
      .on(
        t.id,
        indexing.paradedbField(t.text, tokenizer.unicodeWords({ stemmer: "english", stopwords_language: "english" })),
        t.tenantId,
        t.documentId,
      ),
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

/** A token bucket per user and bucket name (section 11). `tokens` is what was left at `refilled_at`; a request
 * refills it for the time since, then spends one, in a single upsert. */
export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    bucket: text("bucket").notNull(),
    tokens: doublePrecision("tokens").notNull(),
    refilledAt: timestamp("refilled_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ name: "rate_limit_buckets_pkey", columns: [t.tenantId, t.userId, t.bucket] }),
    check("rate_limit_buckets_tokens_check", sql`tokens >= 0`),
    foreignKey({
      name: "rate_limit_buckets_tenant_id_user_id_fkey",
      columns: [t.tenantId, t.userId],
      foreignColumns: [principals.tenantId, principals.id],
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
);

/** An agent run (section 14). Its state is its event log, `run_events`; `status` and `version` are kept here so a
 * writer can check both in the statement that appends. `version` counts appends: a writer that read version n
 * appends only while it is still n. */
export const runs = pgTable(
  "runs",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    conversationId: uuid("conversation_id"),
    parentRunId: uuid("parent_run_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    version: integer("version").notNull().default(0),
    workflowRunId: text("workflow_run_id"),
    caps: jsonb("caps")
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Time spent running, in ms. Waiting on a message or an approval doesn't count. */
    activeMs: bigint("active_ms", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("runs_tenant_id_id_key").on(t.tenantId, t.id),
    check("runs_kind_check", sql`kind IN ('chat', 'automation', 'subagent')`),
    check(
      "runs_status_check",
      sql`status IN ('queued', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out')`,
    ),
    check("runs_caps_check", sql`jsonb_typeof(caps) = 'object'`),
    foreignKey({
      name: "runs_tenant_id_user_id_fkey",
      columns: [t.tenantId, t.userId],
      foreignColumns: [principals.tenantId, principals.id],
    }),
    foreignKey({
      name: "runs_tenant_id_conversation_id_fkey",
      columns: [t.tenantId, t.conversationId],
      foreignColumns: [conversations.tenantId, conversations.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "runs_tenant_id_parent_run_id_fkey",
      columns: [t.tenantId, t.parentRunId],
      foreignColumns: [t.tenantId, t.id],
    }).onDelete("cascade"),
    index("runs_user_idx").on(t.userId, t.createdAt),
    index("runs_conversation_idx").on(t.conversationId),
    index("runs_parent_idx").on(t.parentRunId),
    tenantIsolation(),
  ],
);

/** A run's append-only log. `seq` starts at 1 and has no gaps. `step_key` is the Workflow step that wrote the
 * event (section 15), so a replayed step can't write it twice; it's null for events written outside Workflow.
 * A user message's `messageId` is the client's idempotency key, unique per run. */
export const runEvents = pgTable(
  "run_events",
  {
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    seq: integer("seq").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    data: jsonb("data").notNull(),
    stepKey: text("step_key"),
  },
  (t) => [
    primaryKey({ name: "run_events_pkey", columns: [t.runId, t.seq] }),
    unique("run_events_run_id_step_key_key").on(t.runId, t.stepKey),
    uniqueIndex("run_events_run_id_message_id_key")
      .on(t.runId, sql`(data ->> 'messageId')`)
      .where(sql`type = 'user_message'`),
    check("run_events_seq_check", sql`seq >= 1`),
    check(
      "run_events_type_check",
      sql`type IN ('user_message', 'assistant_turn', 'tool_result', 'approval_requested', 'approval_decided', 'status', 'compaction', 'error')`,
    ),
    check("run_events_data_check", sql`jsonb_typeof(data) = 'object' AND data ->> 'type' = type`),
    foreignKey({
      name: "run_events_tenant_id_run_id_fkey",
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
);

/** A write tool call waiting on its user. The run's log has the same story as events; this row is what the
 * inbox lists and what a decision updates, once (`status` leaves `pending` only once). */
export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    tenantId: tenantId(),
    runId: uuid("run_id").notNull(),
    callId: text("call_id").notNull(),
    tool: text("tool").notNull(),
    input: jsonb("input").notNull(),
    status: text("status").notNull().default("pending"),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("approvals_run_id_call_id_key").on(t.runId, t.callId),
    check("approvals_status_check", sql`status IN ('pending', 'approved', 'rejected', 'expired')`),
    check("approvals_decided_check", sql`(status = 'pending') = (decided_at IS NULL)`),
    foreignKey({
      name: "approvals_tenant_id_run_id_fkey",
      columns: [t.tenantId, t.runId],
      foreignColumns: [runs.tenantId, runs.id],
    }).onDelete("cascade"),
    index("approvals_pending_idx")
      .on(t.expiresAt)
      .where(sql`status = 'pending'`),
    tenantIsolation(),
  ],
);

/** Short notes a user's runs keep about them (the `remember` tool), loaded when a run starts. `source_run_id` is
 * provenance only, so it has no foreign key: deleting a run keeps its notes. */
export const memoryNotes = pgTable(
  "memory_notes",
  {
    id: id(),
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    text: text("text").notNull(),
    sourceRunId: uuid("source_run_id"),
    createdAt: createdAt(),
  },
  (t) => [
    check("memory_notes_text_check", sql`char_length(text) BETWEEN 1 AND 500`),
    foreignKey({
      name: "memory_notes_tenant_id_user_id_fkey",
      columns: [t.tenantId, t.userId],
      foreignColumns: [principals.tenantId, principals.id],
    }).onDelete("cascade"),
    index("memory_notes_user_idx").on(t.userId, t.createdAt),
    tenantIsolation(),
  ],
);

/** A user's agent tokens for one UTC day (section 13): checked before each model turn, charged after it. */
export const agentBudgets = pgTable(
  "agent_budgets",
  {
    tenantId: tenantId(),
    userId: uuid("user_id").notNull(),
    day: date("day").notNull(),
    tokensUsed: bigint("tokens_used", { mode: "number" }).notNull().default(0),
    tokenLimit: bigint("token_limit", { mode: "number" }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ name: "agent_budgets_pkey", columns: [t.tenantId, t.userId, t.day] }),
    check("agent_budgets_tokens_check", sql`tokens_used >= 0 AND token_limit >= 0`),
    foreignKey({
      name: "agent_budgets_tenant_id_user_id_fkey",
      columns: [t.tenantId, t.userId],
      foreignColumns: [principals.tenantId, principals.id],
    }).onDelete("cascade"),
    tenantIsolation(),
  ],
);

/** The per-tenant agent kill switch (section 13). No row means enabled. */
export const agentSwitches = pgTable(
  "agent_switches",
  {
    tenantId: uuid("tenant_id")
      .primaryKey()
      .references(() => organization.id),
    enabled: boolean("enabled").notNull(),
    reason: text("reason"),
    /** The user who flipped it, or null for a script. */
    updatedBy: uuid("updated_by"),
    updatedAt: updatedAt(),
  },
  () => [tenantIsolation()],
);
