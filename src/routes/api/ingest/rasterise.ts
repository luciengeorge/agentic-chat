import { createFileRoute } from "@tanstack/react-router";

import { rasterisePage } from "@/lib/parse/rasterise.server";

import { handleRasterise } from "./-pages";

export const Route = createFileRoute("/api/ingest/rasterise")({
  server: { handlers: { POST: ({ request }) => handleRasterise(request, rasterisePage) } },
});
