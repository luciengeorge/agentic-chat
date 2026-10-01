# agentic-chat

A hands-on workshop for building a production-grade AI application: a small version of Cohere's North, for a fictional
600-person fintech, Kestrel Pay. You build the AI layers yourself, one step at a time, against a finished reference app
that runs the whole way through.

- [`PLAN.md`](./PLAN.md): what we're building and why, the curriculum and the milestones.
- [`HANDOFF.md`](./HANDOFF.md): how the project came about, and the traps in this environment.
- [`AGENTS.md`](./AGENTS.md): the code conventions, for coding agents and people alike.

The app started from [`tanstack-starter-template`](https://github.com/luciengeorge/tanstack-starter-template), with
Convex, Sentry, PostHog, Resend, react-email and Polar removed.

## Stack

| Layer           | Pick                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| Framework       | [TanStack Start](https://tanstack.com/start) (Vite + Nitro)                                           |
| Routing         | TanStack Router (file-based)                                                                          |
| AI              | [Vercel AI SDK 7](https://ai-sdk.dev) (`ai`, `@ai-sdk/openai`, `@ai-sdk/react`)                       |
| UI              | [shadcn/ui](https://ui.shadcn.com) Base UI variant + Tailwind v4 + [hugeicons](https://hugeicons.com) |
| Forms           | TanStack Form + Zod                                                                                   |
| Data fetching   | TanStack Query                                                                                        |
| Analytics       | Vercel Analytics + Speed Insights, Google Analytics (production builds only)                          |
| Tooling         | oxlint + oxfmt + tsgo (no eslint, no prettier, no tsc), Vitest                                        |
| Package manager | pnpm                                                                                                  |
| Hosting         | Vercel                                                                                                |

The database (ParadeDB through Drizzle), auth (better-auth) and durable workflows (Vercel Workflow) are next; `PLAN.md`
has the full list.

## Getting started

```bash
pnpm install
cp .env.example .env.local    # then set TOAST_SECRET (openssl rand -hex 32)
pnpm dev                      # http://localhost:3000
```

## Environment variables

See [`.env.example`](./.env.example). `TOAST_SECRET` is the only one needed to boot: it seals the cookie that carries a
toast across a redirect.

## Scripts

```bash
pnpm dev              # start the dev server on :3000 (loads .env.local)
pnpm build            # production build
pnpm preview          # preview the production build
pnpm start            # run the production build
pnpm test             # vitest run
pnpm lint             # oxfmt src && oxlint src (autofix)
pnpm lint:check       # CI: format + lint without writing
pnpm format           # oxfmt . (whole repo)
pnpm format:check     # CI: format check without writing
pnpm typecheck        # tsgo --noEmit
```

## Folder structure

```
.
├── src/
│   ├── components/ui/      # shadcn (Base UI variant)
│   ├── integrations/       # TanStack Query, Google Analytics
│   ├── lib/                # logger, toast, cn(), server functions
│   └── routes/             # file-based routes
├── fixtures/
│   ├── world.yaml          # tenants, people, groups, folders, sharing, facts
│   └── corpus/             # the documents the workshop searches (see its README)
├── docs/                   # interview prep and the Python milestones' contracts
├── nitro.config.ts         # security headers (CSP, COOP, HSTS, etc.)
└── vite.config.ts          # vite + tanstack-start + react-compiler
```

## Adding shadcn components

```bash
pnpm dlx shadcn@latest add card field input spinner sonner
```

This repo uses **Base UI**, not Radix. The CLI picks the right variant from `components.json`.

## License

UNLICENSED.
