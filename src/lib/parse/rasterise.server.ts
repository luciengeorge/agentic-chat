import { renderPageAsImage } from "unpdf";

import type { Rasterise } from "#learn/parse/types";

/** 2x is 144 dpi: enough for tesseract on the corpus scans and handwriting, and faster than 3x. */
const SCALE = 2;

/**
 * Renders one PDF page to a PNG on a native canvas (@napi-rs/canvas). Native modules can't load in
 * a Workflow step on Vercel (workflow #1003), so steps reach this through a server route.
 */
export const rasterisePage: Rasterise = async (pdf, pageNumber) => {
  const png = await renderPageAsImage(new Uint8Array(pdf), pageNumber, {
    canvasImport: () => import("@napi-rs/canvas"),
    scale: SCALE,
  });
  return new Uint8Array(png);
};
