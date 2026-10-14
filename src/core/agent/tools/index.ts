import type { AgentTool } from "#learn/agent/types";

import { planTool } from "#learn/agent/plan";

import type { ToolDeps } from "./deps";

import { findPerson } from "./find-person";
import { readDocument } from "./read-document";
import { searchDocuments } from "./search-documents";
import { sendMail } from "./send-mail";
import { shareDocument } from "./share-document";

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
