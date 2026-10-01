# M0b contract

The shared agreements for the M0b lanes: schema, directory, corpus and fake-workspace. `PLAN.md` is the source of truth for the why, and `docs/m0a-contract.md` still holds for everything M0a set up (env vars, ports, Compose, `ex` conventions, quality bar). If a lane has to break this contract, it says so in its report instead of silently diverging.

**Done when:**
- `ex fixtures` builds the realm exports and the corpus, and two builds from the same inputs are byte-identical.
- Keycloak imports both full realms with the ids `fixtures/world.yaml` implies, and every seeded user can log in.
- fake-workspace serves the corpus with its sharing: Kestrel's token sees the M&A memo shared with `/Kestrel/Exec` only, and Harbour's token is refused on Kestrel's site.
- Migration `0002` adds the content, identity, conversation and audit tables.
- `ex smoke` passes, including a new 7th check on fake-workspace.

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
  - `pdf`: markdown to a PDF with a text layer, tables as real tables.
  - `scan`: the rendered pages rasterised, then given seeded skew, blur, speckle and JPEG artefacts, and wrapped in a PDF with no text layer.
  - `handwriting`: the text set in a vendored OFL handwriting font (licence file alongside it), rasterised, with light noise and no text layer.
  - `pdf_mixed`: text pages plus `scan-begin` regions as image-only pages.
  - `docx`: python-docx with real headings, lists and tables, and `hidden` runs as white 1pt text.
  - `md`: the body, as is.
  - `generated`: the regulatory filing, which is 3,000 pages from a seeded template.
  - Every PDF has a 1-based page order that later page mapping can rely on.
- **Incremental:** a document is re-rendered only when its source, the world or the renderer version changed. Record an input hash per document.

**`manifest.json`** (read by fake-workspace):

```jsonc
{
  "version": 1,
  "sites": {
    "kestrel": {
      "items": [   // every folder (including the root, path "/") and every file, parents before children
        {
          "id": "<world.item_id(tenant, path)>",
          "path": "/Finance/Reports/Q3 2026 Quarterly Report.pdf",
          "name": "Q3 2026 Quarterly Report.pdf",
          "parent_id": "<uuid>",            // null for the root
          "kind": "file",                   // folder | file
          "created": "2026-09-08T09:00:00Z",
          "modified": "2026-09-09T16:30:00Z",
          "created_by": "<user id>", "modified_by": "<user id>",
          "file": {"mime_type": "application/pdf", "size": 182345, "sha256": "...", "blob": "blobs/<sha256>.pdf", "pages": 14},  // files only; pages for PDFs
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

The keys are sorted and the JSON is written in a stable form. Folders take `created`/`modified` from world.today and their author from the first write grant. A file's times are its frontmatter dates at a fixed time of day derived from its id.

**`ex fixtures [--json] [--clean] [--verify]`**:
- With no flags, it regenerates the realm exports (lane W's `ac_fixtures.directory`), builds the corpus incrementally, and, if fake-workspace is running, calls `POST /_control/reset`.
- `--verify` builds twice into temporary directories and fails if any byte differs.
- `--json` output: `{"directory": {"changed": [...files]}, "corpus": {"documents": n, "rendered": n, "reused": n, "bytes": n, "manifest_sha256": "..."}, "workspace": {"reset": true | false, "detail": "..."}, "duration_s": n}`.
- If the realm exports changed and Keycloak is running, it says so: Keycloak needs a recreate, which the integrator wires.

## Directory (lane W)

- `ac_fixtures.directory` generates `fixtures/directory/{kestrel,harbour}-realm.json` from world.yaml.
- **What it keeps:** everything the current exports set up for M0a, unchanged: the `web-bff` client, the mappers, `aud`, the `tenant` claim, the admin and employee roles, and the smoke users with their passwords.
- **What it adds:** the group tree with fixed `id`s (`world.group_id`), and users with fixed `id`s, emails, first and last names, `enabled`, realm roles, group memberships and the tenant's password. It also adds a `title` user attribute.
- **Output:** stable (sorted keys, two-space indent, trailing newline). A test asserts the committed files equal the generator's output.
- **Live check:** recreate Keycloak; then the admin API returns the expected ids for a user and a nested group, a seeded user (e.g. `leo.martin`) can log in, and the disabled user can't. Verify that Keycloak's import really keeps the given ids.

## Schema (lane S): migration `0002_content`

Every table has `tenant_id uuid not null references tenants(id)` and the same RLS policy as `outbox` (enabled, not forced). `ac_db.models` matches the migrations exactly (the drift test). The column lists below are the floor; add what correctness needs and say why.

- `principals(id uuid pk, tenant_id, kind text check in ('user','group'), external_id text, name text, display_name text, email text null, enabled bool, synced_at timestamptz, unique(tenant_id, kind, external_id))`. For users, name is the username; for groups, the path.
- `group_members(tenant_id, group_id → principals, member_id → principals, pk(group_id, member_id))`: direct memberships only. A member is a user or a group.
- `group_closure(tenant_id, group_id, member_id, depth int, pk(group_id, member_id))`: computed. Every ancestor group paired with every descendant user and group.
- `documents(id uuid pk, tenant_id, source text, external_id text, title, path, mime_type, version int, source_version text, content_hash text, storage_key text null, status text check in ('pending','ingesting','ready','failed','deleted'), acl_version bigint not null default 0, valid_from date null, valid_to date null, created_at, updated_at, deleted_at null, unique(tenant_id, source, external_id))`.
- `document_acl(tenant_id, document_id → documents on delete cascade, principal_id → principals, effect text check in ('allow','deny'), acl_version bigint, pk(document_id, principal_id))`.
- `chunks(id uuid pk, tenant_id, document_id → documents on delete cascade, document_version int, ordinal int, text, page_start int, page_end int, section text null, token_count int, embedding vector(1536) null, embedding_model_version text null, created_at, unique(document_id, document_version, ordinal))`. Enable the `vector` extension in the migration (`CREATE EXTENSION IF NOT EXISTS vector`); it's already created in dev, and CI's pgvector image has it. **No HNSW index yet**: section 06 builds it.
- `sync_state(tenant_id, connector text, scope text, cursor text null, delta_token text null, last_full_crawl_at null, last_delta_at null, updated_at, pk(tenant_id, connector, scope))`.
- `conversations(id uuid pk, tenant_id, user_id → principals, title text null, created_at, updated_at)`.
- `messages(id uuid pk, tenant_id, conversation_id → conversations on delete cascade, seq int, role text check in ('user','assistant','system','tool'), content jsonb, idempotency_key text null, created_at, unique(conversation_id, seq), unique(conversation_id, idempotency_key))`.
- `retrieval_audit(id uuid pk, tenant_id, user_id → principals, query_hash text, returned_ids uuid[], denied_ids uuid[], acl_version bigint, created_at)`.

`runs`, `run_events` and `approvals` are **not** in M0b: the agent reference (M2) settles them. Tests cover the constraints that later steps rely on: duplicate idempotency keys, a duplicate `(conversation_id, seq)`, the cascades, the tenant FK, and that every new table has RLS enabled with the policy.

## fake-workspace (lane F)

It plays each tenant's SharePoint. The shapes follow Microsoft Graph's drive API, simplified, so the section 02 connector teaches real patterns. It serves port 8100.

**Loading:** at start and on reset, it reads `AC_CORPUS_DIR` (default `<repo>/fixtures/corpus/build`), which holds `manifest.json` and the blobs. All state lives in memory, so a restart resets it. `GET /health` always returns 200, with `"corpus_loaded": bool`. The site APIs return 503 (`{"error": {"code": "serviceNotReady"}}`) until a corpus is loaded.

**Auth:** `Authorization: Bearer <token>`. `dev-workspace-kestrel` and `dev-workspace-harbour` each open only their own site. No token or a bad one is 401; the right token on the wrong site is 403. Errors look like Graph's: `{"error": {"code": "...", "message": "..."}}`.

**Site API** (`/v1.0/sites/{site}/drive/...`; `root` works as an item id):
- `GET root`, `GET items/{id}`: a driveItem. That's `id`, `name`, `eTag` and `cTag` (both change on edit; `eTag` also on move, rename or sharing change), `createdDateTime`, `lastModifiedDateTime`, `size`, `createdBy`/`lastModifiedBy` `{user: {id, displayName}}`, `parentReference {id, path: "/drive/root:/Finance"}`, then `folder {childCount}` or `file {mimeType, hashes {sha256Hash}}`.
- `GET items/{id}/children?$top=N` (default 20, max 200): `{"value": [...], "@odata.nextLink": "..."}`, sorted by name (case-insensitive), then id. The `nextLink` is an absolute URL on the request's host.
- `GET items/{id}/content`: the bytes, with `Content-Type`.
- `GET items/{id}/permissions`: `{"value": [{"id", "roles": ["read"|"write"], "grantedToV2": {"user": {...}} | {"group": {"id", "displayName"}}, "inheritedFrom": {"id", "path"}?}]}`. These are the effective grants, own and inherited, with `inheritedFrom` set on inherited ones.
- `GET root/delta[?token=...]`: changes since the token. With no token, it returns every item, then an `@odata.deltaLink`. `token=latest` returns nothing but a `deltaLink`. Deleted items come back as `{"id", "deleted": {"state": "deleted"}, "parentReference"}`. Moves and renames appear as the item with its new `parentReference` or name. Sharing changes appear only when the request carries `Prefer: deltashowsharingchanges`, on items annotated `"@microsoft.graph.sharedChanged": "True"`. Results are paginated with `nextLink`, and the last page carries the `deltaLink`. Tokens are opaque but deterministic.
- `POST /v1.0/subscriptions {changeType: "updated", notificationUrl, resource: "sites/{site}/drive/root", expirationDateTime, clientState}`:
  - **Validation:** it first POSTs to `notificationUrl?validationToken=<token>`, which must answer 200 with the token as `text/plain` within 10 seconds; otherwise it returns 400.
  - **Management:** `PATCH` renews a subscription and `DELETE` removes it.
  - **Notifications:** after every change, it POSTs `{"value": [{"subscriptionId", "clientState", "changeType": "updated", "resource", "subscriptionExpirationDateTime", "tenantId"}]}`. It doesn't say what changed; the client calls `delta`.
  - **Delivery:** in order per subscription, retried with backoff on a non-2xx response, and logged.

**Control API** (`/_control/...`): dev only (refused unless `AC_ENV=dev`), no bearer token. Every mutation lands in delta and triggers notifications.
- `POST /_control/reset` reloads the manifest and clears faults, subscriptions, deliveries and the change log.
- `POST /_control/faults {"site"?, "kind": "throttle" | "error" | "latency", "path_prefix"?, "after_requests"?: n, "count"?: n, "retry_after_s"?: n, "status"?: 503, "latency_ms"?: n}` and `DELETE /_control/faults`. A throttle answers 429 with `Retry-After` and a Graph `TooManyRequests` error.
- Item mutations under `/_control/sites/{site}/items`:
  - `POST` with `{parent_id, name, content_base64, mime_type}` creates a file.
  - `PUT {id}/content` uploads a new version.
  - `POST {id}/move` with `{parent_id, name?}` moves an item; `POST {id}/rename` with `{name}` renames it.
  - `DELETE {id}` deletes it (a folder's descendants go with it).
  - `PUT {id}/sharing` with `{inherit, grants}` changes its sharing.
- `POST /_control/clock {"now": "<iso>"}` pins the time used for timestamps; without it, the server uses real time.
- `GET /_control/deliveries` returns the webhook log, and `POST /_control/flush` waits until pending deliveries are done.

**Determinism:** the same manifest and the same calls give the same ids, eTags, tokens and ordering. The ids of new items derive from the site, the path and a counter.

Lane F tests against small manifests built in the tests, not the real corpus. Use real HTTP for the webhook paths: a test receiver on localhost.

## `ex smoke` check 7 (integrator)

As Kestrel's connector:
- list the root's children with `$top=2` and follow `nextLink`;
- find the Project Heron memo through the manifest (`traps` contains `acl-leak`), and check that its permissions grant exactly `/Kestrel/Exec`;
- then check that Harbour's token on Kestrel's site is 403.
