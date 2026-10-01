# M0b contract

The shared agreements for the M0b lanes: schema, directory, corpus and fake-workspace. `PLAN.md` is the source of truth for the why, and `docs/m0a-contract.md` still holds for everything M0a set up (env vars, ports, Compose, `ex` conventions, quality bar). If a lane has to break this contract, it says so in its report instead of silently diverging.

**Done when:**
- `ex fixtures` builds the realm exports and the corpus, and two builds from the same inputs are byte-identical.
- Keycloak imports both full realms with the ids `fixtures/world.yaml` implies, and every seeded user can log in.
- fake-workspace serves the corpus with its sharing: Kestrel's token sees the M&A memo shared with `/Kestrel/Exec` only, and Harbour's token is refused on Kestrel's site.
- Migration `0002` adds the content, identity, conversation and audit tables.
- `ex smoke` passes, including two new checks: fake-workspace (7th) and the directory (8th).

## Lanes and file ownership

| Lane | Owns |
|---|---|
| S. Schema | `packages/db/**` |
| W. World + directory | `packages/fixtures/src/ac_fixtures/{world,sources,directory}.py`, their tests, `fixtures/directory/**` |
| C1a. Content: Finance, Exec, Legal | `fixtures/corpus/sources/kestrel/` files whose `folder` is under `/Finance`, `/Exec` or `/Legal`, except the regulatory filing |
| C1b. Content: Company, HR, Engineering, Sales, Harbour | the other files in `fixtures/corpus/sources/kestrel/`, and all of `fixtures/corpus/sources/harbour/` |
| C2. Rendering + `ex fixtures` | `packages/fixtures/src/ac_fixtures/corpus/**` and its tests, `fixtures/corpus/fonts/**`, `fixtures/corpus/sources/kestrel/legal-regulatory-filing-2026.md`, `scripts/ex/src/ac_ex/fixtures.py`, the `fixtures` command in `scripts/ex/src/ac_ex/cli.py` |
| F. fake-workspace | `apps/fake_workspace/**` (not its Dockerfile) |
| Integrator (later) | `infra/**`, `ex smoke`, CI, docs |

`fixtures/world.yaml` is written and owned by the orchestrator. Read it; don't edit it. If it's wrong or missing something you need, say so in your report.

Adding a dependency to a member you own and running `uv sync` is fine. C2 and W both add dependencies to `packages/fixtures/pyproject.toml`; edit only the `dependencies` list, and re-read the file right before you write it.

## The world (`fixtures/world.yaml` → `ac_fixtures.world`, lane W)

Lane W ships `world.py` and `sources.py` **first**, then tells lanes C1a, C1b and C2 (SendMessage) that they're ready, before starting on the directory generator.

```python
# ac_fixtures.world
def load_world(path: Path | None = None) -> World      # default: <repo>/fixtures/world.yaml; validates everything below
class World:      # pydantic, frozen
    id_namespace: UUID
    today: date
    tenants: dict[str, Tenant]                           # "kestrel", "harbour"
    def user_id(self, tenant: str, username: str) -> UUID
    def group_id(self, tenant: str, path: str) -> UUID   # "/Kestrel/Finance/AP"
    def item_id(self, tenant: str, path: str) -> UUID    # workspace items; "/" is the root folder
    def effective_grants(self, tenant: str, folder: str) -> tuple[ResolvedGrant, ...]
class Tenant:     # name, domain, password, facts, groups, users, folders
    def user(self, username: str) -> User
class User:       # username, name, title, groups, roles (default ("employee",)), persona, enabled (default True); .email
class ResolvedGrant:  # principal_type: "user" | "group", principal_id, principal_name (username or group path), role: "read" | "write", inherited_from: str | None (the folder path that granted it; None when it's the folder's own)
```

- **Ids:** `uuid5(id_namespace, f"{tenant}:{kind}:{name}")`, where kind is `user`, `group` or `item` and name is the username, group path or item path. Keycloak, the manifest and fake-workspace all use these, so they agree without a lookup table.
- **Validation:** group parents exist; usernames are unique within a tenant; every group a user lists exists; folder parents exist; every grant names an existing user or group in the same tenant.
- **Sharing:** a folder's effective grants are its parent's (only when `inherit`, the default) followed by its own. The root shares nothing. When the same principal appears twice, it gets the stronger role.

## Document sources (`fixtures/corpus/sources/<tenant>/<id>.md` → `ac_fixtures.sources`, lane W)

Each document is one markdown file: YAML frontmatter, then the body.

```yaml
---
id: finance-q3-2026-quarterly-report   # kebab-case, unique within the tenant, equal to the file stem
title: Q3 2026 Quarterly Report
folder: /Finance/Reports              # must be a folder in world.yaml
filename: Q3 2026 Quarterly Report.pdf
format: pdf                           # pdf | pdf_mixed | scan | handwriting | docx | md | generated
author: tom.whitfield                 # a username in the same tenant
created: 2026-09-08
modified: 2026-09-09                  # created <= modified <= world.today
valid_from: 2026-07-01                # optional; policies
valid_to: 2026-06-30                  # optional
traps: [tables]                       # optional; see the trap list
permissions:                          # optional: item-level sharing, same rules as folders
  inherit: false
  grants: [{group: /Kestrel/Engineering/Payments, role: read}, {user: lena.fischer, role: read}]
generator: regulatory_filing          # only for format: generated, with pages and seed
pages: 3000
seed: 2026
---
```

- The filename extension follows the format: `.pdf` for pdf, pdf_mixed, scan, handwriting and generated; `.docx` for docx; `.md` for md. Filenames are unique within a folder.
- **Body:** CommonMark plus GFM pipe tables. Headings, paragraphs, lists, bold and italic, tables. No images or raw HTML, apart from these directives, which renderers must honour and validation enforces:
  - `<!-- pagebreak -->` starts a new page (pdf, pdf_mixed, scan, docx).
  - `<!-- scan-begin -->` … `<!-- scan-end -->`: the enclosed content renders as scanned image pages with no text layer (pdf_mixed only).
  - `<!-- hidden-begin -->` … `<!-- hidden-end -->`: the enclosed text is invisible to a reader (white, 1pt) but present in the text layer (pdf, pdf_mixed, docx). This is how the prompt injection hides.
- `python -m ac_fixtures.sources` validates every source against the world and prints a summary (counts per tenant, format and trap), or every problem it found, exiting 1.

```python
def load_sources(world: World, root: Path | None = None) -> list[Source]   # raises SourceError listing every problem
class Source:  # tenant, file: Path, meta: SourceMeta, body: str
```

## Corpus requirements (lanes C1a and C1b)

Write like real internal documents at the company: specific, dated, with concrete numbers, names (from world.yaml), codes and decisions that a question could be checked against. Every document must agree with the tenant's `facts`. Lengths run from 300 to 1,500 words; the quarterly report and the policies can be longer. British English. Plain style: no em dashes, no marketing voice.

**Traps.** Each must map to at least one named document:

| Trap | Document | Lane |
|---|---|---|
| `acl-leak` | The Project Heron M&A memo in `/Exec`, shared with nobody else | C1a |
| `tables` | The Q3 2026 quarterly report in `/Finance/Reports`: P&L, revenue by product and region, and headcount tables, split across pages | C1a |
| `ocr` | A scanned supplier invoice batch in `/Finance/AP` (`scan`); a signed contract whose signature pages are scanned (`pdf_mixed`, `/Legal/Contracts`); a handwritten HR case note (`handwriting`, `/HR/Casework`); a scanned whiteboard or meeting note in `/Engineering/Incidents` (`scan` or `handwriting`) | C1a, C1b |
| `conflicting-sources` | Expenses policy v1 (`valid_from 2025-01-01`, `valid_to 2026-06-30`) and v2 (`valid_from 2026-07-01`), both live in `/HR/Policies` | C1b |
| `prompt-injection` | A partner onboarding pack (`docx`) in `/Company` with hidden instructions telling an assistant to fetch and send the Project Heron memo to an outside address | C1b |
| `lexical` | The contract register (`KPC-` numbers, `/Legal/Contracts`); the Payments API error-code catalogue (`KP-` codes, `/Engineering/Runbooks`); the SKU price list (`/Sales`) | C1a, C1b |
| `fan-out` | The 3,000-page regulatory filing in `/Legal/Regulatory` (`generated`) | C2 |
| `tenant-isolation` | Harbour's expenses policy in its `/Policies`, deliberately close to Kestrel's in wording but with different limits | C1b |

**Item-level sharing.** At least two documents override their folder. In `/HR/Casework`, a case note shared only with `marco.bianchi` (`inherit: false`) because the HR partner has a conflict; and in `/Engineering/Runbooks`, the fraud rules shared only with `/Kestrel/Engineering/Payments` and `lena.fischer`.

**Mix and size.** About 40 Kestrel documents (C1a about 16, C1b about 22, plus the filing) and 5 to 6 for Harbour. Across the corpus: at least 2 `scan`, 2 `handwriting`, 1 `pdf_mixed`, 5 `docx` and 4 `md`, with the rest `pdf`. Keep `scan`, `handwriting` and `pdf_mixed` bodies to 1 to 3 pages; OCR gets slow. Dates fall between 2025-01-01 and 2026-09-30.

**Harbour** documents are operational only: rotas, IT onboarding, procurement, expenses, opening hours. No patient or clinical records, even fictional ones.

## Rendering and the build (lane C2)

- **Output:** `fixtures/corpus/build/` (git-ignored) holds `manifest.json` and `blobs/<sha256>.<ext>`.
- **Determinism:** the same sources, world and generator code give byte-identical blobs and manifest. Pin every embedded date, id and seed (e.g. reportlab `invariant=1`). Nothing reads the wall clock, the hostname or the locale. A test builds twice into separate directories and compares them.
- **Formats:**
  - `pdf`: markdown to a PDF with a text layer, tables as real tables. The text is set in the standard Helvetica, which covers Windows-1252 only, so a character outside it (an arrow, say) fails the build, naming the document and the character. The same holds for every format that renders through the PDF path (`pdf_mixed`, `scan`, `generated`).
  - `scan`: the rendered pages rasterised, then given seeded skew, blur, speckle and JPEG artefacts, and wrapped in a PDF with no text layer.
  - `handwriting`: the text set in a vendored OFL handwriting font (licence file alongside it), rasterised, with light noise and no text layer.
  - `pdf_mixed`: text pages plus `scan-begin` regions as image-only pages.
  - `docx`: python-docx with real headings, lists and tables, and `hidden` runs as white 1pt text.
  - `md`: the body, without leading blank lines.
  - `generated`: the regulatory filing, which is 3,000 pages from a seeded template.
  - Every PDF has a 1-based page order that later page mapping can rely on.
- **Incremental:** a document is re-rendered only when its source, the world or the renderer version changed. Record an input hash per document.

**`manifest.json`** (read by fake-workspace):

```jsonc
{
  "version": 1,
  "sites": {
    "kestrel": {
      "items": [   // every folder (including the root: path "/", name "root") and every file, parents before children
        {
          "id": "<world.item_id(tenant, path)>",
          "path": "/Finance/Reports/Q3 2026 Quarterly Report.pdf",
          "name": "Q3 2026 Quarterly Report.pdf",
          "parent_id": "<uuid>",            // null for the root
          "kind": "file",                   // folder | file
          "created": "2026-09-08T09:00:00Z",
          "modified": "2026-09-09T16:30:00Z",
          "created_by": "<user id>", "modified_by": "<user id>",
          "file": {"mime_type": "application/pdf", "size": 182345, "sha256": "...", "blob": "blobs/<sha256>.pdf", "pages": 14},  // files only; "pages" only on PDFs, absent for docx and md
          "doc_id": "finance-q3-2026-quarterly-report",   // files only
          "format": "pdf", "traps": ["tables"], "valid_from": null, "valid_to": null,
          "sharing": {"inherit": true, "grants": [{"principal_type": "group", "principal_id": "<uuid>", "principal_name": "/Kestrel/Finance", "role": "read"}]}
          // sharing.grants are the item's OWN grants; fake-workspace computes inheritance
        }
      ]
    }
  }
}
```

Each site also carries `"users": {"<user id>": {"username": "...", "display_name": "..."}}` and `"groups": {"<group id>": {"path": "..."}}`, listing every user (disabled ones included) and every group in the tenant. fake-workspace fills Graph identities (`displayName`) from `users`, and refuses to load a manifest, or to accept a sharing change, that grants to a user or group missing from its own site's maps. A group grant must match both its id and its path. Groups use their path as `principal_name` and `displayName`.

The keys are sorted and the JSON is written in a stable form. Folders take `created`/`modified` from world.today. A folder's author comes from its effective write grants, its own before the inherited ones: a user grant names the user, and a group grant resolves to the group's first enabled member (directly or through a subgroup). With no write grant (the root), it's the tenant's first enabled admin. A file's times are its frontmatter dates at a fixed time of day derived from its id.

Blobs are content-addressed (`blobs/<sha256>.<ext>`), so two files with the same bytes share one blob.

**`ex fixtures [--json] [--clean] [--verify]`**:
- With no flags, it regenerates the realm exports (lane W's `ac_fixtures.directory`), builds the corpus incrementally, and, if fake-workspace is running, calls `POST /_control/reset`.
- `--verify` builds twice into temporary directories and fails if any byte differs. It touches neither the real build nor the running stack.
- `--json` output: `{"directory": {"changed": [...files], "recreated": [...services], "detail": "..." | null}, "corpus": {"documents": n, "rendered": n, "reused": n, "bytes": n, "manifest_sha256": "..."}, "workspace": {"reset": true | false, "detail": "..."}, "duration_s": n}`.
- `--verify --json` output: `{"verify": {"identical": bool, "files": n, "differences": ["<path>: bytes differ" | "<path>: only in the first build" | ...]}, "corpus": {...as above, for the first build}, "duration_s": n}`.
- If Keycloak hasn't loaded the realm exports on disk and is running, it recreates Keycloak (`compose up --wait --force-recreate --no-deps`), since Keycloak imports realms only when its container is created. A new container signs with new keys, and Envoy caches the JWKS for 60 seconds, so a running Envoy is recreated after it: Envoy fetches the keys before it opens its listener, so no request sees a 401 for a good token. `directory.recreated` lists what was recreated. A stopped Keycloak container is removed instead, so the next `ex up` imports the new exports. A failed recreate fails the command, after the fake-workspace reset still runs.
- **Pending reloads:** `.ex/realm-applied.json` records `{"digest", "keycloak", "envoy_pending"}`: the sha256 of the realm exports (`fixtures/directory/*-realm.json` only, so a stray `.DS_Store` doesn't count), the id of the Keycloak container that imported them (from `compose ps`), and whether Envoy still has to fetch that container's keys. Every run reads `compose ps` and recreates Keycloak when the digest or the container differs from the record. So a failed reload is retried until it succeeds, and so is a Keycloak created elsewhere: another branch's `ex down && ex up` makes a container from that branch's exports, and only its id gives it away. Keycloak's part is recorded as soon as its recreate succeeds; if Envoy's then fails, the next run recreates only Envoy, since recreating Keycloak again would rotate its keys and drop sessions. A stopped Keycloak is compared with the record first: if it loaded these exports (a reboot stopped the stack, say), it's left alone, and `ex up` starts it again as it was. Only a stopped Keycloak that doesn't match is removed. A removal, or a stack with no Keycloak container, records `"keycloak": null`. `ex up` closes that gap: when the Keycloak container's id changed across the `compose up`, the new container has just imported the exports on disk, so `ex up` records `{digest on disk, new id, envoy_pending: false}`, and the next `ex fixtures` does nothing. Otherwise (a fresh clone, or a Keycloak created some other way) the first `ex fixtures` that finds a container with no matching record reloads it once. If `docker compose ps` itself fails (the daemon is down, say), the command fails and the reload stays pending; "no stack" means that command succeeded and listed no Keycloak container. With no `docker` on PATH at all, the reload just stays pending.

## Directory (lane W)

- `ac_fixtures.directory` generates `fixtures/directory/{kestrel,harbour}-realm.json` from world.yaml.
- **What it keeps:** everything the current exports set up for M0a, unchanged: the `web-bff` client, the mappers, `aud`, the `tenant` claim, the admin and employee roles, and the smoke users with their passwords.
- **What it adds:** the group tree with fixed `id`s (`world.group_id`), and users with fixed `id`s, emails, first and last names, `enabled`, realm roles, group memberships and the tenant's password. It also adds a `title` user attribute.
- **Output:** stable (sorted keys, two-space indent, trailing newline). A test asserts the committed files equal the generator's output.
- **Live check:** recreate Keycloak; then the admin API returns the expected ids for a user and a nested group, a seeded user (e.g. `leo.martin`) can log in, and the disabled user can't. Verify that Keycloak's import really keeps the given ids.

## Schema (lane S): migration `0002_content`

Every table has `tenant_id uuid not null references tenants(id)` and the same RLS policy as `outbox` (enabled, not forced). `ac_db.models` matches the migrations exactly. The drift test runs alembic's `compare_metadata` with `compare_server_default=True`, as `migrations/env.py` does. It also compares the catalog of the migrated database (columns with their types, nullability and defaults; every constraint by name and definition; every index by definition, so partial-index predicates and `INCLUDE` count; sequences, cache size included; non-internal triggers) with a database built from the models, since `compare_metadata` skips CHECKs, predicates, sequences and triggers. `updated_at` columns are `onupdate=func.now()` in the models, which only the ORM applies: a raw UPDATE or an `on_conflict_do_update` upsert must set `updated_at` itself. The column lists below are the floor; add what correctness needs and say why.

- `principals(id uuid pk, tenant_id, kind text check in ('user','group'), external_id text, name text, display_name text, email text null, enabled bool, synced_at timestamptz, unique(tenant_id, kind, external_id))`. For users, name is the username; for groups, the path.
- `group_members(tenant_id, group_id → principals, member_id → principals, pk(group_id, member_id))`: direct memberships only. A member is a user or a group.
- `group_closure(tenant_id, group_id, member_id, depth int check (depth >= 1), pk(group_id, member_id), check (group_id <> member_id))`: computed. Every ancestor group paired with every descendant user and group, with no self rows, so a direct member has depth 1. The member index is `(member_id, group_id) INCLUDE (tenant_id)`, so "which groups is this user in?" stays index-only once RLS is forced. A cycle in `group_members` would produce `(g, g)` pairs, which the builder must skip.
- `documents(id uuid pk, tenant_id, source text, external_id text, title, path, mime_type, version int, source_version text, content_hash text, storage_key text null, status text check in ('pending','ingesting','ready','failed','deleted'), acl_version bigint not null default 0, valid_from date null, valid_to date null, created_at, updated_at, deleted_at null, unique(tenant_id, source, external_id))`.
- `document_acl(tenant_id, document_id → documents on delete cascade, principal_id → principals, effect text check in ('allow','deny'), acl_version bigint, pk(document_id, principal_id))`.
- **`acl_version`** comes from one global sequence, `acl_version_seq` (created in 0002). Every ACL change on a document sets `documents.acl_version = nextval('acl_version_seq')`, and the `document_acl` rows it writes carry that same value. 0 means the document has no ACL yet. So the values order ACL changes across every document and tenant, which the section 20 stale-ACL drill relies on (see `retrieval_audit`). The sequence's cache is 1, and must stay so: with a larger cache each session draws from its own block, and values stop following the order of the calls. Decided: the drill dates document ACL changes only. Group-membership changes and a principal's `enabled` don't advance the sequence, and section 09's sync leaves it alone for them, so the drill can't date them. A drill on revoked memberships would need its own version column on `principals` and `group_members`.
- `chunks(id uuid pk, tenant_id, document_id → documents on delete cascade, document_version int, ordinal int, text, page_start int null, page_end int null, section text null, token_count int, embedding vector(1536) null, embedding_model_version text null, created_at, unique(document_id, document_version, ordinal))`. md and docx have no pages, so a chunk has both pages or neither: `chunks_pages_check` is `(page_start IS NULL) = (page_end IS NULL) AND (page_end IS NULL OR page_end >= page_start)`. Enable the `vector` extension in the migration (`CREATE EXTENSION IF NOT EXISTS vector`); it's already created in dev, and CI's pgvector image has it. **No HNSW index yet**: section 06 builds it.
- `sync_state(tenant_id, connector text, scope text, cursor text null, delta_token text null, last_full_crawl_at null, last_delta_at null, updated_at, pk(tenant_id, connector, scope))`.
- `conversations(id uuid pk, tenant_id, user_id → principals, title text null, created_at, updated_at)`.
- `messages(id uuid pk, tenant_id, conversation_id → conversations on delete cascade, seq int, role text check in ('user','assistant','system','tool'), content jsonb, idempotency_key text null, created_at, unique(conversation_id, seq), unique(conversation_id, idempotency_key))`. `content` is a JSON object or array: `messages_content_check` is `jsonb_typeof(content) IN ('object', 'array')`, since `NOT NULL` lets JSON `null` through and the ORM writes `None` as JSON `null`.
- `retrieval_audit(id uuid pk, tenant_id, user_id → principals, query_hash text, returned_ids uuid[], denied_ids uuid[], acl_version bigint, created_at)`. `acl_version` is `acl_version_seq`'s high-water mark when the query ran: read it with `SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM acl_version_seq`. It reads 0 before the first `nextval`, where `last_value` alone reads 1, and it needs SELECT on the sequence: USAGE alone gets "permission denied", which is what we want, since `pg_sequence_last_value` would return NULL silently instead. Section 09 grants SELECT when it adds the app role.
  - **When to read it.** Read the mark after the retrieval query, in the same transaction; under REPEATABLE READ it may come anywhere in that transaction, since the snapshot is taken first. Then every change the query saw has a version at or below the mark, so a document above the mark changed after the query and the query didn't see that change. Under READ COMMITTED a mark read before the query is too low: a change that draws its value and commits between the two reads is visible to the query, yet its version is above the mark, so it looks newer than the query.
  - **What it can't tell.** Read after the query, the mark still misses something. A revoke that draws its value and commits between the query and the mark read sits at or below the mark, so the drill can't tell it from a change the query saw. That's acceptable only because the query didn't see it either: the results were right for the ACL the query read, and the miss is confined to the moment between the query and the mark read. More generally, a version at or below the mark doesn't prove the query saw the change: a transaction can draw its value before the query and commit after it.

`runs`, `run_events` and `approvals` are **not** in M0b: the agent reference (M2) settles them. Tests cover the constraints that later steps rely on: duplicate idempotency keys, a duplicate `(conversation_id, seq)`, the cascades, the tenant FK, and that every new table has RLS enabled with the policy.

## fake-workspace (lane F)

It plays each tenant's SharePoint. The shapes follow Microsoft Graph's drive API, simplified, so the section 02 connector teaches real patterns. It serves port 8100.

**Loading:** at start and on reset, it reads `AC_CORPUS_DIR` (default `<repo>/fixtures/corpus/build`; Compose sets `/repo/fixtures/corpus/build`, the bind mount), which holds `manifest.json` and the blobs. All state lives in memory, so a restart resets it. `GET /health` always returns 200, with `"corpus_loaded": bool`. The site APIs return 503 (`{"error": {"code": "serviceNotReady"}}`) until a corpus is loaded.

**Auth:** `Authorization: Bearer <token>`. `dev-workspace-kestrel` and `dev-workspace-harbour` each open only their own site. No token or a bad one is 401; the right token on the wrong site is 403. Errors look like Graph's: `{"error": {"code": "...", "message": "..."}}`.

**Site API** (`/v1.0/sites/{site}/drive/...`; `root` works as an item id):
- `GET root`, `GET items/{id}`: a driveItem. That's `id`, `name`, `eTag` and `cTag` (both change on edit; `eTag` also on move, rename, or a change to its effective sharing, compared by id: each grant's principal, role, and the id of the ancestor it's inherited from. Renaming an ancestor changes `inheritedFrom.path` without a new eTag, as in Graph), `createdDateTime`, `lastModifiedDateTime`, `size`, `createdBy`/`lastModifiedBy` `{user: {id, displayName}}`, `parentReference {id, path: "/drive/root:/Finance"}`, then `folder {childCount}` or `file {mimeType, hashes {sha256Hash}}`.
- `GET items/{id}/children?$top=N` (default 20, max 200): `{"value": [...], "@odata.nextLink": "..."}`, sorted by name (case-insensitive), then id. The `nextLink` is an absolute URL on the request's host. Paging is by key: the `$skiptoken` holds the sort key of the last child returned, and the next page starts after it. A child renamed past the cursor comes back a second time, so clients dedupe by id and keep the latest copy.
- `GET items/{id}/content`: the bytes, with `Content-Type`.
- `GET items/{id}/permissions`: `{"value": [{"id", "roles": ["read"|"write"], "grantedToV2": {"user": {...}} | {"group": {"id", "displayName"}}, "inheritedFrom": {"id", "path"}?}]}`. These are the effective grants, own and inherited, with `inheritedFrom` set on inherited ones.
- `GET root/delta[?token=...]`: changes since the token. With no token, it returns every item, then an `@odata.deltaLink`. `token=latest` returns nothing but a `deltaLink`. Deleted items come back as `{"id", "deleted": {"state": "deleted"}, "parentReference"}`. Moves and renames appear as the item with its new `parentReference` or name. Sharing changes appear only when the request carries `Prefer: deltashowsharingchanges`, on items annotated `"@microsoft.graph.sharedChanged": "True"`. Results are paginated with `nextLink`, and the last page carries the `deltaLink`. Tokens are opaque but deterministic.
  - **Order:** with no token, every item in creation order (the manifest's, parents first, then items created since). With a token, each changed item appears once, in its current state, in the order it first changed.
  - **Stale tokens:** a token from another corpus or from before a reset (`ex fixtures` resets), or one ahead of the change log (after a restart), gets 410 `resyncRequired` (inner code `resyncChangesApplyDifferences`) with a `Location` header to enumerate again from. A restart (a new container, or watchfiles restarting the process) starts the change log again, so each token also carries a digest of the log up to its position: each change's item and what it left (name, parent, deleted, version, content hash, modified time, sharing). A token from before a restart still works if the new log reached that position by the same changes, and gets the 410 otherwise, so a connector never skips changes it didn't see.
  - **Sharing changes** are recorded on the item and on every descendant whose effective permissions changed with it (the ones that inherit), so `deltashowsharingchanges` shows each of them.
- `POST /v1.0/subscriptions {changeType: "updated", notificationUrl, resource: "sites/{site}/drive/root", expirationDateTime, clientState}`:
  - **Validation:** it first POSTs to `notificationUrl?validationToken=<token>`, which must answer 200 with the token as `text/plain` within 10 seconds; otherwise it returns 400. If a reset lands while it waits, the subscription isn't created and the request gets 503 `serviceNotAvailable`.
  - **Management:** `PATCH` renews a subscription and `DELETE` removes it.
  - **Notifications:** after every change, it POSTs `{"value": [{"subscriptionId", "clientState", "changeType": "updated", "resource", "subscriptionExpirationDateTime", "tenantId"}]}`. It doesn't say what changed; the client calls `delta`.
  - **Delivery:** in order per subscription, retried with backoff on a non-2xx response, and logged.

**Control API** (`/_control/...`): dev only (refused unless `AC_ENV=dev`), no bearer token. Settings default to dev, so every app image's prod stage sets `ENV AC_ENV=prod`, and a test checks each Dockerfile for it. The test also checks that prod is each Dockerfile's last stage, since a build without `--target` makes the last stage. Every mutation lands in delta and triggers notifications. The control API has no user, so items it creates or changes carry an application identity in `createdBy`/`lastModifiedBy`: `{"application": {"id", "displayName": "fake-workspace"}}`.
- `POST /_control/reset` reloads the manifest and clears faults, subscriptions, deliveries and the change log. Subscription ids are never reused: not across resets, not between subscriptions validated at the same time, and not across restarts (each process mixes a random nonce into them, so they're the one thing that isn't deterministic). Deliveries in flight are cancelled, and a change that lands during the reset notifies nobody.
- `POST /_control/faults {"site"?, "kind": "throttle" | "error" | "latency", "path_prefix"?, "after_requests"?: n, "count"?: n, "retry_after_s"?: n, "status"?: 503, "latency_ms"?: n}` and `DELETE /_control/faults`. A throttle answers 429 with `Retry-After` and a Graph `TooManyRequests` error.
- Item mutations under `/_control/sites/{site}/items`:
  - `POST` with `{parent_id, name, content_base64, mime_type}` creates a file.
  - `PUT {id}/content` uploads a new version.
  - `POST {id}/move` with `{parent_id, name?}` moves an item; `POST {id}/rename` with `{name}` renames it.
  - `DELETE {id}` deletes it (a folder's descendants go with it).
  - `PUT {id}/sharing` with `{inherit, grants}` changes its sharing. Every grant must name a user or group of that site: a user by id, a group by id and path together (its path is the `displayName` that permissions show). Anything else is 400.
- `POST /_control/clock {"now": "<iso>"}` pins the time used for timestamps; without it, the server uses real time.
- `GET /_control/deliveries` returns the webhook log, and `POST /_control/flush` waits until pending deliveries are done.

**Determinism:** the same manifest and the same calls give the same ids, eTags, tokens and ordering. Subscription ids are the exception (see reset). The ids of new items derive from the site, the path and a counter.

Lane F tests against small manifests built in the tests, not the real corpus. Use real HTTP for the webhook paths: a test receiver on localhost.

## `ex smoke` checks 7 and 8 (integrator)

**7. fake-workspace pages and shares.** As Kestrel's connector:
- list the root's children with `$top=2` and follow `nextLink`;
- find the Project Heron memo through the manifest (`traps` contains `acl-leak`), and check that its permissions grant exactly one thing: the `write` role to the group `/Kestrel/Exec`, matched by the world's group id as well as its name;
- then check that Harbour's token on Kestrel's site is 403.

It reads the manifest from `<repo>/fixtures/corpus/build/manifest.json`, the build Compose mounts, and also checks that the pages hold `$top` or fewer children and add up to the root's distinct `childCount`. It follows at most one page more than that count needs, so a `nextLink` that never ends fails the check. A 503 means no corpus is loaded, and the check says to run `ex fixtures`. So does a 404 for the memo: fake-workspace serves an older corpus than the host's manifest.

**8. Directory logins and ids.**
- `leo.martin` signs in through the BFF with the tenant's password, and `/api/me` says `kestrel`.
- `peter.hall`, who is disabled, posts the same password, gets no session, and Keycloak's page says "Account is disabled". A refusal for any other reason (a wrong password, say) fails the check.
- With the dev admin credentials that Compose bootstraps Keycloak with (read from `infra/compose.yaml`), the admin API returns `leo.martin`, `peter.hall` and the nested group `/Kestrel/Finance/AP`, each with the id `fixtures/world.yaml` implies.

## Settled during the build

The lanes and the integrator changed or pinned down these points; the sections above already say them.

- `ex fixtures --verify --json` has its own shape (`verify.identical`, `verify.files`, `verify.differences`), and `directory` gained `detail` and `recreated`.
- `ex fixtures` recreates Keycloak, then Envoy, when the realm exports change.
- A folder's author: its own write grants first, a group resolves to its first enabled member, otherwise the tenant's first enabled admin.
- PDF text is Windows-1252 only.
- The manifest's root is named `root`; `file.pages` is on PDFs only; blobs are shared between identical files.
- fake-workspace: full delta in creation order; 410 `resyncRequired` on stale tokens; sharing changes recorded for every inheriting descendant; control changes attributed to an application identity.
- **Delta order:** a full enumeration comes in creation order, so a folder moved under a newer one can arrive after its own children, as in Graph. Section 02 must buffer items whose parent it hasn't seen yet.
- **Delta items** carry no `cTag` and no `parentReference.path`: Graph says to track items by id, since renaming a folder doesn't return its descendants.
- **eTag:** an item's eTag changes when its effective sharing changes, inherited grants included, so a connector that skips unchanged eTags can't keep a revoked grant. The comparison is by id: each grant's principal, role, and the id of the ancestor it's inherited from. So a grant that moves to another ancestor with the same role counts, and also lands in the sharing delta, while renaming an ancestor changes only `inheritedFrom.path` and, as in Graph, no eTag. The cTag doesn't change.
- **Paging:** children are paged by key, so a delete or insert between pages can't skip a child that was there from the start or return one twice. A child added or renamed behind the cursor mid-crawl isn't returned: take a `token=latest` delta before the crawl and replay it afterwards. One renamed past the cursor comes back twice, so dedupe by id.
- **SSRF:** declined. fake-workspace POSTs to any `notificationUrl`, as Graph does, and it runs only on a developer's machine. Don't deploy it.
- **Webhook `tenantId`** is a uuid fake-workspace makes up per site. It has nothing to do with the `tenants` table.
- **Login:** a user must exist as a principal before they can own conversations or audit rows. M1's api upserts the principal from the token's `sub` at login (sections 10 and 11).
- The manifest lists each site's groups by id (`groups`), and fake-workspace refuses a group grant whose id and path aren't a group of that site.
- **Delta tokens across restarts** carry a digest of the change log, so a token from before a restart is refused (410) unless the new log repeats the changes up to its position.
- **Realm reloads** are retried until one succeeds, and the record (`.ex/realm-applied.json`) names the Keycloak container as well as the exports' digest, so a container made from another branch's exports is reloaded too. A failed `docker compose ps` fails `ex fixtures` instead of passing for "no stack".
