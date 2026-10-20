/**
 * The observability lab (section 19): the four recorded chat turns of section 10 priced through
 * `#learn/observability/prices` and `#learn/observability/ledger`, the learner's code while a section 19 step is
 * active, alone and with the Cohere search a production turn adds; and whether the local Grafana is up. Each turn's
 * usage is what OpenAI reported when it was recorded, so nothing here calls a model.
 */
import { CHAT_MODEL } from "#learn/model/config";
import { telemetryConfig } from "#learn/observability/config";
import { chargeRequest, withRequestCost } from "#learn/observability/ledger";
import { costOf, PRICES, type TokenUsage } from "#learn/observability/prices";
import { recordedTurn, TURN_NAMES, type TurnName } from "@/core/generate/recorded";
import { COHERE_RERANK_MODEL } from "@/lib/retrieval.server";

import { type Part, part } from "./evals-server";

export const GRAFANA_URL = "http://localhost:3001";

/** The usage OpenAI reported at the end of a recorded turn's stream. */
export function recordedTurnUsage(name: TurnName): Required<TokenUsage> {
  const completed = recordedTurn(name)
    .sse.split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; response?: { usage?: Record<string, unknown> } })
    .find((event) => event.type === "response.completed");
  const usage = completed?.response?.usage ?? {};
  const details = usage.input_tokens_details as { cached_tokens?: number } | undefined;
  return {
    inputTokens: Number(usage.input_tokens ?? 0),
    cachedInputTokens: details?.cached_tokens ?? 0,
    outputTokens: Number(usage.output_tokens ?? 0),
  };
}

export interface PricedCall extends TokenUsage {
  modelId: string;
  usd: number;
  priced: boolean;
}

export interface PricedTurn {
  name: TurnName;
  user: string;
  question: string;
  calls: PricedCall[];
  /** The ledger's total for the answer alone, and with one Cohere search. */
  answerUsd: number;
  withRerankUsd: number;
  unpriced: string[];
}

/** One request's calls, charged to a ledger of their own, as the app's integration charges them. */
async function request(calls: Array<TokenUsage & { modelId: string }>) {
  const priced = calls.map((call) => ({ ...call, ...costOf(call.modelId, call) }));
  const { cost } = await withRequestCost(async () => {
    for (const call of priced) chargeRequest(call, call);
  });
  return { priced, cost };
}

export async function priceTurn(name: TurnName): Promise<PricedTurn> {
  const turn = recordedTurn(name);
  const answer = { modelId: CHAT_MODEL, ...recordedTurnUsage(name) };
  const alone = await request([answer]);
  const reranked = await request([{ modelId: COHERE_RERANK_MODEL }, answer]);
  return {
    name,
    user: turn.user,
    question: turn.question,
    calls: reranked.priced,
    answerUsd: alone.cost.usd,
    withRerankUsd: reranked.cost.usd,
    unpriced: reranked.cost.unpriced,
  };
}

export interface ObservabilityLab {
  turns: Part<PricedTurn[]>;
  prices: typeof PRICES;
  /** Whether this server sends its own spans and metrics, and where. */
  exporting: { enabled: boolean; endpoint: string | null };
  grafana: { url: string; up: boolean };
}

async function grafanaUp(fetcher: typeof fetch): Promise<boolean> {
  try {
    const response = await fetcher(`${GRAFANA_URL}/api/health`, { signal: AbortSignal.timeout(800) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function observabilityLab(fetcher: typeof fetch = fetch): Promise<ObservabilityLab> {
  const config = telemetryConfig();
  const [turns, up] = await Promise.all([part(() => Promise.all(TURN_NAMES.map(priceTurn))), grafanaUp(fetcher)]);
  return {
    turns,
    prices: PRICES,
    exporting: { enabled: config.enabled, endpoint: config.endpoint },
    grafana: { url: GRAFANA_URL, up },
  };
}
