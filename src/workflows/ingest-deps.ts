/** What ingest steps use besides the database: the page routes, and how chunk ordinals are laid out. */
import { FatalError } from "workflow";

import type { ParseDeps } from "#learn/parse/types";

import { DEFAULT_OCR_REVIEW_THRESHOLD } from "#learn/parse/review";

import { INTERNAL_HEADER, internalToken } from "./ingest-internal";
import { appUrl } from "./sync-common";

/** Chunk ordinals per page range: a range's chunks are numbered from `index * ORDINALS_PER_RANGE`. */
export const ORDINALS_PER_RANGE = 100_000;

/** OCR'd pages under this mean confidence are queued for review: `OCR_REVIEW_THRESHOLD` (0 turns it off), else
 * `DEFAULT_OCR_REVIEW_THRESHOLD`. */
export function ocrReviewThreshold(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.OCR_REVIEW_THRESHOLD);
  return env.OCR_REVIEW_THRESHOLD && Number.isFinite(value) ? value : DEFAULT_OCR_REVIEW_THRESHOLD;
}

/** A page route didn't answer: worth a retry, unlike a parse that failed on the bytes themselves. */
export class PageRouteError extends Error {
  override name = "PageRouteError";
}

async function postBytes(path: string, bytes: Uint8Array, type: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${appUrl()}${path}`, {
      method: "POST",
      headers: { "content-type": type, [INTERNAL_HEADER]: internalToken() },
      body: Buffer.from(bytes),
    });
  } catch (error) {
    throw new PageRouteError(`${path}: ${(error as Error).message}`);
  }
  if (response.status === 422) throw new FatalError(`${path}: ${await response.text()}`);
  if (!response.ok) throw new PageRouteError(`${path} answered ${response.status}: ${await response.text()}`);
  return response;
}

/** Rasterising and OCR run in the app's server routes: the renderer is native, and OCR runs a worker. */
export const pageRouteDeps: ParseDeps = {
  rasterise: async (pdf, page) =>
    new Uint8Array(await (await postBytes(`/api/ingest/rasterise?page=${page}`, pdf, "application/pdf")).arrayBuffer()),
  ocr: async (png) => (await postBytes("/api/ingest/ocr", png, "image/png")).json(),
};
