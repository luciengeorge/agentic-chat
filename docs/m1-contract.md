# M1 contract (reference RAG)

The shared agreements for M1's lanes. `PLAN.md` says why; `docs/m0-contract.md` still holds for everything M0 set up (env via `acEnv()`, ports, the `#learn` slots, `ex`, the quality bar), and its "Backlog for M1" is part of this milestone's scope where a lane touches that code. If a lane has to break this contract, it says so in its report instead of silently diverging.

**M1 is done when** a question asked in the app is answered with citations, ACLs and tenancy enforced by the database, the Heron memo never reaches `leo.martin`, and the golden set clears its bar. M1 runs in waves of at most two agents.

| Wave | Lanes |
|---|---|
| 1 | A. Ingestion (this file, in detail). B. Parse + chunk (this file, in detail) |
| 2 | C. Retrieval (embeddings, HNSW, pg_search BM25, RRF, rerank, ACL filter, audit). D. Answer + app (model client, generation, citations, auth boundary, chat UI) |
| 3 | Integration + golden set |

Decisions Lucien made for M1: OpenAI only for now (Cohere rerank stays behind `rerank()` with a fake until a key exists); RLS enforced in M1 with a non-owner role and `FORCE`; 1536-dimension embeddings; `gpt-6-luna` with medium reasoning, effort always explicit.

## The rule for code layout

Everything a later exercise will ask the learner to write lives in `src/core/<area>/<module>.ts` and is imported as `#learn/<area>/<module>` by the app, workflows and tests. Glue (routes, workflows, DB writes, wiring) lives outside `src/core`. A module in `src/core` takes its dependencies as arguments (a fetch, a clock, a db handle) so tests can drive it without the stack.

## Wave 1 ownership

| Lane | Owns |
|---|---|
| A. Ingestion | `src/core/connectors/**`, `src/core/directory/**`, `src/core/acl/**`, `src/db/**` (new migrations, roles, the tenant helper), `src/workflows/{sync,ingest}*.ts`, `src/routes/api/webhooks/**`, `src/server/plugins/relay*.ts`, their tests |
| B. Parse + chunk | `src/core/parse/**`, `src/core/chunk/**`, `scripts/parse-compare.ts`, the `docling` service in `compose.yaml`, their tests |

Shared files (`package.json`, `compose.yaml`, `vite.config.ts`, `vitest.config.ts`, `.env.example`, `docs/m1-contract.md` "Settled during the build"): re-read right before writing, change only your lines. Lane A alone uses the live stack (Docker, :3000, :8100); lane B tests offline and runs docling on :5001 only for its comparison, telling lane A first. Neither lane stops Docker or OrbStack. No nested subagents.

## Shared types (lane B writes these first, then tells lane A)

```ts
// src/core/parse/types.ts
export type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "text"; text: string }
  | { kind: "table"; markdown: string; rows: number }
export interface Page { number: number; blocks: Block[]; method: "text-layer" | "ocr"; ocrConfidence?: number }
export interface ParsedDocument { mimeType: string; pages: Page[] | null; blocks: Block[] } // pages null for md/docx
export type Rasterise = (pdf: Uint8Array, pageNumber: number) => Promise<Uint8Array> // PNG
export interface ParseDeps { rasterise: Rasterise; ocr: (png: Uint8Array) => Promise<{ text: string; confidence: number }> }
export function parse(bytes: Uint8Array, mimeType: string, deps: ParseDeps): Promise<ParsedDocument>

// src/core/chunk/types.ts
export interface Chunk { ordinal: number; text: string; pageStart: number | null; pageEnd: number | null; section: string | null; tokenCount: number }
export function chunk(doc: ParsedDocument, options?: { targetTokens?: number; overlapTokens?: number }): Chunk[]
```

## Lane B: parse + chunk

- PDFs: text layer per page with `unpdf` (or `pdfjs-dist`); a page whose text layer is empty or below a threshold is rasterised and OCR'd with `tesseract.js` (word confidences kept; the page's mean goes in `ocrConfidence`). Rasterising uses a native canvas, so it is a dependency the caller passes in (`ParseDeps.rasterise`): Workflow steps can't load native modules on Vercel (workflow #1003), so lane A calls it through a server route. DOCX with `mammoth` (headings, paragraphs, tables). Markdown passes through as blocks.
- Tables become markdown with their header row; a table that runs across pages stays one block per page, header repeated.
- Chunking: token counts with `gpt-tokenizer` (the `o200k_base` encoding), default 512 tokens with 64 overlap. Never split a table row, never split inside an identifier or a word, prefer heading boundaries, carry the nearest heading as `section`, and set pages for PDFs only (both or neither, as the schema's CHECK demands).
- Tests run over the committed corpus (`fixtures/corpus/build`): every one of the 46 documents parses; scans and handwriting go through OCR; the pdf_mixed contract has text pages and OCR'd pages; every KPC-, KP-, SKU and person-name token in a source appears whole in some chunk (the M0b lesson); no chunk exceeds the target by more than one row or sentence; pages are right for a sample of known facts (filing pages 130, 328, 845, 883, 2417, 2468, 2861).
- docling: a `docling` service in `compose.yaml` (`docling-serve-cpu`, pinned tag, :5001, a `profiles: [docling]` so `ex up` doesn't pull 4.4 GB by default) and `scripts/parse-compare.ts`, which runs both parsers over a few trap documents and prints where they differ. It is a comparison tool, not a dependency of ingestion.

## Lane A: ingestion

- **RLS enforced.** A migration creates a non-owner login role `ac_app` (no BYPASSRLS) granted what the app needs, and `FORCE ROW LEVEL SECURITY` on every tenant table. App code reaches tenant data only through `withTenant(tenantId, fn)`, which runs `fn` in a transaction after `SET LOCAL app.tenant_id`. Cross-tenant work (the outbox relay, directory sync across tenants, seeding, migrations) uses the owner role through an explicitly named `systemDb`. `DATABASE_URL` becomes the `ac_app` URL; `DATABASE_ADMIN_URL` the owner's. Tests prove a forgotten `withTenant` sees nothing and a cross-tenant write is refused. The DB pool is a process-wide singleton (`globalThis[Symbol.for("agentic-chat.db")]`) because step code and the Vite graph load modules twice in dev (M0 backlog).
- **Connector** (`src/core/connectors/graph.ts`): a client for fake-workspace's Graph-style API with full crawl (follows `nextLink`), backoff on 429 honouring `Retry-After`, delta (`token=latest` before a crawl, then apply changes; 410 `resyncRequired` restarts with a crawl), dedupe by item id (keyset paging can return an item twice), deletes and moves. Its state lives in `sync_state`.
- **Directory sync** (`src/core/directory/`): users (`accountEnabled: false` makes `principals.enabled = false`), groups, direct members into `group_members`, and `group_closure` computed from them (no self rows, depth from 1); checked against `/transitiveMembers` in a test. Membership and `enabled` changes don't advance `acl_version_seq` (M0 decision).
- **ACL stamping** (`src/core/acl/`): an item's effective permissions (own plus inherited) become `document_acl` rows (`allow`), mapped from Graph ids to `principals`; every change draws a new `acl_version` from the sequence. Postgres stays the only decision point.
- **Storage.** Raw bytes go in a new tenant table `document_blobs(tenant_id, sha256, bytes bytea, size, mime_type)`, content-addressed; `documents.storage_key` is the sha256.
- **Workflows.** A sync workflow (crawl or delta for one tenant) writes `documents` rows and an `outbox` row per document to ingest, in one transaction. The relay (a Nitro plugin loop in dev) claims outbox rows with `FOR UPDATE SKIP LOCKED` and starts an ingest workflow per document, whose first step claims the row by id (the relay can deliver twice). Ingest: download, store the blob, parse (rasterise through a server route), chunk, write `chunks` (no embeddings yet; wave 2 fills them), set `status = ready`. The 3,000-page filing fans out to child runs by page range. Steps use `RetryableError` for 429s and network errors and `FatalError` for bad input, with explicit retry limits.
- **Webhooks.** `POST /api/webhooks/workspace` answers the validation handshake and turns a notification into a delta sync for that tenant through the outbox. It checks `clientState`.
- **Tests and live proof.** Unit tests with fake-workspace in-process and throwaway databases. Live: from an empty `ac`, `pnpm ex up`, `pnpm dev`, `pnpm fake-workspace`, then a full sync of both tenants: all 46 documents `ready` with chunks and ACLs; a rename, a move, a delete and a sharing change made through fake-workspace's control API arrive by webhook and apply; removing `leo.martin` from `/Kestrel/Finance/AP` in the directory removes his closure rows. A new `ex smoke` check, "ingestion", covers counts and one ACL fact (the Heron memo's `document_acl` holds `/Kestrel/Exec` only).

## Settled during the build

(Lanes add what they decide here.)
