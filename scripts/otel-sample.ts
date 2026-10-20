/**
 * `pnpm otel:sample`: sends the traces and metrics of four chat turns to the collector, with no dev server, no
 * database and no model calls, to check the local stack end to end. Each turn replays a recorded one
 * (fixtures/cassettes/generate/): retrieval returns the chunks it returned then, and the model answers with the
 * recorded bytes through the AI SDK, so the AI SDK's own spans and the token and cost metrics are the real thing.
 *
 *   docker compose --profile observability up -d otel-lgtm
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm otel:sample
 *
 * Then open Grafana on http://localhost:3001, Explore, Tempo, and search for service `agentic-chat`.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { Retrieve, RetrievedChunk } from "#learn/retrieve/types";

import { answer } from "#learn/generate/answer";
import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL, CHAT_REASONING_EFFORT } from "#learn/model/config";
import { telemetryConfig } from "#learn/observability/config";
import { currentRequestCost } from "#learn/observability/metrics";
import { observeRequest } from "#learn/observability/request";
import { startTelemetry } from "#learn/observability/setup";
import { tracedRetrieve } from "#learn/observability/spans";

const TURNS = join(import.meta.dirname, "../fixtures/cassettes/generate");
const NAMES = ["brightwell", "invoice-hold", "london-hotel", "heron"];

function recorded(name: string) {
  const turn = JSON.parse(readFileSync(join(TURNS, `${name}.json`), "utf8")) as {
    user: string;
    question: string;
    rewritten: string[];
    chunks: RetrievedChunk[];
  };
  const sse = readFileSync(join(TURNS, `${name}.sse`), "utf8");
  const fetch = async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  const model = aiSdkChatModel(createOpenAI({ apiKey: "replay", fetch: fetch as typeof globalThis.fetch })(CHAT_MODEL));
  return { ...turn, model };
}

async function main() {
  const config = telemetryConfig();
  if (!config.enabled) {
    throw new Error(
      "set OTEL_EXPORTER_OTLP_ENDPOINT (http://localhost:4318 for `docker compose --profile observability up -d otel-lgtm`)",
    );
  }
  const telemetry = startTelemetry(config)!;
  for (const name of NAMES) {
    const turn = recorded(name);
    const retrieve: Retrieve = async (_viewer, query) => ({
      query,
      rewritten: turn.rewritten,
      chunks: turn.chunks.slice(0, 8),
      auditId: `sample-${name}`,
    });
    let traceId = "";
    let costUsd = 0;
    await observeRequest(
      telemetry,
      { route: "chat_turn", attributes: { "gen_ai.conversation.id": `sample-${name}`, "agentic_chat.sample": true } },
      async (span) => {
        traceId = span.spanContext().traceId;
        const retrieval = await tracedRetrieve(telemetry.tracer, retrieve)(
          { tenantId: "sample", userId: turn.user },
          turn.question,
        );
        for await (const _ of answer({
          question: turn.question,
          retrieval,
          model: turn.model,
          reasoningEffort: CHAT_REASONING_EFFORT,
        }));
        costUsd = currentRequestCost()?.usd ?? 0;
        return "complete";
      },
    );
    process.stdout.write(`${name.padEnd(14)} ${turn.user.padEnd(14)} trace ${traceId}  cost $${costUsd.toFixed(7)}\n`);
  }
  await telemetry.flush();
  await telemetry.shutdown();
  process.stdout.write(`sent to ${config.endpoint}; Grafana: http://localhost:3001 (Explore, Tempo)\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
