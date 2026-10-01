import viteTsConfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [viteTsConfigPaths({ projects: ["./tsconfig.json"] })],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: ["node_modules", ".output", ".tanstack", "dist", ".vercel"],
  },
});
