/**
 * `pnpm db:rotate-passwords`: one new password for every person on a cloud database (section 22.2), from
 * ACCOUNT_PASSWORD, so world.yaml's public one stops working there. Reads the shell, never `.env.local`.
 */
import { describeUrl, rotatePasswords } from "./db-remote";

const adminUrl = process.env.DATABASE_ADMIN_URL?.trim();
const password = process.env.ACCOUNT_PASSWORD ?? "";
if (!adminUrl) {
  console.error("DATABASE_ADMIN_URL must be set: the owner changes the passwords");
  process.exit(1);
}
try {
  const { accounts, sessions } = await rotatePasswords(adminUrl, password);
  console.log(`${describeUrl(adminUrl)}: ${accounts} accounts have the new password; ${sessions} sessions ended`);
} catch (error) {
  console.error(`Nothing was changed: ${(error as Error).message}`);
  process.exit(1);
}
