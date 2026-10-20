// For whoever maintains section 20's drills, never the learner: it prints the answers.
// Usage: tsx scripts/ex/drill-seal.ts open <faults.json>   writes every drill's plaintext Fault
//        tsx scripts/ex/drill-seal.ts seal <faults.json>   seals them into src/core/drills/sealed.ts
// Keep faults.json out of the repo. A drill whose edits no longer apply fails src/core/drills/catalog.test.ts.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Fault } from "@/core/drills/types";

import { seal, unseal } from "@/core/drills/seal";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

const [command, file] = process.argv.slice(2);
if ((command !== "open" && command !== "seal") || !file) {
  throw new Error("usage: tsx scripts/ex/drill-seal.ts open|seal <faults.json>");
}

if (command === "open") {
  const { DRILLS } = await import("@/core/drills/catalog");
  const faults = Object.fromEntries(DRILLS.map((drill) => [drill.id, unseal<Fault>(drill.id, drill.sealed)]));
  writeFileSync(file, `${JSON.stringify(faults, null, 2)}\n`);
  console.log(`wrote ${DRILLS.length} drills to ${file}; keep it out of the repo`);
} else {
  const faults = JSON.parse(readFileSync(file, "utf8")) as Record<string, Fault>;
  const out = join(REPO_ROOT, "src/core/drills/sealed.ts");
  const entries = Object.entries(faults).map(
    ([id, fault]) => `  ${JSON.stringify(id)}: ${JSON.stringify(seal(id, fault))},`,
  );
  writeFileSync(
    out,
    [
      "// Section 20's faults, sealed (./seal.ts says how, and how strong that is). Made by scripts/ex/drill-seal.ts.",
      "export const SEALED: Record<string, string> = {",
      ...entries,
      "};",
      "",
    ].join("\n"),
  );
  execFileSync(join(REPO_ROOT, "node_modules/.bin/oxfmt"), [out], { cwd: REPO_ROOT, stdio: "inherit" });
  console.log(`sealed ${entries.length} drills into ${out}`);
}
