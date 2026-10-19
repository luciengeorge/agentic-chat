import type { ToolDeps } from "#learn/agent/tools/deps";
import type { AgentTool } from "#learn/agent/types";

import { planTool } from "#learn/agent/plan";
import { findPerson } from "#learn/agent/tools/find-person";
import { readDocument } from "#learn/agent/tools/read-document";
import { searchDocuments } from "#learn/agent/tools/search-documents";
import { sendMail } from "#learn/agent/tools/send-mail";
import { shareDocument } from "#learn/agent/tools/share-document";

/**
 * The agent's tools: the plan tool (with it, `approvalNeeded` applies plan-then-execute, section 17), three that
 * read, and two that write (and so wait for the user's approval).
 */
export function createAgentTools(deps: ToolDeps): AgentTool[] {
  return [
    planTool(),
    searchDocuments(deps),
    readDocument(deps),
    findPerson(deps),
    sendMail(deps),
    shareDocument(deps),
  ] as AgentTool[];
}
