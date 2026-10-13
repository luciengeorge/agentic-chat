import { createFileRoute } from "@tanstack/react-router";

import { ocrPng } from "@/lib/parse/ocr";

import { handleOcr } from "./-pages";

export const Route = createFileRoute("/api/ingest/ocr")({
  server: { handlers: { POST: ({ request }) => handleOcr(request, ocrPng) } },
});
