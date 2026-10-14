/**
 * Automations (section 16.4): a prompt that runs as an agent on a trigger, acting as the user who owns it. Its
 * approvals land in that user's inbox. Two triggers:
 * - `schedule`: a cron expression (UTC). With a folder, each fire covers the documents in it that became ready
 *   since the fire before, one run per document (a digest); without one, a fire is one run.
 * - `drive_change`: a document in the folder became ready (ingestion finished), one run for that document.
 *
 * A fire has a key, the same for every scheduler that sees it (the slot's time, or the document's version), so a
 * fire claimed once is never claimed again.
 */
import { z } from "zod";

import { CronError, type Cron, latestSlot, parseCron } from "./cron";

export type Trigger =
  | { kind: "schedule"; cron: string; folder: string | null }
  | { kind: "drive_change"; folder: string };

/** "/HR/Policies": a leading slash, no trailing one, single slashes. */
export function normalizeFolder(path: string): string {
  const parts = path.split("/").filter((p) => p.trim() !== "");
  return `/${parts.join("/")}`;
}

/** Whether a document's path is inside the folder, at any depth. The root folder holds everything. */
export function inFolder(folder: string, documentPath: string): boolean {
  const root = normalizeFolder(folder);
  return root === "/" || normalizeFolder(documentPath).startsWith(`${root}/`);
}

const Folder = z.string().trim().min(1).max(500).transform(normalizeFolder);

const CronText = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (text) => {
      try {
        parseCron(text);
        return true;
      } catch (error) {
        if (error instanceof CronError) return false;
        throw error;
      }
    },
    { error: "Not a valid schedule: five fields, minute hour day month weekday, in UTC" },
  );

export const TriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("schedule"), cron: CronText, folder: Folder.nullable() }),
  z.object({ kind: z.literal("drive_change"), folder: Folder }),
]);

export const NewAutomationSchema = z.object({
  name: z.string().trim().min(1).max(100),
  prompt: z.string().trim().min(1).max(4000),
  trigger: TriggerSchema,
});

export type NewAutomation = z.infer<typeof NewAutomationSchema>;

export interface DocumentRef {
  id: string;
  title: string;
  path: string;
}

/** The first message of a fire's run: the owner's prompt, and the document it's about when there is one. */
export function runMessage(prompt: string, document: DocumentRef | null): string {
  if (!document) return prompt;
  return `${prompt}\n\nThe document: "${document.title}" at ${document.path} (id ${document.id}).`;
}

export const scheduleFireKey = (slot: Date) => `schedule:${slot.toISOString()}`;
export const changeFireKey = (documentId: string, version: number) => `doc:${documentId}:v${version}`;

/** How far back a scheduler looks for a slot it missed (a server that was down). Older slots are dropped. */
export const CATCH_UP_MS = 24 * 60 * 60_000;

/**
 * The slot a scheduler should fire now: the latest one due, after the automation was made and after its last
 * fire, and no older than `CATCH_UP_MS`. A server down over several slots fires only the latest of them.
 */
export function dueSlot(
  cron: Cron | string,
  { now, createdAt, lastFiredAt }: { now: Date; createdAt: Date; lastFiredAt: Date | null },
): Date | null {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const floor = Math.max(createdAt.getTime(), lastFiredAt?.getTime() ?? 0, now.getTime() - CATCH_UP_MS);
  return latestSlot(parsed, new Date(floor), now);
}
