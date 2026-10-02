import { eq } from "drizzle-orm";

import type { World } from "@/fixtures/world";

import { db } from "@/db/client";
import { member, organization, user as userTable } from "@/db/schema";
import { auth } from "@/lib/auth";
import { acEnv } from "@/lib/auth-env";

export interface SeedReport {
  tenant: string;
  organizationCreated: boolean;
  usersCreated: string[];
  membershipsCreated: string[];
  banned: string[];
}

const BAN_REASON = "Disabled in the directory";

/** Creates each tenant's organization, users and memberships from the world, through better-auth
 * as system actions (no request headers). Only what's missing is created, so a second run changes
 * nothing. Users disabled in the directory are banned, so their sign-in is refused. */
export async function seedWorld(world: World): Promise<SeedReport[]> {
  // Every seeded account signs in with its tenant's password from world.yaml, which is public.
  if (acEnv() === "prod") throw new Error("Refusing to seed the world's public passwords with AC_ENV=prod");

  const reports: SeedReport[] = [];
  for (const [slug, tenant] of Object.entries(world.tenants)) {
    const report: SeedReport = {
      tenant: slug,
      organizationCreated: false,
      usersCreated: [],
      membershipsCreated: [],
      banned: [],
    };
    const ids = new Map<string, string>();

    for (const u of tenant.users) {
      const [existing] = await db
        .select({ id: userTable.id, banned: userTable.banned })
        .from(userTable)
        .where(eq(userTable.email, u.email));
      if (existing) {
        ids.set(u.username, existing.id);
        if (!u.enabled && !existing.banned) {
          await ban(existing.id);
          report.banned.push(u.username);
        }
        continue;
      }
      const { user } = await auth.api.createUser({
        body: {
          email: u.email,
          password: tenant.password,
          name: u.name,
          data: {
            id: world.userId(slug, u.username),
            emailVerified: true,
            ...(u.enabled ? {} : { banned: true, banReason: BAN_REASON }),
          },
        },
      });
      ids.set(u.username, user.id);
      report.usersCreated.push(u.username);
      if (!u.enabled) report.banned.push(u.username);
    }

    let [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug));
    if (!org) {
      // createOrganization needs a creator, who becomes its first member (creatorRole: admin).
      const creator = tenant.users.find((u) => u.enabled && u.roles.includes("admin"));
      if (!creator) throw new Error(`Tenant ${slug} has no enabled admin to create its organization`);
      const created = await auth.api.createOrganization({
        body: { name: tenant.name, slug, userId: ids.get(creator.username)! },
      });
      if (!created) throw new Error(`Creating the ${slug} organization returned nothing`);
      org = { id: created.id };
      report.organizationCreated = true;
      report.membershipsCreated.push(creator.username);
    }

    for (const u of tenant.users) {
      const userId = ids.get(u.username)!;
      const [membership] = await db
        .select({ organizationId: member.organizationId })
        .from(member)
        .where(eq(member.userId, userId));
      if (membership) {
        if (membership.organizationId !== org.id) {
          throw new Error(`${u.email} already belongs to another organization than ${slug}`);
        }
        continue;
      }
      await auth.api.addMember({
        body: { userId, organizationId: org.id, role: u.roles.includes("admin") ? "admin" : "member" },
      });
      report.membershipsCreated.push(u.username);
    }

    reports.push(report);
  }
  return reports;
}

// The admin plugin's banUser endpoint needs an admin's session; this does what it does, as a system
// action: set the ban and end the user's sessions.
async function ban(userId: string) {
  const { internalAdapter } = await auth.$context;
  await internalAdapter.updateUser(userId, { banned: true, banReason: BAN_REASON, banExpires: null });
  await internalAdapter.deleteUserSessions(userId);
}
