import type { ParseDeps } from "#learn/parse/types";

import { isInternal } from "@/workflows/ingest-internal";

/** The largest PDF the rasterise route takes: the 3,000-page filing is 7 MB. */
const MAX_PDF_BYTES = 64 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;

async function body(request: Request, type: string, max: number): Promise<Uint8Array | Response> {
  if (!isInternal(request)) return Response.json({ error: "forbidden" }, { status: 403 });
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== type) return Response.json({ error: `send the body as ${type}` }, { status: 415 });
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > max) return Response.json({ error: "too large" }, { status: 413 });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > max) return Response.json({ error: "too large" }, { status: 413 });
  return bytes;
}

/**
 * `POST /api/ingest/rasterise?page=N` with the PDF as the body: the page as a PNG. Steps call it because the
 * renderer is a native module, which a Workflow step can't load on Vercel (workflow #1003).
 */
export async function handleRasterise(request: Request, rasterise: ParseDeps["rasterise"]): Promise<Response> {
  const pdf = await body(request, "application/pdf", MAX_PDF_BYTES);
  if (pdf instanceof Response) return pdf;
  const page = Number(new URL(request.url).searchParams.get("page"));
  if (!Number.isInteger(page) || page < 1)
    return Response.json({ error: "page must be a positive integer" }, { status: 400 });
  try {
    const png = await rasterise(pdf, page);
    return new Response(Buffer.from(png), { headers: { "content-type": "image/png" } });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 422 });
  }
}

/** `POST /api/ingest/ocr` with a PNG as the body: its text and mean word confidence. */
export async function handleOcr(request: Request, ocr: ParseDeps["ocr"]): Promise<Response> {
  const png = await body(request, "image/png", MAX_PNG_BYTES);
  if (png instanceof Response) return png;
  return Response.json(await ocr(png));
}
