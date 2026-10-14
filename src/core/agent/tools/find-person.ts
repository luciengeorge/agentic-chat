import { sql } from "drizzle-orm";
import { z } from "zod";

import type { AgentTool } from "#learn/agent/types";

import type { ToolDeps } from "./deps";

const Input = z.object({
  query: z.string().min(2).max(100).describe("Part of a name, a username, an email address or a group path."),
});

export type Person = {
  id: string;
  kind: "user" | "group";
  /** The display name; a group's is its path. */
  name: string;
  email: string | null;
};

const LIMIT = 10;
const escapeLike = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** People and groups in the viewer's tenant directory. Disabled accounts aren't listed. */
export function findPerson(deps: Pick<ToolDeps, "withTenant">): AgentTool<z.infer<typeof Input>, { people: Person[] }> {
  return {
    name: "find_person",
    description:
      "Find people (and groups) in the company directory by name, username or email. Returns their ids and email " +
      "addresses, for send_mail and share_document.",
    input: Input,
    effect: "read",
    needsApproval: () => false,
    execute: ({ query }, ctx) =>
      deps.withTenant(ctx.viewer.tenantId, async (tx) => {
        const like = `%${escapeLike(query.trim())}%`;
        const rows = await tx.execute<Person>(sql`
          SELECT id, kind, display_name AS name, email FROM principals
          WHERE enabled AND (name ILIKE ${like} OR display_name ILIKE ${like} OR email ILIKE ${like})
          ORDER BY kind = 'user' DESC, display_name, id
          LIMIT ${LIMIT}`);
        return { people: [...rows] };
      }),
  };
}
