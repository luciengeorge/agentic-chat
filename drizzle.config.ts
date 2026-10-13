import { defineConfig } from "drizzle-kit";

// Migrations run as the owner; the app connects as `ac_app` through DATABASE_URL.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
  dbCredentials: { url: process.env.DATABASE_ADMIN_URL! },
});
