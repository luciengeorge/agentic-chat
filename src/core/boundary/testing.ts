/**
 * Compiles a module the way the browser build does, with TanStack Start's own compiler: for the client it strips
 * every `.server()` (and a server function's handler), then drops the code and imports nothing uses any more.
 * Whatever imports survive are what the browser bundle would load. Tests only.
 *
 * The compiler isn't a public entry point of `@tanstack/start-plugin-core`, so this loads it by path, next to
 * `@tanstack/react-start` in pnpm's store. An upgrade that moves it fails here, loudly, and nowhere else.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseSync } from "vite";

interface StartCompiler {
  compile(input: { code: string; id: string }): Promise<{ code: string } | null>;
}

let compiler: Promise<StartCompiler> | null = null;

function startCompiler(root: string): Promise<StartCompiler> {
  compiler ??= (async () => {
    const require = createRequire(join(root, "package.json"));
    const store = dirname(dirname(require.resolve("@tanstack/react-start/package.json")));
    const host = join(store, "start-plugin-core/dist/esm/start-compiler/host.js");
    const { createStartCompiler } = (await import(pathToFileURL(host).href)) as {
      createStartCompiler(options: Record<string, unknown>): StartCompiler;
    };
    return createStartCompiler({
      env: "client",
      envName: "client",
      root,
      framework: "react",
      providerEnvName: "ssr",
      mode: "build",
      getKnownServerFns: () => ({}),
      loadModule: async () => {},
      resolveId: async (id: string) => id,
    });
  })();
  return compiler;
}

export interface BrowserModule {
  code: string;
  /** Every module the compiled code still imports, type-only imports left out. */
  imports: string[];
}

/** `code` as the client build compiles it. `id` is the file's absolute path (it names the module's server fns). */
export async function compileForBrowser(code: string, id: string, root = process.cwd()): Promise<BrowserModule> {
  const compiled = (await (await startCompiler(root)).compile({ code, id }))?.code ?? code;
  const ast = parseSync(id, compiled, { lang: "ts" }).program;
  const imports = ast.body.flatMap((node) =>
    node.type === "ImportDeclaration" && node.importKind !== "type" ? [String(node.source.value)] : [],
  );
  return { code: compiled, imports };
}
