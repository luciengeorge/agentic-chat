import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The same coverage check as the chat boundary's (middleware.test.ts), for the review queue's functions.
describe("the OCR review functions", () => {
  const source = readFileSync(join(import.meta.dirname, "ocr-review.functions.ts"), "utf8");

  it("put every server function behind the viewer middleware", () => {
    const serverFns = source.match(/createServerFn\([^)]*\)\s*\.\w+\([^)]*\)/g) ?? [];
    expect(serverFns).toHaveLength(3);
    for (const call of serverFns) expect(call).toMatch(/\.middleware\(\[viewerMiddleware\]\)$/);
  });

  it("never take a tenant or reviewer id from the request", () => {
    expect(source).not.toMatch(/(tenantId|userId|reviewerId|tenant_id|user_id):\s*z\./);
  });
});
