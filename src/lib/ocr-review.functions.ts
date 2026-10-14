/**
 * The OCR review queue's server functions (section 03.2), for the 03 lab and a reviewer's page. Each one runs
 * behind `viewerMiddleware`: the tenant and the reviewer come from the session, and a reviewer sees and decides only
 * pages of documents they can read. The rules are `#learn/parse/review`.
 */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { acceptOcrReview, correctOcrReview, listOcrReviews } from "#learn/parse/review";
import { withTenant } from "@/db/tenant";
import { scopeOf, viewerMiddleware } from "@/lib/middleware";

const MAX_PAGE_CHARS = 20_000;

/** Pending reviews by default, lowest confidence first; or the accepted or corrected ones. */
export const getOcrReviews = createServerFn({ method: "GET" })
  .middleware([viewerMiddleware])
  .validator(z.object({ status: z.enum(["pending", "accepted", "corrected"]).default("pending") }))
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    return withTenant(scope.tenantId, (tx) => listOcrReviews(tx, scope.userId, { status: data.status }));
  });

/** OCR read the page right: the review is closed and the chunks stay as they are. */
export const acceptOcrPage = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ reviewId: z.uuid() }))
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    const review = await withTenant(scope.tenantId, (tx) => acceptOcrReview(tx, scope.userId, data.reviewId));
    if (!review) throw new Error("No such review, or you can't read its document.");
    return review;
  });

/** The page really says `text`: its chunks are cut again from it, embedded and swapped in. */
export const correctOcrPage = createServerFn({ method: "POST" })
  .middleware([viewerMiddleware])
  .validator(z.object({ reviewId: z.uuid(), text: z.string().trim().min(1).max(MAX_PAGE_CHARS) }))
  .handler(async ({ context, data }) => {
    const scope = scopeOf(context.viewer);
    const { embedderFromEnv } = await import("@/lib/retrieval.server");
    const { rasterisePage } = await import("@/lib/parse/rasterise.server");
    const { ocrPng } = await import("@/lib/parse/ocr");
    const correction = await correctOcrReview(
      { withTenant, embedder: embedderFromEnv(), parseDeps: { rasterise: rasterisePage, ocr: ocrPng } },
      scope,
      data.reviewId,
      data.text,
    );
    if (!correction) throw new Error("No such review, or you can't read its document.");
    return {
      review: correction.review,
      pages: correction.pages,
      removed: correction.removed,
      added: correction.added,
    };
  });
