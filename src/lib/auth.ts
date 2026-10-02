import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import * as authSchema from "@/db/schema/auth";
import { acEnv, assertSafeSecrets } from "@/lib/auth-env";
import { createLogger } from "@/lib/logger";

assertSafeSecrets();

const logger = createLogger("auth");

async function organizationOf(userId: string) {
  const [row] = await db
    .select({ id: authSchema.member.organizationId })
    .from(authSchema.member)
    .where(eq(authSchema.member.userId, userId))
    .limit(1);
  return row?.id ?? null;
}

// There's no mail transport yet. Dev prints the link; anywhere else refuses rather than drop it.
async function sendEmail(email: { to: string; subject: string; url: string }) {
  if (acEnv() !== "dev") throw new Error("No email transport is configured outside dev");
  logger.info("email", email);
}

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg", schema: authSchema, transaction: true }),
  advanced: { database: { generateId: "uuid" } },
  emailAndPassword: {
    enabled: true,
    // Accounts come from the seed (later, the directory sync), never from a sign-up form.
    disableSignUp: true,
    sendResetPassword: ({ user, url }) => sendEmail({ to: user.email, subject: "Reset your password", url }),
  },
  emailVerification: {
    sendVerificationEmail: ({ user, url }) => sendEmail({ to: user.email, subject: "Verify your email", url }),
  },
  databaseHooks: {
    session: {
      create: {
        // A user belongs to one organization, so it's always the active one.
        before: async (session) => ({
          data: { ...session, activeOrganizationId: await organizationOf(session.userId) },
        }),
      },
    },
  },
  plugins: [
    admin(),
    organization({
      allowUserToCreateOrganization: false,
      // Only the seed creates organizations, as a system action on behalf of a tenant admin.
      creatorRole: "admin",
      organizationHooks: {
        beforeAddMember: async ({ user }) => {
          if (await organizationOf(user.id)) {
            throw new APIError("BAD_REQUEST", { message: "A user can belong to one organization only" });
          }
        },
      },
    }),
    tanstackStartCookies(),
  ],
});
