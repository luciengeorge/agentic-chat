/** The golden set in `fixtures/golden/questions.yaml`: what `pnpm eval` asks, as whom, and what a right answer rests on. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const DEFAULT_GOLDEN_PATH = fileURLToPath(new URL("../../fixtures/golden/questions.yaml", import.meta.url));

const LabelSchema = z.strictObject({
  path: z.string().startsWith("/"),
  page: z.number().int().positive().nullable(),
  evidence: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).transform((e) => (Array.isArray(e) ? e : [e])),
});

const QuestionSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    tenant: z.string(),
    user: z.string(),
    question: z.string().min(1),
    expect: z.enum(["answer", "abstain"]),
    traps: z.array(z.string()),
    answer: z.string().min(1).optional(),
    relevant: z.array(LabelSchema).default([]),
    forbidden: z.array(z.string().min(1)).default([]),
    hidden: z.array(z.string().min(1)).default([]),
  })
  .superRefine((q, ctx) => {
    if (q.expect === "answer" && (!q.answer || q.relevant.length === 0)) {
      ctx.addIssue({ code: "custom", message: `${q.id}: an answer case needs an answer and relevant pages` });
    }
    if (q.expect === "abstain" && (q.answer || q.relevant.length > 0 || q.hidden.length === 0)) {
      ctx.addIssue({ code: "custom", message: `${q.id}: an abstain case has hidden facts and no answer or pages` });
    }
  });

const GoldenSchema = z.strictObject({ version: z.literal(1), questions: z.array(QuestionSchema).min(1) });

export type GoldenQuestion = z.output<typeof QuestionSchema>;
export type GoldenLabel = GoldenQuestion["relevant"][number];

export function loadGolden(path: string = DEFAULT_GOLDEN_PATH): GoldenQuestion[] {
  const { questions } = GoldenSchema.parse(parseYaml(readFileSync(path, "utf8")));
  const ids = questions.map((q) => q.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length) throw new Error(`golden question ids repeat: ${repeated.join(", ")}`);
  return questions;
}

/** What the user must never be told: the case's `forbidden` text, and for an abstention, its `hidden` facts. */
export const secretsOf = (q: GoldenQuestion): string[] => [...q.forbidden, ...q.hidden];
