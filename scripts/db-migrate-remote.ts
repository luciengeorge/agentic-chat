/** `pnpm db:migrate:remote`: the migrations on a cloud database. Both URLs come from the shell, never `.env.local`. */
import { migrateRemote, targetProblems } from "./db-remote";

const problems = targetProblems(process.env);
if (problems.length) {
  console.error(["Nothing was changed:", ...problems.map((problem) => `  ${problem}`)].join("\n"));
  process.exit(1);
}
try {
  await migrateRemote(process.env.DATABASE_ADMIN_URL!.trim(), process.env.DATABASE_URL!.trim());
} catch (error) {
  // A check before the migrations changes nothing, and drizzle applies the pending ones in one transaction.
  console.error(`Stopped: ${(error as Error).message}`);
  process.exit(1);
}
