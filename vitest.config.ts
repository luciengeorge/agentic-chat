import { workflow } from "@workflow/vitest";
import viteTsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

import { setWorkflowEsbuildPlugins } from "./src/workflows/esbuild-plugins.ts";
import { learnSlots, learnSlotsEsbuild } from "./vite-plugins/learn-slots.ts";

setWorkflowEsbuildPlugins([learnSlotsEsbuild({ root: import.meta.dirname })]);

export default defineConfig({
  plugins: [learnSlots(), viteTsConfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    globalSetup: ["./src/db/test/global-setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.ts", "vite-plugins/**/*.test.ts", "servers/**/*.test.ts"],
    exclude: ["node_modules", ".output", ".tanstack", "dist", ".vercel"],
    projects: [
      { extends: true, test: { name: "app", exclude: ["src/workflows/**"] } },
      // Standalone: the workflow plugin's setup loads esbuild, which refuses to run under jsdom.
      // Its runs and bundles go under node_modules/.cache, away from the dev server's .workflow-data. A nested run
      // (ex, src/workflows/slots.test.ts) sets AC_WORKFLOW_TEST_ROOT so it can't overwrite the bundles of its parent.
      {
        extends: false,
        plugins: [
          workflow({ rootDir: process.env.AC_WORKFLOW_TEST_ROOT ?? "node_modules/.cache/workflow-vitest" }),
          learnSlots(),
          viteTsConfigPaths({ projects: ["./tsconfig.json"] }),
        ],
        test: { name: "workflows", include: ["src/workflows/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
