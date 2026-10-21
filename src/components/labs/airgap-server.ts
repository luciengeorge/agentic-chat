/**
 * The air-gapped lab (section 21): where each model runs, the egress monitor switched on inside this server, and
 * the last `pnpm local:egress-check`. The monitor is `#learn/local/egress`, so it's the learner's code while step
 * 21.2 is active. Dev only: it changes this whole process, for every request.
 */
import { readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

import type { EgressGuard } from "#learn/local/egress";

import { type LocalConfig, localConfig, modelProvider } from "#learn/local/config";
import { EgressBlockedError, guardEgress, isLoopback } from "#learn/local/egress";

type Env = Record<string, string | undefined>;

export interface ModelRow {
  part: "Chat" | "Embeddings" | "Reranker";
  /** What the app built: a model id, an embedding version, a reranker name. */
  model: string;
  /** Where its calls go. */
  where: string;
  /** True when nothing it does leaves this machine. */
  local: boolean;
}

/** The app's models, by the names its own builders give them (`embedderFromEnv(...).version` and so on). */
export interface ModelNames {
  chat: string;
  embeddings: string;
  reranker: string;
}

/** Where each of the app's models runs, from what it built and how it's configured. */
export function modelRows(env: Env, names: ModelNames): ModelRow[] {
  const provider = modelProvider(env);
  const config = localConfig(env);
  const lmStudio = new URL(config.baseURL);
  const fake = { where: "this process: a fake, since no API key is set", local: true };
  const row = (part: ModelRow["part"], model: string, hosted: string): ModelRow => {
    if (model.startsWith("fake")) return { part, model, ...fake };
    if (provider === "hosted") return { part, model, where: hosted, local: false };
    if (part === "Reranker") return { part, model, where: `this process, from ${config.weightsDir}`, local: true };
    return { part, model, where: `LM Studio at ${lmStudio.host}`, local: isLoopback(lmStudio.hostname) };
  };
  return [
    row("Chat", names.chat, "api.openai.com"),
    row("Embeddings", names.embeddings, "api.openai.com"),
    row("Reranker", names.reranker, "api.cohere.com"),
  ];
}

export interface Attempt {
  host: string;
  port: number | null;
  at: string;
}

export interface MonitorStatus {
  on: boolean;
  since: string | null;
  /** Newest first, the last 50. */
  refused: Attempt[];
  refusedTotal: number;
  /** Each host:port let through, with how many connections. */
  allowed: { target: string; count: number }[];
}

type Monitor = { guard: EgressGuard; since: Date };
const MONITOR = Symbol.for("agentic-chat.airgap-monitor");
const slot = globalThis as Record<symbol, Monitor | undefined>;

export function monitorStatus(): MonitorStatus {
  const monitor = slot[MONITOR];
  if (!monitor) return { on: false, since: null, refused: [], refusedTotal: 0, allowed: [] };
  const counts = new Map<string, number>();
  for (const target of monitor.guard.allowed) counts.set(target, (counts.get(target) ?? 0) + 1);
  return {
    on: true,
    since: monitor.since.toISOString(),
    refused: monitor.guard.blocked
      .slice(-50)
      .reverse()
      .map((attempt) => ({ host: attempt.host, port: attempt.port, at: attempt.at.toISOString() })),
    refusedTotal: monitor.guard.blocked.length,
    allowed: [...counts].map(([target, count]) => ({ target, count })).sort((a, b) => b.count - a.count),
  };
}

/** Turns the monitor on in this process, once: a second call keeps the first. */
export function startMonitor(now = new Date()): MonitorStatus {
  slot[MONITOR] ??= { guard: guardEgress(), since: now };
  return monitorStatus();
}

export function stopMonitor(): MonitorStatus {
  slot[MONITOR]?.guard.restore();
  slot[MONITOR] = undefined;
  return monitorStatus();
}

export const PROBES = ["openai", "cohere", "huggingface", "lmstudio", "database"] as const;
export type ProbeName = (typeof PROBES)[number];

/** What each probe button dials: a TCP connection only, closed as soon as it's open. Nothing is sent. */
export function probeTarget(name: ProbeName, env: Env, config: LocalConfig = localConfig(env)) {
  if (name === "openai") return { host: "api.openai.com", port: 443 };
  if (name === "cohere") return { host: "api.cohere.com", port: 443 };
  if (name === "huggingface") return { host: "huggingface.co", port: 443 };
  const url = new URL(name === "lmstudio" ? config.baseURL : (env.DATABASE_URL ?? "postgres://localhost:5432/ac"));
  return { host: url.hostname, port: Number(url.port) || (name === "lmstudio" ? 80 : 5432) };
}

export interface ProbeResult {
  target: string;
  outcome: "connected" | "refused" | "failed";
  ms: number;
  detail: string;
}

/** Opens a TCP connection and closes it: through the monitor when it's on, like any of the app's clients. */
export function probe(host: string, port: number, timeoutMs = 3000): Promise<ProbeResult> {
  const started = performance.now();
  const target = `${host}:${port}`;
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (outcome: ProbeResult["outcome"], detail: string) => {
      clearTimeout(timer);
      socket.destroy();
      done({ target, outcome, ms: Math.round(performance.now() - started), detail });
    };
    const timer = setTimeout(() => finish("failed", `no answer in ${timeoutMs / 1000} s`), timeoutMs);
    socket.once("connect", () => finish("connected", "a TCP connection opened, and was closed at once"));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      error instanceof EgressBlockedError
        ? finish("refused", "refused by the egress monitor, before any DNS lookup")
        : finish("failed", error.code ?? error.message),
    );
  });
}

export interface EgressReport {
  file: string;
  date: string;
  network: { probe: string; target: string; reached: boolean; ms: number; detail: string }[];
  checks: { name: string; passed: boolean; detail: string }[];
  passed: boolean;
}

/** The newest `pnpm local:egress-check` report, or null when there's none. */
export function latestEgressReport(dir = join(process.cwd(), "fixtures/local/reports")): EgressReport | null {
  let files: string[];
  try {
    files = readdirSync(dir).filter((name) => name.endsWith("-egress.json"));
  } catch {
    return null;
  }
  const file = files.sort().at(-1);
  if (!file) return null;
  const report = JSON.parse(readFileSync(join(dir, file), "utf8")) as Omit<EgressReport, "file">;
  return { file, date: report.date, network: report.network, checks: report.checks, passed: report.passed };
}
