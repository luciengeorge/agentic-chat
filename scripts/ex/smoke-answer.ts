import { randomUUID } from "node:crypto";

import type { SourceRef, Verdict } from "@/components/chat/types";

import { mentions } from "#learn/eval/checks";
import { type GoldenQuestion, loadGolden, secretsOf } from "@/fixtures/golden";
import { loadWorld } from "@/fixtures/world";

import { readText, send, sessionCookie, signIn, type SmokeTargets } from "./smoke";

/** One golden question that must be answered with a citation, and one that must be abstained from. */
export const ANSWER_QUESTION = "expenses-meals";
export const ABSTAIN_QUESTION = "heron-intern";

export interface ChatReply {
  status: number;
  text: string;
  sources: SourceRef[];
  verdict: Verdict | null;
  errors: string[];
}

/** Reads the UI message stream `POST /api/chat` answers with: SSE `data:` lines, heartbeats as comments. */
export function parseChatStream(body: string): Omit<ChatReply, "status"> {
  let text = "";
  let sources: SourceRef[] = [];
  let verdict: Verdict | null = null;
  const errors: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice("data: ".length);
    if (data === "[DONE]") continue;
    const part = JSON.parse(data) as { type: string; delta?: string; data?: unknown; errorText?: string };
    if (part.type === "text-delta") text += part.delta ?? "";
    else if (part.type === "data-sources") sources = (part.data as { sources: SourceRef[] }).sources;
    else if (part.type === "data-verdict") verdict = part.data as Verdict;
    else if (part.type === "error") errors.push(part.errorText ?? "error");
  }
  return { text, sources, verdict, errors };
}

async function ask(target: SmokeTargets, cookie: string, question: string): Promise<ChatReply> {
  const app = { url: target.appUrl, start: "pnpm dev" };
  const response = await send(target.fetch, app, "/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: target.appUrl, cookie },
    body: JSON.stringify({
      id: randomUUID(),
      message: { id: `smoke-${randomUUID()}`, role: "user", parts: [{ type: "text", text: question }] },
    }),
  });
  const body = await readText(response, "POST /api/chat");
  return { status: response.status, ...parseChatStream(body) };
}

function golden(id: string): GoldenQuestion {
  const question = loadGolden().find((q) => q.id === id);
  if (!question) throw new Error(`no golden question ${id}`);
  return question;
}

/**
 * 9. Answer: two golden questions end to end through `POST /api/chat`, signed in as their user. One is answered
 * with a citation of a labelled document; the other (the Heron deal, asked by the intern) gets no /Exec source and
 * none of its hidden facts in the reply. Whether it abstains is up to the model, which now and then hedges instead,
 * so the eval's abstention gate grades that, not the smoke.
 */
export async function checkAnswer(target: SmokeTargets): Promise<string> {
  const world = loadWorld();
  const cited = golden(ANSWER_QUESTION);
  const abstain = golden(ABSTAIN_QUESTION);
  if (cited.user !== abstain.user || cited.tenant !== abstain.tenant) throw new Error("both questions need one user");

  const { email } = world.user(cited.tenant, cited.user);
  const login = await signIn(target, email, world.tenant(cited.tenant).password);
  await readText(login, `${cited.user}'s sign-in`);
  const cookie = sessionCookie(login);
  try {
    const answered = await ask(target, cookie, cited.question);
    if (answered.errors.length) throw new Error(`${cited.id}: the stream carried ${answered.errors.join("; ")}`);
    if (!answered.verdict) throw new Error(`${cited.id}: no verdict in the stream`);
    if (answered.verdict.abstained) throw new Error(`${cited.id}: abstained: ${answered.text.slice(0, 200)}`);
    const labelled = new Set(cited.relevant.map((label) => label.path));
    const citations = answered.verdict.citations.filter((citation) => labelled.has(citation.path));
    if (citations.length === 0) {
      const paths = answered.verdict.citations.map((citation) => citation.path);
      throw new Error(
        `${cited.id}: no citation of ${[...labelled].join(", ")} (cited ${paths.join(", ") || "nothing"})`,
      );
    }

    const refused = await ask(target, cookie, abstain.question);
    if (refused.errors.length) throw new Error(`${abstain.id}: the stream carried ${refused.errors.join("; ")}`);
    const exec = refused.sources.filter((source) => source.path.startsWith("/Exec/"));
    if (exec.length) throw new Error(`${abstain.id}: sources include ${exec.map((source) => source.path).join(", ")}`);
    const said = mentions(refused.text, secretsOf(abstain));
    if (said.length) throw new Error(`${abstain.id}: the reply says ${said.join(", ")}`);

    return (
      `${cited.user}: "${cited.id}" cited ${citations[0].path}${citations[0].page ? ` p${citations[0].page}` : ""}` +
      ` (${answered.verdict.citations.length} citations, ${answered.verdict.dropped.length} dropped); ` +
      `"${abstain.id}" ${refused.verdict?.abstained ? "abstained" : "hedged"} from ${refused.sources.length} sources, none in /Exec`
    );
  } finally {
    await send(target.fetch, { url: target.appUrl, start: "pnpm dev" }, "/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json", origin: target.appUrl, cookie },
      body: "{}",
    }).catch(() => {});
  }
}
