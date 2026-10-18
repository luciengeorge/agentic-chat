/**
 * What the sync and ingest steps share: the tenant's connector, settings, and turning errors into Workflow's retry
 * decisions. Only step files import this one. A workflow file must import nothing but steps: the workflow bundle
 * keeps every other export, and with it the database driver, which can't load in the workflow sandbox.
 */
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { FatalError } from "workflow";

import type { Connector } from "#learn/connectors/types";

import { createGraphClient, type GraphClient, graphConnector } from "#learn/connectors/graph";
import { stepError } from "#learn/queue/retry";
import { appDb } from "@/db/pool";
import { organization } from "@/db/schema";
import { acEnv } from "@/lib/env";

/** `sync_state.connector` for the drive. */
export const CONNECTOR = "workspace";

export const sha256Hex = (text: string) => createHash("sha256").update(text).digest("hex");

/** Where the drive and directory live. fake-workspace stands in for SharePoint and Entra ID. */
export function workspaceUrl(): string {
  return process.env.FAKE_WORKSPACE_URL || "http://localhost:8100";
}

/** The app's own origin, for the webhook's notification URL and the parse routes. */
export function appUrl(): string {
  return process.env.BETTER_AUTH_URL || "http://localhost:3000";
}

/**
 * A tenant's token for its site, whose name is the tenant's slug. `WORKSPACE_TOKEN_<SLUG>` when set; outside
 * prod, fake-workspace's public dev token.
 */
export function workspaceToken(slug: string): string {
  const token = process.env[`WORKSPACE_TOKEN_${slug.toUpperCase()}`];
  if (token) return token;
  if (acEnv() === "prod") throw new FatalError(`WORKSPACE_TOKEN_${slug.toUpperCase()} must be set`);
  return `dev-workspace-${slug}`;
}

export async function tenantSlug(tenantId: string): Promise<string> {
  const [row] = await appDb()
    .select({ slug: organization.slug })
    .from(organization)
    .where(eq(organization.id, tenantId));
  if (!row) throw new FatalError(`no tenant ${tenantId}`);
  return row.slug;
}

export async function graphFor(tenantId: string): Promise<GraphClient> {
  const slug = await tenantSlug(tenantId);
  // Throttling is retried inside the client first; past that, the step retries after Retry-After.
  return createGraphClient({ baseUrl: workspaceUrl(), site: slug, token: workspaceToken(slug), maxRetries: 3 });
}

/** The tenant's drive as a `Connector`: what drive sync, subscriptions and downloads use. */
export async function connectorFor(tenantId: string): Promise<Connector> {
  return graphConnector(await graphFor(tenantId));
}

/** How a sync starts the ingest runs it asks for: `INGEST_START`, `outbox` unless set (`ingest-start.ts` says when
 * to use which). */
export type IngestStart = "outbox" | "workflow-first";

export function ingestStart(env: Record<string, string | undefined> = process.env): IngestStart {
  return env.INGEST_START === "workflow-first" ? "workflow-first" : "outbox";
}

/** Runs a step's work, turning a connector's errors into Workflow's retry decisions (`stepError`). */
export async function asStep<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw stepError(error);
  }
}
