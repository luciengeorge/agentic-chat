import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import { workflow } from "workflow/vite";

import { LOCAL_ONLY_PACKAGES, localBuild, NO_LOCAL_MODELS } from "./src/core/local/build.ts";
import { setWorkflowEsbuildPlugins } from "./src/workflows/esbuild-plugins.ts";
import { learnSlots, learnSlotsEsbuild } from "./vite-plugins/learn-slots.ts";

setWorkflowEsbuildPlugins([learnSlotsEsbuild({ root: import.meta.dirname })]);

// Native or worker-backed (the ingest page routes): Node loads them from node_modules, in every environment, and
// Vite's dependency optimizer never touches them.
const NODE_ONLY = ["@napi-rs/canvas", "tesseract.js"];
const nodeOnly: Plugin = {
  name: "agentic-chat:node-only-deps",
  configEnvironment: (_name, config) => ({
    optimizeDeps: { exclude: NODE_ONLY },
    ...(config.consumer === "client" ? {} : { resolve: { external: NODE_ONLY } }),
  }),
};

// Section 21: a hosted build swaps transformers.js for a module that explains, so onnxruntime-node stays out of
// `.output`; `pnpm build:local` loads it from node_modules instead, traced by nitro.config.ts.
const localModels: Plugin = {
  name: "agentic-chat:local-models",
  apply: "build",
  enforce: "pre",
  configEnvironment: (_name, config) =>
    config.consumer !== "client" && localBuild() ? { resolve: { external: LOCAL_ONLY_PACKAGES } } : {},
  resolveId(id) {
    if (localBuild() || this.environment.config.consumer === "client") return null;
    return LOCAL_ONLY_PACKAGES.includes(id) ? NO_LOCAL_MODELS : null;
  },
};

// In dev, @workflow/nitro's two route handlers import the bundle it rebuilds from a path known only at runtime, and
// Vite warns that it "cannot be analyzed" for each. Mark just those imports @vite-ignore; other warnings stay.
const workflowDevImports: Plugin = {
  name: "agentic-chat:workflow-dev-imports",
  apply: "serve",
  transform: {
    filter: { id: /^#workflow\/(webhook|workflows)\.mjs$/ },
    handler: (code) => code.replace("import(currentImportPath)", "import(/* @vite-ignore */ currentImportPath)"),
  },
};

const config = defineConfig({
  plugins: [
    workflow(),
    learnSlots(),
    devtools(),
    nitro(),
    tailwindcss(),
    tanstackStart(),
    viteReact({
      compiler: true,
    }),
    nodeOnly,
    localModels,
    workflowDevImports,
  ],
  resolve: { tsconfigPaths: true },
  clearScreen: false,
});

export default config;
