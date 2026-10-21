import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");
/** Read only, and big: linked, not copied. */
const LINKED = ["node_modules", "fixtures"];

export function gitIn(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Commits everything in `root` as a fresh repo, so a test can watch what git sees. */
export function commitAll(root: string): void {
  gitIn(root, ["init", "-q", "-b", "main"]);
  gitIn(root, ["add", "-A"]);
  gitIn(root, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"]);
}

/**
 * A copy of this repo's working tree (tracked and untracked files, not ignored ones) in a fresh git repo of its
 * own, with node_modules and fixtures linked. A drill can be planted there and its test run, without touching the
 * real repo. `cleanup()` deletes it.
 */
export function copyRepo(): { root: string; cleanup(): void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ex-drill-repo-")));
  const files = gitIn(REPO, ["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  for (const file of files) {
    if (LINKED.some((dir) => file.startsWith(`${dir}/`))) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    try {
      copyFileSync(join(REPO, file), join(root, file));
    } catch (error) {
      // A file deleted in the working tree but still tracked.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const dir of LINKED) symlinkSync(join(REPO, dir), join(root, dir), "dir");
  // The links are ignored, as node_modules is in the real repo; fixtures stays out of this repo's history.
  appendFileSync(join(root, ".gitignore"), "/fixtures\n");
  commitAll(root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
