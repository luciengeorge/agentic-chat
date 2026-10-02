/** What every Graph route shares: bearer auth with faults, query and body parsing, keyset paging. */
import type { Context } from "hono";
import type { z } from "zod";

import type { Runtime } from "./app";

import { GraphError, badRequest, invalid, notReady } from "./errors";
import { type Site, type SortKey, compareKeys } from "./site";

export type Json = Record<string, unknown>;

const DEFAULT_PAGE = 20;
const MAX_PAGE = 200;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The site the bearer token opens. */
function tokenSite(rt: Runtime, authorization: string | undefined): string {
  if (!rt.workspace.loaded) throw notReady();
  const header = authorization ?? "";
  const space = header.indexOf(" ");
  const scheme = space < 0 ? header : header.slice(0, space);
  const token = space < 0 ? "" : header.slice(space + 1);
  const site = scheme.toLowerCase() === "bearer" ? rt.workspace.siteForToken(token) : null;
  if (site === null) {
    throw new GraphError(401, "InvalidAuthenticationToken", "Access token is empty or invalid.", {
      "WWW-Authenticate": "Bearer",
    });
  }
  return site;
}

/**
 * Applies the site's faults, then authorises again: an injected wait can outlast a reset, and the
 * request then answers as one arriving after it would.
 */
async function afterFaults(c: Context, rt: Runtime, site: string): Promise<string> {
  await rt.faults.apply(site, new URL(c.req.url).pathname);
  return tokenSite(rt, c.req.header("authorization"));
}

/** The `{site}` the route names, if the token opens it. */
export async function siteAccess(c: Context, rt: Runtime): Promise<Site> {
  const site = c.req.param("site")!;
  if (tokenSite(rt, c.req.header("authorization")) !== site) {
    throw new GraphError(403, "accessDenied", "The token can't open this site.");
  }
  return rt.workspace.sites.get(await afterFaults(c, rt, site))!;
}

/** The site the token opens, for the routes that don't name one. */
export async function subscriber(c: Context, rt: Runtime): Promise<string> {
  return afterFaults(c, rt, tokenSite(rt, c.req.header("authorization")));
}

/**
 * The JSON body. A route that looks up a site reads its body first, as FastAPI did: a reset during a
 * slow upload would otherwise leave the request holding the site the reset replaced.
 */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest("body: not valid JSON");
  }
}

export function parseBody<S extends z.ZodType>(schema: S, data: unknown): z.output<S> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw invalid(parsed.error, "body");
  return parsed.data;
}

export async function readBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  return parseBody(schema, await readJson(c));
}

/** The last value of a query parameter, as Starlette reads it. */
export function query(c: Context, name: string): string | undefined {
  return new URL(c.req.url).searchParams.getAll(name).at(-1);
}

/** `$top`: 20 by default, at most 200. */
export function top(c: Context): number {
  const raw = query(c, "$top");
  if (raw === undefined) return DEFAULT_PAGE;
  if (!/^\d+$/.test(raw)) throw badRequest("query.$top: Input should be a valid integer");
  const size = Number(raw);
  if (size < 1) throw badRequest("query.$top: Input should be greater than or equal to 1");
  return Math.min(size, MAX_PAGE);
}

/**
 * The request's URL with query parameters set, or removed with null. `$` stays literal, as in
 * Graph's links (`?$top=2&$skiptoken=...`).
 */
export function link(c: Context, changes: Record<string, string | null>): string {
  const url = new URL(c.req.url);
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) params.set(key, value);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const encode = (text: string) => encodeURIComponent(text).replaceAll("%24", "$");
  const search = [...params].map(([key, value]) => `${encode(key)}=${encode(value)}`).join("&");
  return `${url.origin}${url.pathname}${search ? `?${search}` : ""}`;
}

export function encodeToken(...parts: (string | number)[]): string {
  return Buffer.from(parts.join(".")).toString("base64url");
}

export function decodeToken(token: string): string {
  try {
    return utf8.decode(Buffer.from(token, "base64url"));
  } catch {
    throw badRequest("Invalid token.");
  }
}

/** The sort key a `$skiptoken` carries: the last entry already returned. */
function skipKey(skiptoken: string): SortKey {
  let key: unknown;
  try {
    key = JSON.parse(decodeToken(skiptoken));
  } catch {
    throw badRequest("Invalid $skiptoken.");
  }
  if (!Array.isArray(key) || key.length !== 2 || !key.every((part) => typeof part === "string")) {
    throw badRequest("Invalid $skiptoken.");
  }
  return [key[0], key[1]];
}

/**
 * A page of `entries` (sorted by `key`), and the link to the next. Paging is by key: the
 * `$skiptoken` holds the last entry returned, and the next page starts after it. An offset would
 * shift when an entry is deleted or added between pages, skipping or repeating one.
 */
export function keysetPage<T>(
  c: Context,
  entries: readonly T[],
  key: (entry: T) => SortKey,
  size: number,
): { page: T[]; nextLink?: string } {
  const skiptoken = query(c, "$skiptoken");
  let start = 0;
  if (skiptoken !== undefined) {
    const after = skipKey(skiptoken);
    start = entries.findIndex((entry) => compareKeys(key(entry), after) > 0);
    if (start < 0) start = entries.length;
  }
  const page = entries.slice(start, start + size);
  if (start + size >= entries.length) return { page };
  return { page, nextLink: link(c, { $skiptoken: encodeToken(JSON.stringify(key(page.at(-1)!))) }) };
}
