/**
 * The committed corpus build as the evals see it: each tenant's files from `manifest.json`, their markdown sources,
 * and who may read what. Access is worked out here from the world and the manifest's sharing, independently of the
 * app's ACL code, so the golden set's checks can't share a bug with what they check.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { World } from "./world";

export const DEFAULT_CORPUS_DIR = fileURLToPath(new URL("../../fixtures/corpus", import.meta.url));

interface ManifestItem {
  id: string;
  kind: "file" | "folder";
  path: string;
  parent_id: string | null;
  doc_id?: string;
  traps?: string[];
  file?: { blob: string; mime_type: string; pages?: number };
  sharing: { inherit: boolean; grants: { principal_id: string }[] };
}

export interface CorpusDocument {
  tenant: string;
  path: string;
  docId: string;
  mimeType: string;
  /** PDFs only. */
  pages: number | null;
  traps: string[];
  /** Absolute path of the built file. */
  blobPath: string;
  /** Principal ids with a grant on the file, its own or inherited. */
  principals: ReadonlySet<string>;
}

export class Corpus {
  private readonly byTenant = new Map<string, CorpusDocument[]>();

  constructor(
    private readonly world: World,
    private readonly dir: string = DEFAULT_CORPUS_DIR,
  ) {
    const manifest = JSON.parse(readFileSync(join(dir, "build/manifest.json"), "utf8")) as {
      sites: Record<string, { items: ManifestItem[] }>;
    };
    for (const [tenant, site] of Object.entries(manifest.sites)) {
      const items = new Map(site.items.map((item) => [item.id, item]));
      const memo = new Map<string, Set<string>>();
      const effective = (item: ManifestItem): Set<string> => {
        const known = memo.get(item.id);
        if (known) return known;
        const parent = item.parent_id ? items.get(item.parent_id) : undefined;
        const grants = new Set(item.sharing.inherit && parent ? effective(parent) : []);
        for (const grant of item.sharing.grants) grants.add(grant.principal_id);
        memo.set(item.id, grants);
        return grants;
      };
      this.byTenant.set(
        tenant,
        site.items.flatMap((item) =>
          item.kind === "file" && item.file && item.doc_id
            ? [
                {
                  tenant,
                  path: item.path,
                  docId: item.doc_id,
                  mimeType: item.file.mime_type,
                  pages: item.file.pages ?? null,
                  traps: item.traps ?? [],
                  blobPath: join(dir, "build", item.file.blob),
                  principals: effective(item),
                },
              ]
            : [],
        ),
      );
    }
  }

  tenants(): string[] {
    return [...this.byTenant.keys()];
  }

  documents(tenant: string): CorpusDocument[] {
    const documents = this.byTenant.get(tenant);
    if (!documents) throw new Error(`the corpus has no tenant ${tenant}`);
    return documents;
  }

  document(tenant: string, path: string): CorpusDocument | undefined {
    return this.documents(tenant).find((document) => document.path === path);
  }

  /** The user and every group they belong to, directly or through a parent group. Nothing for a disabled user. */
  principals(tenant: string, username: string): Set<string> {
    const user = this.world.user(tenant, username);
    if (!user.enabled) return new Set();
    const ids = new Set([this.world.userId(tenant, username)]);
    for (const group of user.groups) {
      for (let path = group; path !== ""; path = path.slice(0, path.lastIndexOf("/"))) {
        ids.add(this.world.groupId(tenant, path));
      }
    }
    return ids;
  }

  /** The paths of the documents this user may read. */
  readable(tenant: string, username: string): Set<string> {
    const mine = this.principals(tenant, username);
    return new Set(
      this.documents(tenant)
        .filter((document) => [...document.principals].some((id) => mine.has(id)))
        .map((document) => document.path),
    );
  }

  /** The markdown a document was rendered from, without its frontmatter. */
  source(document: CorpusDocument): string {
    const raw = readFileSync(join(this.dir, "sources", document.tenant, `${document.docId}.md`), "utf8");
    return raw.replace(/^---\n[\s\S]*?\n---\n/, "");
  }

  bytes(document: CorpusDocument): Uint8Array<ArrayBuffer> {
    return new Uint8Array(readFileSync(document.blobPath));
  }
}
