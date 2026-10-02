import type { AddressInfo } from "node:net";
import type { Plugin, ViteDevServer } from "vite";

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export const LEARN_PREFIX = "#learn/";
export const REFERENCE_DIR = "src/core";
export const STATE_FILE = ".ex/state.json";
export const DEFAULT_SLOT_ROOT = "playground";
export const STEP_README = "README.md";

export const SECTION_DIR = /^(?<id>\d{2}|_[a-z0-9-]+)(?:\.(?<slug>[a-z0-9-]+))?$/;
export const STEP_DIR = /^(?<num>\d{2})\.(?<kind>problem|solution)\.(?<slug>[a-z0-9-]+)$/;
const STEP_ID = /^(?<section>\d{2}|_[a-z0-9-]+)\.(?<num>\d+)$/;
const MODULE = /^[\w-]+(?:\/[\w-]+)+$/;
const SLOT_FILE = /^[\w-][\w.-]*\.tsx?$/;
export const TEST_FILE = /\.test\.tsx?$/;

export type StepKind = "problem" | "solution";
type Env = Record<string, string | undefined>;

export class SlotError extends Error {
  override name = "SlotError";
}

export function readFrontmatter(path: string): Record<string, unknown> {
  const text = readFileSync(path, "utf8");
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end === -1) throw new SlotError(`${path}: frontmatter has no closing ---`);
  let data: unknown;
  try {
    data = parseYaml(text.slice(3, end));
  } catch (error) {
    throw new SlotError(`${path}: frontmatter isn't valid YAML: ${(error as Error).message}`);
  }
  if (data == null) return {};
  if (typeof data !== "object" || Array.isArray(data)) throw new SlotError(`${path}: frontmatter must be a mapping`);
  return data as Record<string, unknown>;
}

/** The step's slots, `<area>/<module>` -> the file name in the slot root. */
export function readSlots(readme: string): Record<string, string> {
  const slots = readFrontmatter(readme).slots;
  if (slots == null) return {};
  if (typeof slots !== "object" || Array.isArray(slots)) {
    throw new SlotError(`${readme}: slots must map modules to file names`);
  }
  for (const [module, file] of Object.entries(slots)) {
    if (!MODULE.test(module)) {
      throw new SlotError(`${readme}: slot "${module}" isn't a module under src/core, like search/bm25`);
    }
    if (typeof file !== "string" || !SLOT_FILE.test(file) || TEST_FILE.test(file)) {
      throw new SlotError(
        `${readme}: slot ${module} must name a flat .ts or .tsx file that isn't a test, like bm25.ts`,
      );
    }
  }
  return slots as Record<string, string>;
}

/** `09.2` -> `exercises/09.<slug>/02.<kind>.<slug>`. */
export function findStepDir(root: string, stepId: string, kind: StepKind = "problem"): string {
  const match = STEP_ID.exec(stepId)?.groups;
  if (!match) throw new SlotError(`bad step id "${stepId}"; expected <section>.<step>, like 09.2`);
  const exercises = join(root, "exercises");
  const sections = existsSync(exercises) ? readdirSync(exercises, { withFileTypes: true }) : [];
  for (const section of sections) {
    if (!section.isDirectory() || SECTION_DIR.exec(section.name)?.groups?.id !== match.section) continue;
    for (const step of readdirSync(join(exercises, section.name), { withFileTypes: true })) {
      const stepMatch = STEP_DIR.exec(step.name)?.groups;
      if (step.isDirectory() && stepMatch?.kind === kind && Number(stepMatch.num) === Number(match.num)) {
        return join(exercises, section.name, step.name);
      }
    }
  }
  throw new SlotError(`no ${kind} directory for step ${stepId}`);
}

/** `AC_ACTIVE_STEP`, else `active_step` in `.ex/state.json`, else none. */
export function readActiveStep(root: string, env: Env = process.env): string | null {
  if (env.AC_ACTIVE_STEP) return env.AC_ACTIVE_STEP;
  const path = join(root, STATE_FILE);
  if (!existsSync(path)) return null;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new SlotError(`${STATE_FILE} isn't valid JSON; \`pnpm ex start <step>\` rewrites it`);
  }
  const step = (data as { active_step?: unknown } | null)?.active_step;
  return typeof step === "string" && step ? step : null;
}

export type SlotResolver = {
  root: string;
  step: string | null;
  slotRoot: string;
  /** `<area>/<module>` -> the absolute path of the slotted file. */
  slots: ReadonlyMap<string, string>;
  /** The file a `#learn/...` id loads, or null for any other id. */
  resolve(id: string): string | null;
};

/**
 * Resolves the active step once. Its slots load from the slot root (`AC_SLOT_ROOT`, default
 * `playground/`); every other `#learn/<area>/<module>` loads `src/core/<area>/<module>.ts`.
 */
export function createSlotResolver({ root, env = process.env }: { root: string; env?: Env }): SlotResolver {
  const step = readActiveStep(root, env);
  const slotRoot = resolve(root, env.AC_SLOT_ROOT || DEFAULT_SLOT_ROOT);
  const slots = new Map<string, string>();
  if (step) {
    const readme = join(findStepDir(root, step), STEP_README);
    for (const [module, file] of Object.entries(readSlots(readme))) slots.set(module, join(slotRoot, file));
  }
  const show = (path: string) => {
    const rel = relative(root, path);
    return rel.startsWith("..") || isAbsolute(rel) ? path : rel;
  };

  return {
    root,
    step,
    slotRoot,
    slots,
    resolve(id) {
      if (!id.startsWith(LEARN_PREFIX)) return null;
      const module = id.slice(LEARN_PREFIX.length);
      if (!MODULE.test(module)) throw new SlotError(`bad import "${id}"; expected #learn/<area>/<module>`);
      const slotted = slots.get(module);
      if (slotted !== undefined) {
        if (!existsSync(slotted)) {
          throw new SlotError(
            `step ${step} slots ${id} to ${show(slotted)}, which doesn't exist; ` +
              `run \`pnpm ex start ${step}\` or \`pnpm ex reset ${step}\``,
          );
        }
        return slotted;
      }
      const reference = join(root, REFERENCE_DIR, `${module}.ts`);
      if (!existsSync(reference)) throw new SlotError(`${id} has no reference module at ${show(reference)}`);
      return reference;
    },
  };
}

/**
 * Resolves `#learn/*` imports through the active step's slots (see PLAN.md, "Slots"). Put it before
 * vite-tsconfig-paths, which would otherwise map `#learn/*` to the reference first.
 *
 * The step is read once, when the config resolves, so the dev server has to restart to change it.
 * `pnpm ex` pauses the server while it switches the slotted code and restarts it after (see
 * `switchControl`). The server also restarts itself when `.ex/state.json` names a different step,
 * and when a slotted file changes: Workflow bundles step code outside Vite and rebuilds it only on
 * a restart, so an edit would otherwise reach the app but not its workflow steps.
 */
export function learnSlots(options: { env?: Env } = {}): Plugin {
  const env = options.env ?? process.env;
  let resolver: SlotResolver;

  return {
    name: "agentic-chat:learn-slots",
    enforce: "pre",
    configResolved(config) {
      resolver = createSlotResolver({ root: config.root, env });
      for (const [module, file] of resolver.slots) {
        config.logger.info(`learn-slots: ${resolver.step} slots #learn/${module} to ${relative(config.root, file)}`);
      }
    },
    resolveId(id) {
      return resolver.resolve(id);
    },
    configureServer(server) {
      if (server.config.mode === "test") return;
      const restart = () => restartServer(server, resolver.slotRoot);
      const control = switchControl(server, resolver.root, restart);
      const state = join(resolver.root, STATE_FILE);
      const slotted = new Set(resolver.slots.values());
      const onChange = (file: string) => {
        const path = resolve(file);
        // A switch in progress restarts the server when it ends.
        if (control.switching()) return;
        if (slotted.has(path)) {
          server.config.logger.info(`learn-slots: ${relative(resolver.root, path)} changed; restarting`, {
            timestamp: true,
          });
          void restart();
          return;
        }
        if (path !== state) return;
        let next: string | null | undefined;
        try {
          next = readActiveStep(resolver.root, env);
        } catch {
          next = undefined; // restart anyway, so the error shows
        }
        if (next === resolver.step) return;
        server.config.logger.info(`learn-slots: active step is now ${next ?? "none"}; restarting`, { timestamp: true });
        void restart();
      };
      server.watcher.add([state, ...slotted]);
      server.watcher.on("add", onChange).on("change", onChange).on("unlink", onChange);
    },
  };
}

/** The slice of esbuild's plugin API this uses, so the plugin needs no esbuild dependency. */
export type EsbuildPlugin = {
  name: string;
  setup(build: {
    onResolve(options: { filter: RegExp }, callback: (args: { path: string }) => { path: string } | undefined): void;
  }): void;
};

/**
 * `learnSlots` for esbuild. Workflow bundles its workflow and step files with esbuild, outside Vite,
 * so the dev server resolves `#learn/*` in those files through this. Each build context resolves the
 * active step once, when it's set up.
 */
export function learnSlotsEsbuild(options: { root: string; env?: Env }): EsbuildPlugin {
  return {
    name: "agentic-chat:learn-slots",
    setup(build) {
      const resolver = createSlotResolver(options);
      build.onResolve({ filter: /^#learn\// }, (args) => {
        const path = resolver.resolve(args.path);
        return path === null ? undefined : { path };
      });
    },
  };
}

/** The slot root's files and their contents, as one string to compare. */
function readSlotRoot(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${entry.name}\0${readFileSync(join(dir, entry.name), "utf8")}`)
    .sort()
    .join("\0");
}

/**
 * Restarts the dev server, then again for as long as the slot root changed meanwhile. An edit that
 * lands mid-restart reaches neither watcher: the old one ignores it, and the new one isn't
 * listening yet. Workflow may already have bundled the steps without it.
 */
async function restartServer(server: ViteDevServer, slotRoot: string): Promise<void> {
  let before = readSlotRoot(slotRoot);
  for (;;) {
    await server.restart();
    const after = readSlotRoot(slotRoot);
    if (after === before) return;
    before = after;
  }
}

export const DEV_SERVER_FILE = ".ex/dev-server.json";
export const CONTROL_PATH = "/__ex";

/** What a running dev server writes to `.ex/dev-server.json`, so `pnpm ex` can find and pause it. */
export type DevServerEntry = { pid: number; url: string; token: string };

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readDevServerEntry(root: string): DevServerEntry | null {
  try {
    const entry = JSON.parse(readFileSync(join(root, DEV_SERVER_FILE), "utf8")) as Partial<DevServerEntry>;
    const { pid, url, token } = entry;
    return typeof pid === "number" && typeof url === "string" && typeof token === "string" ? { pid, url, token } : null;
  } catch {
    return null;
  }
}

/**
 * Lets `pnpm ex` stop the dev server taking work while it switches the slotted code, then restart it
 * on the new code (scripts/ex/switch.ts). `POST /__ex/pause` answers every other request with a 503,
 * new workflow runs and the local world's deliveries included, until `POST /__ex/resume` restarts the
 * server. Both need the token from `.ex/dev-server.json`. If the paused `ex` dies, the next request
 * lifts the pause.
 */
function switchControl(server: ViteDevServer, root: string, restart: () => Promise<void>): { switching(): boolean } {
  const token = randomUUID();
  const registry = join(root, DEV_SERVER_FILE);
  let pausedBy: number | null = null;
  let restarting = false;
  const log = (message: string) => server.config.logger.info(`learn-slots: ${message}`, { timestamp: true });

  const endSwitch = () => {
    pausedBy = null;
    restarting = true;
    // On success this instance is gone; on failure Vite keeps it, so let it watch again.
    void restart().finally(() => (restarting = false));
  };

  server.middlewares.use((req, res, next) => {
    const send = (status: number, body = "") => {
      res.statusCode = status;
      res.end(body);
    };
    if (req.url?.startsWith(`${CONTROL_PATH}/`)) {
      if (req.method !== "POST" || req.headers["x-ex-token"] !== token) return send(403);
      if (req.url === `${CONTROL_PATH}/pause`) {
        const pid = Number(req.headers["x-ex-pid"]);
        if (!Number.isInteger(pid) || pid <= 0) return send(400, "x-ex-pid must be the pid of `pnpm ex`\n");
        pausedBy = pid;
        log("paused while `pnpm ex` switches steps");
        return send(200);
      }
      if (req.url === `${CONTROL_PATH}/resume`) {
        log("switch done; restarting");
        res.once("finish", endSwitch);
        return send(202);
      }
      return send(404);
    }
    if (pausedBy !== null && !isAlive(pausedBy)) {
      log("`pnpm ex` exited mid-switch; restarting");
      endSwitch();
    }
    if (pausedBy === null) return next();
    res.setHeader("retry-after", "1");
    send(503, "switching steps; retry in a moment\n");
  });

  const { httpServer } = server;
  httpServer?.once("listening", () => {
    const { port } = httpServer.address() as AddressInfo;
    const entry: DevServerEntry = { pid: process.pid, url: `http://localhost:${port}`, token };
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(registry, `${JSON.stringify(entry, null, 2)}\n`);
  });
  httpServer?.once("close", () => {
    if (readDevServerEntry(root)?.token === token) rmSync(registry, { force: true });
  });

  return { switching: () => pausedBy !== null || restarting };
}
