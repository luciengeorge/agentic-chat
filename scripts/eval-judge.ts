/**
 * `pnpm eval:judge`: the faithfulness judge and the claim checker over the hand-labelled set
 * (fixtures/golden/faithfulness.yaml), compared with the hand labels as Cohen's kappa.
 *
 *   pnpm eval:judge            replays fixtures/cassettes/eval/{judge,claims}.json: free, no key needed
 *   pnpm eval:judge --record   calls gpt-6-luna for every item and rewrites those recordings
 *   pnpm eval:judge --only a,b just these items (with --record, nothing is written)
 */
import { createOpenAI } from "@ai-sdk/openai";

import type { StructuredModel } from "#learn/model/types";

import { describeKappa } from "#learn/eval/kappa";
import { aiSdkChatModel } from "#learn/model/ai-sdk";
import { CHAT_MODEL, CHAT_REASONING_EFFORT } from "#learn/model/config";
import { costOf } from "#learn/observability/prices";
import { type FaithfulnessResult, judgeItem, summarizeFaithfulness } from "@/core/eval/faithfulness";
import { loadJudgeSet } from "@/core/eval/judge-set";
import {
  type EvalRecording,
  evalRecording,
  type RecordedCall,
  recordedUsage,
  recordingFetch,
  replayEvalModel,
  writeEvalRecording,
} from "@/core/eval/recorded";

function parseArgs(argv: string[]) {
  let record = false;
  let only: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--record") record = true;
    else if (arg === "--only") only = (argv[++i] ?? "").split(",").filter(Boolean);
    else throw new Error(`unknown argument ${arg}; try --record or --only id,id`);
  }
  return { record, only };
}

const fixed = (n: number) => (Number.isNaN(n) ? "n/a" : n.toFixed(3));

async function main() {
  const { record, only } = parseArgs(process.argv.slice(2));
  const all = loadJudgeSet();
  const items = only ? all.filter((i) => only.includes(i.id)) : all;
  if (only && items.length !== only.length)
    throw new Error(`no item ${only.filter((id) => !all.some((i) => i.id === id))}`);

  const calls: Record<"judge" | "claims", Record<string, RecordedCall[]>> = { judge: {}, claims: {} };
  let modelFor: (kind: "judge" | "claims", id: string) => StructuredModel = replayEvalModel;
  if (record) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("--record needs OPENAI_API_KEY (.env.local)");
    modelFor = (kind, id) => {
      const into = (calls[kind][id] ??= []);
      return aiSdkChatModel(createOpenAI({ apiKey, fetch: recordingFetch(into) })(CHAT_MODEL));
    };
  }

  const results: FaithfulnessResult[] = [];
  for (const item of items) {
    const r = await judgeItem(item, { modelFor, reasoningEffort: CHAT_REASONING_EFFORT });
    results.push(r);
    process.stderr.write(
      `${item.id.padEnd(28)} hand ${r.label.padEnd(10)} judge ${r.judge.verdict.padEnd(10)} ` +
        `claims ${r.score.supported}/${r.score.claims} supported -> ${r.claimsVerdict}` +
        `${r.judge.verdict !== r.label ? `\n    judge: ${r.judge.reason}` : ""}` +
        `${
          r.claimsVerdict !== r.label
            ? `\n    claims: ${
                r.claims
                  .filter((c) => c.verdict !== "supported")
                  .map((c) => `[${c.verdict}] ${c.text}`)
                  .join(" | ") || "every claim supported"
              }`
            : ""
        }\n`,
    );
  }

  if (record && !only) {
    for (const name of ["judge", "claims"] as const) {
      const recording: EvalRecording = {
        recorded: new Date().toISOString().slice(0, 10),
        model: CHAT_MODEL,
        reasoningEffort: CHAT_REASONING_EFFORT,
        calls: calls[name],
      };
      writeEvalRecording(name, recording);
    }
    process.stderr.write("wrote fixtures/cassettes/eval/judge.json and claims.json\n");
  }

  const used = record
    ? calls
    : { judge: evalRecording("judge")?.calls ?? {}, claims: evalRecording("claims")?.calls ?? {} };
  const ids = new Set(items.map((i) => i.id));
  let usd = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  for (const kind of ["judge", "claims"] as const) {
    for (const [id, list] of Object.entries(used[kind])) {
      if (!ids.has(id)) continue;
      for (const call of list) {
        const u = recordedUsage(call);
        tokensIn += u.inputTokens;
        tokensOut += u.outputTokens;
        usd += costOf(CHAT_MODEL, u).usd;
      }
    }
  }

  const s = summarizeFaithfulness(results);
  const line = (name: string, c: typeof s.judge) =>
    `${name}: kappa ${fixed(c.kappa)} (${describeKappa(c.kappa)}), agreement ${fixed(c.observed)}, chance ${fixed(c.chance)}; ` +
    `hand faithful -> faithful ${c.confusion.counts.faithful.faithful}, unfaithful ${c.confusion.counts.faithful.unfaithful}; ` +
    `hand unfaithful -> faithful ${c.confusion.counts.unfaithful.faithful}, unfaithful ${c.confusion.counts.unfaithful.unfaithful}` +
    (c.disagreements.length ? `; disagree on ${c.disagreements.join(", ")}` : "");
  process.stdout.write(
    [
      `faithfulness set: ${s.items} items (${record ? "live" : "replayed"})`,
      line("judge ", s.judge),
      line("claims", s.claims),
      `claims per answer ${fixed(s.claimsPerAnswer)}; mean claim faithfulness: hand-faithful ${fixed(s.meanFaithfulness.faithful)}, hand-unfaithful ${fixed(s.meanFaithfulness.unfaithful)}`,
      `the calls ${record ? "cost" : "cost when recorded"}: $${usd.toFixed(4)} (${tokensIn} input, ${tokensOut} output tokens)`,
    ].join("\n") + "\n",
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
