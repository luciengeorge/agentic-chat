import { db } from "@/db/client";
import { type SeedReport, seedWorld } from "@/db/seed";
import { loadWorld } from "@/fixtures/world";

function summary(report: SeedReport) {
  const changes: string[] = [];
  if (report.organizationCreated) changes.push("created the organization");
  if (report.usersCreated.length) changes.push(`created ${report.usersCreated.length} users`);
  if (report.usersUpdated.length) changes.push(`updated ${report.usersUpdated.join(", ")}`);
  if (report.membershipsCreated.length) changes.push(`added ${report.membershipsCreated.length} members`);
  if (report.rolesUpdated.length) changes.push(`changed the role of ${report.rolesUpdated.join(", ")}`);
  if (report.banned.length) changes.push(`banned ${report.banned.join(", ")}`);
  if (report.unbanned.length) changes.push(`unbanned ${report.unbanned.join(", ")}`);
  return `${report.tenant}: ${changes.join(", ") || "already seeded"}`;
}

try {
  for (const report of await seedWorld(loadWorld())) console.log(summary(report));
} finally {
  await db.$client.end();
}
