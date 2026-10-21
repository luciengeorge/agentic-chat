/**
 * Loaded with `--import` before a script (`pnpm local:eval` does): turns on the egress monitor for the whole
 * process, then, as the process exits, prints every connection it refused and writes them to EGRESS_REPORT when
 * that's set. A local run that leaves the machine shows up here, and fails, since the connection was refused.
 */
import { writeFileSync } from "node:fs";

import { guardEgress } from "#learn/local/egress";

const guard = guardEgress();

process.on("exit", () => {
  const hosts = [...new Set(guard.allowed)].sort();
  process.stderr.write(
    `egress monitor: ${guard.blocked.length} connections refused` +
      (guard.blocked.length ? ` (${guard.blocked.map((a) => `${a.host}:${a.port}`).join(", ")})` : "") +
      `; allowed ${hosts.join(", ") || "none"}\n`,
  );
  if (process.env.EGRESS_REPORT) {
    writeFileSync(
      process.env.EGRESS_REPORT,
      `${JSON.stringify({ blocked: guard.blocked, allowed: hosts }, null, 2)}\n`,
    );
  }
});
