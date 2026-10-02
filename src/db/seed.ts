import { eq } from "drizzle-orm";

import type { World } from "@/fixtures/world";

import { db } from "@/db/client";
import { member, organization, user as userTable } from "@/db/schema";
import { auth } from "@/lib/auth";
import { acEnv } from "@/lib/env";

export interface SeedReport {
  tenant: string;
  organizationCreated: boolean;
  usersCreated: string[];
  /** Users whose email or name the seed put back. */
  usersUpdated: string[];
  membershipsCreated: string[];
  rolesUpdated: string[];
  banned: string[];
  unbanned: string[];
}

const BAN_REASON = "Disabled in the directory";

/** Makes each tenant's organization, users and memberships match the world, through better-auth
 * as system actions (no request headers). It creates what's missing and repairs what's wrong (a
 * user's email or name, a member's role, a ban), so a second run changes nothing. Users disabled
 * in the directory are banned, so their sign-in is refused, and re-enabled ones are unbanned. A
 * user whose email the database gives another id than the world's stops it: that's not repairable. */
export async function seedWorld(world: World): Promise<SeedReport[]> {
  // Every seeded account signs in with its tenant's password from world.yaml, which is public.
  if (acEnv() === "prod") throw new Error("Refusing to seed the world's public passwords with AC_ENV=prod");

  const reports: SeedReport[] = [];
  for (const [slug, tenant] of Object.entries(world.tenants)) {
    const report: SeedReport = {
      tenant: slug,
      organizationCreated: false,
      usersCreated: [],
      usersUpdated: [],
      membershipsCreated: [],
      rolesUpdated: [],
      banned: [],
      unbanned: [],
    };

    for (const u of tenant.users) {
      const id = world.userId(slug, u.username);
      const [byEmail] = await db.select({ id: userTable.id }).from(userTable).where(eq(userTable.email, u.email));
      if (byEmail && byEmail.id !== id) {
        throw new Error(`${u.email} has the id ${byEmail.id} in the database, but the world gives it ${id}`);
      }
      const [existing] = await db
        .select({ email: userTable.email, name: userTable.name, banned: userTable.banned })
        .from(userTable)
        .where(eq(userTable.id, id));
      if (!existing) {
        await auth.api.createUser({
          body: {
            email: u.email,
            password: tenant.password,
            name: u.name,
            data: { id, emailVerified: true, ...(u.enabled ? {} : { banned: true, banReason: BAN_REASON }) },
          },
        });
        report.usersCreated.push(u.username);
        if (!u.enabled) report.banned.push(u.username);
        continue;
      }
      if (existing.email !== u.email || existing.name !== u.name) {
        await (await auth.$context).internalAdapter.updateUser(id, { email: u.email, name: u.name });
        report.usersUpdated.push(u.username);
      }
      if (!u.enabled && !existing.banned) {
        await ban(id);
        report.banned.push(u.username);
      } else if (u.enabled && existing.banned) {
        await unban(id);
        report.unbanned.push(u.username);
      }
    }

    let [org] = await db.select({ id: organization.id }).from(organization).where(eq(organization.slug, slug));
    if (!org) {
      // createOrganization needs a creator, who becomes its first member (creatorRole: admin).
      const creator = tenant.users.find((u) => u.enabled && u.roles.includes("admin"));
      if (!creator) throw new Error(`Tenant ${slug} has no enabled admin to create its organization`);
      const created = await auth.api.createOrganization({
        body: { name: tenant.name, slug, userId: world.userId(slug, creator.username) },
      });
      if (!created) throw new Error(`Creating the ${slug} organization returned nothing`);
      org = { id: created.id };
      report.organizationCreated = true;
      report.membershipsCreated.push(creator.username);
    }

    for (const u of tenant.users) {
      const userId = world.userId(slug, u.username);
      const role = u.roles.includes("admin") ? "admin" : "member";
      const [membership] = await db
        .select({ id: member.id, organizationId: member.organizationId, role: member.role })
        .from(member)
        .where(eq(member.userId, userId));
      if (!membership) {
        await auth.api.addMember({ body: { userId, organizationId: org.id, role } });
        report.membershipsCreated.push(u.username);
        continue;
      }
      if (membership.organizationId !== org.id) {
        throw new Error(`${u.email} already belongs to another organization than ${slug}`);
      }
      if (membership.role !== role) {
        await db.update(member).set({ role }).where(eq(member.id, membership.id));
        report.rolesUpdated.push(u.username);
      }
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

// What the admin plugin's unbanUser does.
async function unban(userId: string) {
  const { internalAdapter } = await auth.$context;
  await internalAdapter.updateUser(userId, { banned: false, banReason: null, banExpires: null });
}
