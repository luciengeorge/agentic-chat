// @vitest-environment node
import { describe, expect, it } from "vitest";

import { inspectCassette } from "./models-inspect";

describe("inspectCassette", () => {
  it("reads the recorded answer into its 64 events, the client's 55, and the bill", async () => {
    const inspection = await inspectCassette("answer", 1024);
    expect(inspection).toMatchObject({ bytes: 28955, reads: 29, error: null });
    expect(inspection.events).toHaveLength(64);
    expect(inspection.events?.[12]).toMatchObject({ index: 13, type: "response.output_text.delta" });
    expect(inspection.chatEvents).toHaveLength(55);
    expect(inspection.billed).toEqual({ input: 598, output: 113, reasoning: 53 });
    expect(inspection.counted).toMatchObject({ total: 592, schema: 0 });
  });

  it("gives the same events at any read size", async () => {
    const whole = await inspectCassette("tool-call-1", 100_000);
    const tiny = await inspectCassette("tool-call-1", 7);
    expect(tiny.events).toEqual(whole.events);
    expect(tiny.chatEvents?.[0]).toMatchObject({
      type: "tool-call",
      json: expect.stringContaining("search_documents"),
    });
  });

  it("counts turn 2 of the tool call from its recorded body", async () => {
    const inspection = await inspectCassette("tool-call-2", 1024);
    expect(inspection.counted).toMatchObject({ instructions: 29, messages: 552, tools: 133, total: 714 });
    expect(inspection.billed?.input).toBe(721);
  });

  it("shows a JSON reply as it came, with the schema counted apart", async () => {
    const inspection = await inspectCassette("rewrite", 1024);
    expect(inspection.events).toBeNull();
    expect(inspection.response).toContain('"queries"');
    expect(inspection.counted).toMatchObject({ total: 129, schema: 65 });
    expect(inspection.billed).toEqual({ input: 183, output: 35, reasoning: 0 });
  });
});
