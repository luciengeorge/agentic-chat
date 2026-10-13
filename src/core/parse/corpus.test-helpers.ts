import { readFileSync } from "node:fs";
import { join } from "node:path";

const CORPUS = join(import.meta.dirname, "../../../fixtures/corpus");

export interface CorpusFile {
  tenant: string;
  docId: string;
  mimeType: string;
  /** The manifest's page count; PDFs only. */
  pages: number | null;
  /** The source's `format`: pdf, pdf_mixed, scan, handwriting, docx, md or generated. */
  format: string;
  traps: string[];
  bytes: () => Uint8Array<ArrayBuffer>;
  /** The source's body, after its frontmatter. */
  source: () => string;
}

interface ManifestItem {
  kind: string;
  doc_id?: string;
  traps?: string[];
  file?: { blob: string; mime_type: string; pages?: number };
}

/** Every file in the committed corpus build, with its markdown source. */
export function corpusFiles(): CorpusFile[] {
  const manifest = JSON.parse(readFileSync(join(CORPUS, "build/manifest.json"), "utf8")) as {
    sites: Record<string, { items: ManifestItem[] }>;
  };
  return Object.entries(manifest.sites).flatMap(([tenant, site]) =>
    site.items.flatMap((item) => {
      if (item.kind !== "file" || !item.file || !item.doc_id) return [];
      const { blob, mime_type, pages } = item.file;
      const sourcePath = join(CORPUS, "sources", tenant, `${item.doc_id}.md`);
      const raw = readFileSync(sourcePath, "utf8");
      const format = /^format:\s*(\S+)/m.exec(raw)?.[1] ?? "";
      return [
        {
          tenant,
          docId: item.doc_id,
          mimeType: mime_type,
          pages: pages ?? null,
          format,
          traps: item.traps ?? [],
          bytes: () => new Uint8Array(readFileSync(join(CORPUS, "build", blob))),
          source: () => raw.replace(/^---\n[\s\S]*?\n---\n/, ""),
        },
      ];
    }),
  );
}

export function corpusFile(docId: string): CorpusFile {
  const file = corpusFiles().find((f) => f.docId === docId);
  if (!file) throw new Error(`no corpus file ${docId}`);
  return file;
}
