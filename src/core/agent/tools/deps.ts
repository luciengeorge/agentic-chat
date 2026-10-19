import { sql } from "drizzle-orm";

import type { WorkspaceWriter } from "#learn/agent/tools/workspace";
import type { Retrieve } from "#learn/retrieve/types";
import type { Tx } from "@/db/tenant";

import { canRead } from "#learn/retrieve/acl";

/** What the tools need from the app. Every one of them acts as `ctx.viewer`, never as a service account. */
export interface ToolDeps {
  /** Runs `fn` in a transaction scoped to the tenant (`withTenant` in the app). */
  withTenant: <T>(tenantId: string, fn: (tx: Tx) => Promise<T>) => Promise<T>;
  retrieve: Retrieve;
  /** The tenant's Graph writer (mail and sharing). */
  workspace: (tenantId: string) => Promise<WorkspaceWriter>;
}

export type ReadableDocument = {
  id: string;
  title: string;
  path: string;
  version: number;
  /** The drive item's id. */
  externalId: string;
};

/**
 * The document, if the user may read it now (`canRead`: Postgres decides), else null. A missing document and a
 * forbidden one look the same, so a tool's answer never says that something exists.
 */
export async function readableDocument(tx: Tx, userId: string, documentId: string): Promise<ReadableDocument | null> {
  if (!(await canRead(tx, userId, documentId))) return null;
  const [row] = await tx.execute<ReadableDocument>(sql`
    SELECT id, title, path, version, external_id AS "externalId" FROM documents WHERE id = ${documentId}`);
  return row ?? null;
}

export const notReadable = (documentId: string) => new Error(`No document ${documentId} that you can read.`);
