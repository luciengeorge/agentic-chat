import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { workflow } from "workflow/vite";

import { setWorkflowEsbuildPlugins } from "./src/workflows/esbuild-plugins.ts";
import { learnSlots, learnSlotsEsbuild } from "./vite-plugins/learn-slots.ts";

setWorkflowEsbuildPlugins([learnSlotsEsbuild({ root: import.meta.dirname })]);

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
  ],
  clearScreen: false,
});

export default config;
