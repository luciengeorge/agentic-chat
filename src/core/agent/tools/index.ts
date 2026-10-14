import type { AgentTool } from "#learn/agent/types";

import type { ToolDeps } from "./deps";

import { findPerson } from "./find-person";
import { readDocument } from "./read-document";
import { searchDocuments } from "./search-documents";
import { sendMail } from "./send-mail";
import { shareDocument } from "./share-document";

/** The agent's five tools: three that read, two that write (and so wait for the user's approval). */
export function createAgentTools(deps: ToolDeps): AgentTool[] {
  return [
    searchDocuments(deps),
    readDocument(deps),
    findPerson(deps),
    sendMail(deps),
    shareDocument(deps),
  ] as AgentTool[];
}
