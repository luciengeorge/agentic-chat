import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Plugin, ViteDevServer } from "vite";

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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

/** The `AC_ACTIVE_STEP` that means no step, whatever `.ex/state.json` says. The app's own tests set it. */
export const NO_STEP = "none";

/** `AC_ACTIVE_STEP` (`none` for no step), else `active_step` in `.ex/state.json`, else none. */
export function readActiveStep(root: string, env: Env = process.env): string | null {
  if (env.AC_ACTIVE_STEP === NO_STEP) return null;
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
export function learnSlots(options: { env?: Env; drainMs?: number } = {}): Plugin {
  const env = options.env ?? process.env;
  let resolver: SlotResolver;
  // Vite reuses an inline plugin across restarts, so the old server's control is still here when it closes.
  const controls = new Set<SwitchControl>();

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
      const control = switchControl(server, resolver, options.drainMs ?? DRAIN_MS);
      controls.add(control);
      const { restart } = control;
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
    closeServer({ reason }) {
      for (const control of controls) {
        if (!control.closed()) continue;
        controls.delete(control);
        control.unregister(reason);
      }
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
async function restartServer(server: ViteDevServer, slotRoot: string, log: (message: string) => void): Promise<void> {
  let before = readSlotRoot(slotRoot);
  for (;;) {
    await server.restart();
    const after = readSlotRoot(slotRoot);
    if (after === before) return;
    log(`${relative(server.config.root, slotRoot)}/ changed while the server restarted; restarting again`);
    before = after;
  }
}

export const DEV_SERVER_FILE = ".ex/dev-server.json";
export const CONTROL_PATH = "/__ex";
/** How long a pause waits for the requests already admitted to answer. */
const DRAIN_MS = 15_000;

/**
 * What a running dev server writes to `.ex/dev-server.json`, so `pnpm ex` can find and pause it. Each
 * server has its own token, so a new token means a new server: `restarting` while it's being
 * replaced, `restart-failed` when the replacement didn't start and this one serves on.
 */
export type DevServerEntry = {
  pid: number;
  url: string;
  token: string;
  /** The step it serves. */
  step: string | null;
  state: "running" | "restarting" | "restart-failed";
};

const STATES: readonly DevServerEntry["state"][] = ["running", "restarting", "restart-failed"];

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
    const { pid, url, token, step = null, state = "running" } = entry;
    if (typeof pid !== "number" || typeof url !== "string" || typeof token !== "string") return null;
    if ((step !== null && typeof step !== "string") || !STATES.includes(state)) return null;
    return { pid, url, token, step, state };
  } catch {
    return null;
  }
}

type SwitchControl = {
  restart(): Promise<void>;
  /** Whether a pause or a restart is under way, so a file change needs no restart of its own. */
  switching(): boolean;
  closed(): boolean;
  /** Its server closed: mark the entry `restarting` until the next server writes its own, or remove it. */
  unregister(reason: "restart" | "close"): void;
};

/**
 * Lets `pnpm ex` stop the dev server taking work while it switches the slotted code, then restart it
 * on the new code (scripts/ex/switch.ts). `POST /__ex/pause` answers every other request with a 503,
 * new workflow runs and the local world's deliveries included, until `POST /__ex/resume` restarts the
 * server. The pause answers once the requests it let in before have started their answers, or after
 * `drainMs`, with how many still hadn't: a request that starts a run has started it by then. Both
 * need the token from `.ex/dev-server.json`. If the paused `ex` dies, the next request restarts the
 * server.
 */
function switchControl(server: ViteDevServer, resolver: SlotResolver, drainMs: number): SwitchControl {
  const { root } = resolver;
  const token = randomUUID();
  const registry = join(root, DEV_SERVER_FILE);
  let url: string | null = null;
  let pausedBy: number | null = null;
  let restarting = false;
  let closed = false;
  const admitted = new Set<ServerResponse>();
  const log = (message: string) => server.config.logger.info(`learn-slots: ${message}`, { timestamp: true });
  const ours = () => readDevServerEntry(root)?.token === token;

  const register = (state: DevServerEntry["state"]) => {
    if (url === null) return;
    const entry: DevServerEntry = { pid: process.pid, url, token, step: resolver.step, state };
    // A reader never sees half a file: `ex` would take that for no dev server at all.
    const tmp = `${registry}.${process.pid}.tmp`;
    mkdirSync(dirname(registry), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
    renameSync(tmp, registry);
  };

  const restart = async () => {
    restarting = true;
    register("restarting");
    try {
      await restartServer(server, resolver.slotRoot, log);
    } finally {
      restarting = false;
    }
    // When the new server fails to start, Vite keeps this one and only logs why.
    if (ours()) register("restart-failed");
  };

  // The pause holds until the restart is done: this server mustn't take work on files swapped under it.
  const endSwitch = () => void restart().finally(() => (pausedBy = null));

  /** How many admitted requests haven't started their answer, once all have or `drainMs` is up. */
  const drain = async () => {
    const open = () => [...admitted].filter((res) => !res.headersSent).length;
    const deadline = Date.now() + drainMs;
    if (open() > 0) log(`waiting for ${open()} request(s) to answer before pausing`);
    while (open() > 0 && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
    return open();
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
        // A pause now would be lost with this server; `ex` waits for the next one and pauses that.
        if (restarting) return send(409, "restarting; pause the next server\n");
        pausedBy = pid;
        log("paused while `pnpm ex` switches steps");
        void drain().then((open) => {
          res.setHeader("content-type", "application/json");
          send(200, JSON.stringify({ open }));
        });
        return;
      }
      if (req.url === `${CONTROL_PATH}/resume`) {
        log("switch done; restarting");
        res.once("finish", endSwitch);
        return send(202);
      }
      return send(404);
    }
    if (pausedBy !== null && !restarting && !isAlive(pausedBy)) {
      log("`pnpm ex` exited mid-switch; restarting");
      endSwitch();
    }
    if (pausedBy === null) {
      admitted.add(res);
      res.once("close", () => admitted.delete(res));
      return next();
    }
    res.setHeader("retry-after", "1");
    send(503, "switching steps; retry in a moment\n");
  });

  const { httpServer } = server;
  httpServer?.once("listening", () => {
    const { port } = httpServer.address() as AddressInfo;
    url = `http://localhost:${port}`;
    register("running");
  });
  httpServer?.once("close", () => (closed = true));

  return {
    restart,
    switching: () => pausedBy !== null || restarting,
    closed: () => closed,
    unregister(reason) {
      if (!ours()) return;
      if (reason === "restart") register("restarting");
      else rmSync(registry, { force: true });
    },
  };
}
