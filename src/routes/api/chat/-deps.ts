import { createOpenAI } from "@ai-sdk/openai";

import type { ChatModel } from "#learn/model/types";

import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL, CHAT_REASONING_EFFORT } from "#learn/model/config";
import { echoModel } from "#learn/model/fake";
import { appDb } from "@/db/pool";
import { acEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { chatObserver, observedRetrieve } from "@/lib/observability.server";
import { CHAT_BUCKET } from "@/lib/rate-limit";
import { retrieve } from "@/lib/retrieval.server";

import type { ChatDeps } from "./-chat";

const logger = createLogger("chat");

type Env = Record<string, string | undefined>;

let cached: ChatModel | undefined;

/** gpt-6-luna through the AI SDK when OPENAI_API_KEY is set. Dev without a key gets the echo fake, so the app
 * runs end to end; production without one refuses. Tests never get here: they pass their own deps. */
export function chatModelFromEnv(env: Env = process.env): ChatModel {
  if (cached) return cached;
  if (env.OPENAI_API_KEY) {
    cached = aiSdkChatModel(createOpenAI({ apiKey: env.OPENAI_API_KEY })(CHAT_MODEL));
  } else if (acEnv(env) === "prod") {
    throw new Error("OPENAI_API_KEY must be set to answer in production");
  } else {
    logger.warn("no OPENAI_API_KEY: chat answers with the echo fake");
    cached = echoModel();
  }
  return cached;
}

export function chatDeps(): ChatDeps {
  return {
    db: appDb(),
    retrieve: observedRetrieve(retrieve),
    model: chatModelFromEnv(),
    reasoningEffort: CHAT_REASONING_EFFORT,
    bucket: CHAT_BUCKET,
    maxOutputTokens: 2000,
    observe: chatObserver(),
  };
}
