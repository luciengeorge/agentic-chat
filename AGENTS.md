# Agent context: agentic-chat

This file is the canonical context for AI coding agents (Claude Code, Cursor, Codex, etc.) working in this repo. Read
it before making changes. `.cursorrules` holds a short version.

## What this repo is

A hands-on workshop for building a production-grade AI application: a small version of Cohere's North, for a fictional
fintech, Kestrel Pay. The learner builds the AI layers (parsing, chunking, embeddings, BM25, reranking, agents) by
hand, one step at a time, against a finished reference app that runs the whole way through.

- `PLAN.md` is the source of truth for what to build: architecture, decisions, curriculum, milestones.
- `HANDOFF.md` is the history, how Lucien learns, and the traps in this environment.

The app started from Lucien's `tanstack-starter-template`, with Convex, Sentry, PostHog, Resend, react-email and Polar
removed. Auth went out with Convex; it comes back on better-auth and Drizzle.

## Stack snapshot

```
Runtime:       Node 22+, pnpm 10+
Framework:     TanStack Start (Vite + Nitro), React 19 + React Compiler
AI:            Vercel AI SDK 7 (ai, @ai-sdk/openai, @ai-sdk/react)
UI:            shadcn/ui (Base UI variant), Tailwind v4, hugeicons
Forms:         TanStack Form + Zod
Data fetching: TanStack Query
Database:      ParadeDB (Postgres + pg_search + pgvector) through Drizzle 1.0 rc
Auth:          better-auth (email and password; organizations are the tenants)
Workflows:     Vercel Workflow 5 (local world in .workflow-data/)
Tooling:       oxlint + oxfmt + tsgo (no eslint/prettier/tsc), Vitest
Hosting:       Vercel
```

## Folder layout

```
src/
  core/                  # the modules the exercises teach, imported as #learn/<area>/<module>
  db/                    # Drizzle schema, migrations, client, seed
  fixtures/world.ts      # loads and validates fixtures/world.yaml
  workflows/             # Vercel Workflow code (see docs/workflow-notes.md)
  components/
    ui/                  # shadcn: add via `pnpm dlx shadcn@latest add <name>`
    global-loading.tsx   # progress bar for route loads
  hooks/                 # use-toast: shows server toasts with sonner
  integrations/          # the TanStack Query devtools panel (router.tsx makes the QueryClient, one per request)
  lib/
    logger.ts            # structured logger, redacts sensitive keys
    toast.ts             # toast schema; toast-session.server.ts keeps it in a cookie
    utils.ts             # cn()
    functions/           # createServerFn() helpers (server-only)
  routes/
    __root.tsx           # providers, head, devtools
    index.tsx            # landing page
  routeTree.gen.ts       # NEVER edit: TanStack Router codegen
  test/setup.ts          # Vitest setup
servers/fake-workspace/  # the stand-in SharePoint, on :8100
scripts/                 # `pnpm ex` (scripts/ex/) and the seed
exercises/               # the course: sections, steps, their tests
vite-plugins/            # learn-slots: resolves #learn/* to the active step's playground files
patches/                 # the @workflow/builders patch (see docs/workflow-notes.md)
fixtures/
  world.yaml             # tenants, people, groups, folders, sharing, facts
  corpus/                # markdown sources and the committed build (see its README)
docs/                    # m0-contract.md, workflow-notes.md; interview prep and the Python contracts as history
compose.yaml             # ParadeDB
nitro.config.ts          # security headers (CSP, COOP, HSTS, etc.)
vite.config.ts           # vite + workflow + learn-slots + tanstack-start + react-compiler
```

## Conventions

### Imports

- `@/*` → `src/*` (preferred for app code)
- `#/*` → `src/*` (also in `package.json` `imports`, so Node resolves it too)
- Always use aliases. No relative paths past two levels.

### Server functions (TanStack Start)

```ts
import { createServerFn } from "@tanstack/react-start";

export const myServerFn = createServerFn({ method: "GET" }).handler(async () => {
  // implementation
});
```

### Forms

Use shadcn's `FieldGroup` + `Field`. Validation via Zod through TanStack Form. Never use raw `div + space-y-*`:

```tsx
<form
  onSubmit={(e) => {
    e.preventDefault();
    form.handleSubmit();
  }}
>
  <FieldGroup>
    <form.Field name="email" validators={{ onBlur: EmailSchema }}>
      {(field) => (
        <Field>
          <FieldLabel htmlFor={field.name}>Email</FieldLabel>
          <Input
            id={field.name}
            type="email"
            value={field.state.value}
            onChange={(e) => field.handleChange(e.target.value)}
            onBlur={field.handleBlur}
          />
          {field.state.meta.errors.length ? <FieldError>{field.state.meta.errors.join(", ")}</FieldError> : null}
        </Field>
      )}
    </form.Field>
  </FieldGroup>
</form>
```

### Styling

- Use semantic tokens: `bg-primary`, `text-muted-foreground`. **Never** raw colors.
- Use `gap-*`, never `space-x-*` or `space-y-*`.
- Use `size-*` for square dimensions, never `w-* h-*`.
- Use `cn()` from `@/lib/utils` for conditional classes.
- Tailwind v4: definitions in `src/styles.css` via `@theme inline`.

### Icons

```tsx
import { SearchIcon } from "@hugeicons/core-free-icons";

<Button>
  <SearchIcon data-icon="inline-start" />
  Search
</Button>;
```

No sizing classes on icons inside components; components handle it.

### Logging

```ts
import { createLogger } from "@/lib/logger";

const logger = createLogger("ingest.parse");

logger.info("document parsed", { documentId, pages });
logger.error("parse failed", { error, documentId });
```

Logger redacts a value when its key, split into words, has pass, password, secret, token, cookie, authorization,
bearer, credential(s) or api key in it: `x-api-key` and `accessToken` go, `inputTokens` and `passages` stay. In any
string it also hides the password of a connection string and a bearer token. Never log raw secrets, even if you think
they're safe.

### Environment

`acEnv()` from `@/lib/env` says whether a process runs in `dev`, `test` or `prod`, for the app, scripts and servers
alike. Call it; don't read `AC_ENV` or `NODE_ENV` yourself. An explicit `AC_ENV` wins, the Vite dev server is dev,
Vitest is test, and everything else is prod, a production build included.

### Toasts

To show a message after a redirect, `await redirectWithToast({ to, toast })` from
`@/lib/functions/redirect-with-toast` in a `beforeLoad` or server function: it stores the toast and throws the
redirect. The root route reads it once with `getToast()` and shows it. The cookie is sealed with `TOAST_SECRET`, so the app
needs it set to boot.

### Writing style

For anything Lucien reads (READMEs, hints, docs): plain words, every term defined the first time it appears, varied
sentence length, no em dashes, and no "not X, but Y".

## Files you should never edit

- `src/routeTree.gen.ts`: TanStack Router codegen
- `pnpm-lock.yaml`: managed by pnpm
- `fixtures/corpus/build/**`: the committed corpus, content-addressed. Re-render it from the `python-m0b` tag (see
  `fixtures/corpus/README.md`)
- `docs/interview-prep/**`, `docs/m0a-contract.md`, `docs/m0b-contract.md`: history

## Scripts to know

```bash
pnpm ex up            # ParadeDB in Compose, then db:migrate and db:seed
pnpm dev              # dev server on :3000 (loads .env.local)
pnpm fake-workspace   # fake-workspace on :8100
pnpm ex smoke         # check the running stack end to end
pnpm ex gate          # every graded step fails on its problem code and passes on its solution
pnpm build            # production build into .output/
pnpm start            # run the production build, as prod (reads no .env.local)
pnpm test             # vitest
pnpm typecheck        # tsgo --noEmit
pnpm lint             # oxfmt formats, then oxlint reports lint problems (it doesn't fix them)
pnpm lint:check       # CI: no writes
pnpm format:check     # oxfmt over the repo (skips PLAN.md, HANDOFF.md, docs/ and fixtures/)
pnpm dlx shadcn@latest add <component>   # add a shadcn component
```

## When asked to add a feature

1. Check `PLAN.md` for where it belongs, and whether the repo already has a pattern for it. Reuse it.
2. UI in `src/routes/`; server logic in server functions, or server routes for streams and webhooks.
3. Forms via TanStack Form + a Zod schema.
4. Run `pnpm lint && pnpm typecheck && pnpm test` before committing.

## When asked to add a third-party integration

1. Provider components go in `src/integrations/<service>/provider.tsx`.
2. Wire in `src/routes/__root.tsx` if it's a Provider component.
3. Add env vars to `.env.example` with comments.
4. Document in `README.md`.

## Anti-patterns: don't

- Don't add `eslint`, `prettier`, or `tsc`: we use oxc + tsgo.
- Don't write `space-y-*` / `space-x-*`: use `flex` + `gap-*`.
- Don't put secrets in `VITE_*` env vars: those are bundled into the client.
- Don't reformat `docs/` or `fixtures/`: the corpus blobs are content-addressed.

## Asking for help

If something is unclear, prefer asking over guessing. `PLAN.md` usually has the answer; when it doesn't, say so.
