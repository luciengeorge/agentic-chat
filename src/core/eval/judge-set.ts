/**
 * The hand-labelled faithfulness set (`fixtures/golden/faithfulness.yaml`), joined to the four recorded chat turns
 * it's built on (`fixtures/cassettes/generate/`): each item gets its turn's question, asker and the sources the
 * model saw there, labelled as the prompt labelled them. Read from disk, so scripts under tsx can load it too.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type { CitableSource } from "#learn/cite/citations";
import type { RetrievedChunk } from "#learn/retrieve/types";

import { buildPrompt } from "#learn/generate/prompt";

import type { Faithfulness } from "./judge";

const FIXTURES = join(import.meta.dirname, "../../../fixtures");
export const JUDGE_SET_PATH = join(FIXTURES, "golden/faithfulness.yaml");
const TURNS = join(FIXTURES, "cassettes/generate");

/** How many of a recorded turn's chunks the app's model saw (the app's k). */
const SEEN = 8;

const ItemSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    turn: z.enum(["london-hotel", "heron", "brightwell", "invoice-hold"]),
    recorded: z.boolean().default(false),
    answer: z.string().min(1).optional(),
    label: z.enum(["faithful", "unfaithful"]),
    why: z.string().min(1),
  })
  .refine((item) => item.recorded !== Boolean(item.answer), {
    message: "an item either uses the recorded reply or gives its own answer",
  });

const SetSchema = z.strictObject({ version: z.literal(1), items: z.array(ItemSchema).min(1) });

export interface JudgeItem {
  id: string;
  turn: string;
  /** The world username who asked. */
  user: string;
  question: string;
  answer: string;
  /** The answer is the reply the model gave when the turn was recorded. */
  recorded: boolean;
  label: Faithfulness;
  why: string;
  sources: CitableSource[];
}

interface Turn {
  user: string;
  question: string;
  sources: CitableSource[];
  reply: string;
}

function loadTurn(name: string): Turn {
  const json = JSON.parse(readFileSync(join(TURNS, `${name}.json`), "utf8")) as {
    user: string;
    question: string;
    chunks: RetrievedChunk[];
  };
  const reply = readFileSync(join(TURNS, `${name}.sse`), "utf8")
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type?: string; delta?: string })
    .filter((data) => data.type === "response.output_text.delta")
    .map((data) => data.delta)
    .join("");
  const { sources } = buildPrompt({ question: json.question, chunks: json.chunks.slice(0, SEEN) });
  return { user: json.user, question: json.question, sources, reply };
}

export function loadJudgeSet(path: string = JUDGE_SET_PATH): JudgeItem[] {
  const { items } = SetSchema.parse(parseYaml(readFileSync(path, "utf8")));
  const ids = items.map((i) => i.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length) throw new Error(`judge set ids repeat: ${repeated.join(", ")}`);
  const turns = new Map<string, Turn>();
  return items.map((item) => {
    let turn = turns.get(item.turn);
    if (!turn) turns.set(item.turn, (turn = loadTurn(item.turn)));
    return {
      id: item.id,
      turn: item.turn,
      user: turn.user,
      question: turn.question,
      answer: item.recorded ? turn.reply : item.answer!,
      recorded: item.recorded,
      label: item.label,
      why: item.why,
      sources: turn.sources,
    };
  });
}
