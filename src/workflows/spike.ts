import { createHook, getWritable, sleep } from "workflow";

import { formatGreeting } from "#learn/_sample/greeting";
import { createLogger } from "@/lib/logger";

const logger = createLogger("workflows.spike");

export type SpikeResume = { note: string };

export type SpikeEvent = { type: "chunk"; index: number; text: string };

export async function spikeWorkflow(token: string, sleepMs: number) {
  "use workflow";

  const { greeting } = await prepare();
  using hook = createHook<SpikeResume>({ token });
  const { note } = await hook;
  await sleep(sleepMs);
  const chunks = await streamChunks(note);

  return { greeting, note, chunks };
}

// The greeting shows which `#learn/_sample/greeting` the step bundle resolved (see docs/workflow-notes.md).
async function prepare() {
  "use step";

  const greeting = formatGreeting("step");
  logger.info("prepared", { greeting });
  return { greeting };
}
// The greeting is the learner's slotted code, which throws the same way every time until it's written: retrying
// only delays the failure.
prepare.maxRetries = 0;

async function streamChunks(note: string) {
  "use step";

  const texts = ["resumed", note, "done"];
  const writer = getWritable<SpikeEvent>().getWriter();
  for (const [index, text] of texts.entries()) {
    await writer.write({ type: "chunk", index, text });
  }
  await writer.close();
  logger.info("streamed", { chunks: texts.length });

  return texts.length;
}
