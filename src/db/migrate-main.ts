/** `pnpm db:migrate`: applies the migrations as the owner, then lets the app role log in. */
import { enableAppLogin } from "./app-role";
import { migrateDatabase } from "./migrate";

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
if (!adminUrl) throw new Error("DATABASE_ADMIN_URL must be set: migrations run as the owner");
if (!appUrl) throw new Error("DATABASE_URL must be set: the app role's login comes from it");

await migrateDatabase(adminUrl);
await enableAppLogin(adminUrl, appUrl);
console.log("migrations applied; the app role can log in");
