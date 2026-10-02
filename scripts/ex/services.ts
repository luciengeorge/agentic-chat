import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Run } from "./process";

import { ExError } from "./errors";
import { run as defaultRun } from "./process";

export const COMPOSE_FILE = "compose.yaml";
export const ENV_FILE = ".env.local";
// The processes that hold a published port on the host for a container.
const DOCKER_LISTENERS = ["orbstack", "com.docker", "docker", "vpnkit"];

export type ServiceStatus = { name: string; state: string; health: string | null };
export type Listener = { port: number; process: string; pid: number };

export async function compose(
  root: string,
  args: string[],
  { capture, run = defaultRun }: { capture: boolean; run?: Run },
): Promise<string> {
  if (!existsSync(join(root, COMPOSE_FILE))) throw new ExError(`${COMPOSE_FILE} is missing`);
  const result = await run("docker", ["compose", "-f", join(root, COMPOSE_FILE), ...args], { cwd: root, capture });
  if (result.code !== 0) {
    throw new ExError(`docker compose ${args.join(" ")} failed`, capture ? result.stderr.trim() || null : null);
  }
  return result.stdout;
}

/** `docker compose ps --format json`: one object per line (older Compose: one array). */
export function parsePs(output: string): ServiceStatus[] {
  const text = output.trim();
  if (!text) return [];
  const rows = (text.startsWith("[") ? JSON.parse(text) : text.split("\n").map((line) => JSON.parse(line))) as Record<
    string,
    unknown
  >[];
  return rows.map((row) => ({
    name: String(row.Service ?? ""),
    state: String(row.State ?? ""),
    health: row.Health ? String(row.Health) : null,
  }));
}

export async function status(root: string, run?: Run): Promise<ServiceStatus[]> {
  return parsePs(await compose(root, ["ps", "--all", "--format", "json"], { capture: true, run }));
}

/** Host port -> the Compose service that publishes it. */
export async function publishedPorts(root: string, run?: Run): Promise<Map<number, string>> {
  const config = JSON.parse(await compose(root, ["config", "--format", "json"], { capture: true, run })) as {
    services: Record<string, { ports?: { published?: string | number }[] }>;
  };
  const ports = new Map<number, string>();
  for (const [name, service] of Object.entries(config.services)) {
    for (const port of service.ports ?? []) if (port.published) ports.set(Number(port.published), name);
  }
  return ports;
}

/** `lsof -F pcn` output: `p<pid>` and `c<command>` per process, `n<addr>:<port>` per socket. */
export function parseLsof(output: string, ports: Set<number>): Listener[] {
  const found: Listener[] = [];
  let pid = 0;
  let command = "";
  for (const line of output.split("\n")) {
    const value = line.slice(1);
    if (line.startsWith("p")) pid = Number(value);
    else if (line.startsWith("c")) command = value;
    else if (line.startsWith("n")) {
      const port = Number(value.slice(value.lastIndexOf(":") + 1));
      if (ports.has(port) && !found.some((l) => l.port === port && l.pid === pid)) {
        found.push({ port, process: command, pid });
      }
    }
  }
  return found;
}

/** Who listens on these TCP ports. Empty when lsof isn't installed. */
export async function portListeners(ports: Set<number>, run: Run = defaultRun): Promise<Listener[]> {
  if (ports.size === 0) return [];
  const spec = [...ports].sort((a, b) => a - b).join(",");
  try {
    // lsof exits 1 when nothing matches.
    const result = await run("lsof", ["-nP", "+c", "0", "-sTCP:LISTEN", "-F", "pcn", `-iTCP:${spec}`], {
      cwd: process.cwd(),
      capture: true,
    });
    return parseLsof(result.stdout, ports);
  } catch (error) {
    if (error instanceof ExError) return [];
    throw error;
  }
}

/**
 * Fails before `compose up` if something other than Docker holds a port we publish. Docker would
 * fail too, but later and less clearly; a Postgres from Homebrew on 5432 can also answer in the
 * container's place.
 */
export async function preflight(
  root: string,
  { run, listeners = portListeners }: { run?: Run; listeners?: (ports: Set<number>) => Promise<Listener[]> } = {},
): Promise<void> {
  const ports = await publishedPorts(root, run);
  const clashes = (await listeners(new Set(ports.keys()))).filter(
    (listener) => !DOCKER_LISTENERS.some((name) => listener.process.toLowerCase().startsWith(name)),
  );
  if (clashes.length > 0) {
    throw new ExError(
      `ports already in use: ${clashes.map((c) => `${c.port} (${c.process})`).join(", ")}`,
      clashes.map((c) => ({ port: c.port, service: ports.get(c.port), process: c.process, pid: c.pid })),
    );
  }
}

async function packageScript(root: string, name: string, { capture, run }: { capture: boolean; run: Run }) {
  const result = await run("pnpm", ["--silent", name], { cwd: root, capture });
  if (result.code !== 0) {
    throw new ExError(`pnpm ${name} failed`, capture ? `${result.stdout}${result.stderr}`.trim() || null : null);
  }
  return result.stdout;
}

/**
 * `ex up`: ParadeDB in Compose, then the migrations and the seed through `pnpm db:migrate` and
 * `pnpm db:seed`, which read `.env.local`. Each step is safe to repeat. The app and fake-workspace
 * run on the host, started by hand.
 */
export async function up(
  root: string,
  {
    capture,
    run = defaultRun,
    listeners,
  }: { capture: boolean; run?: Run; listeners?: (ports: Set<number>) => Promise<Listener[]> },
): Promise<{ services: ServiceStatus[]; seed: string[] }> {
  if (!existsSync(join(root, ENV_FILE))) {
    throw new ExError(`${ENV_FILE} is missing`, `copy the dev values: cp .env.example ${ENV_FILE}`);
  }
  await preflight(root, { run, listeners });
  await compose(root, ["up", "--detach", "--wait"], { capture, run });
  await packageScript(root, "db:migrate", { capture, run });
  const seed = await packageScript(root, "db:seed", { capture, run });
  return { services: await status(root, run), seed: seed.split("\n").filter(Boolean) };
}
