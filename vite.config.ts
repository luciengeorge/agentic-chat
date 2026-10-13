import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, type Plugin } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { workflow } from "workflow/vite";

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

const config = defineConfig({
  plugins: [
    workflow(),
    learnSlots(),
    devtools(),
    nitro(),
    viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
    tailwindcss(),
    tanstackStart(),
    viteReact({
      compiler: true,
    }),
    nodeOnly,
  ],
  clearScreen: false,
});

export default config;
