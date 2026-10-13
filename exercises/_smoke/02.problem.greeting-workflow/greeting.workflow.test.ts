import { describe, expect, it } from "vitest";
import { start } from "workflow/api";

import { greetingWorkflow } from "@/workflows/greeting";

describe("greetingWorkflow", () => {
  it("greets by name from inside a workflow step", async () => {
    const run = await start(greetingWorkflow, ["smoke"]);
    expect(await run.returnValue).toBe("hello smoke");
  });
});
