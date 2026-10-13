import { drizzleAdapter } from "@better-auth/drizzle-adapter/relations-v2";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, organization } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { eq } from "drizzle-orm";

import { db } from "@/db/client";
import * as authSchema from "@/db/schema/auth";
import { assertSafeSecrets } from "@/lib/auth-env";
import { acEnv } from "@/lib/env";
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

async function slugOf(organizationId: string) {
  const [row] = await db
    .select({ slug: authSchema.organization.slug })
    .from(authSchema.organization)
    .where(eq(authSchema.organization.id, organizationId));
  return row?.slug;
}

// A removed member keeps no session, as a banned user keeps none (the admin plugin's banUser ends them too).
async function endSessions(userId: string): Promise<void> {
  const { internalAdapter } = await auth.$context;
  await internalAdapter.deleteUserSessions(userId);
}

// Membership comes from the seed (later, the directory sync), so nobody joins by invitation. better-auth has no
// switch for that, and `disabledPaths` would close only the HTTP routes, not `auth.api`.
async function refuseInvitations() {
  throw new APIError("BAD_REQUEST", { message: "Invitations are off: membership comes from the directory" });
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
        afterRemoveMember: ({ user }) => endSessions(user.id),
        beforeCreateInvitation: refuseInvitations,
        beforeAcceptInvitation: refuseInvitations,
        // The seed and `ex smoke` find a tenant by its slug.
        beforeUpdateOrganization: async ({ organization, member }) => {
          if (organization.slug !== undefined && organization.slug !== (await slugOf(member.organizationId))) {
            throw new APIError("BAD_REQUEST", { message: "An organization's slug can't change" });
          }
        },
      },
    }),
    tanstackStartCookies(),
  ],
});
