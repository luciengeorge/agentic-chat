---
title: Auth and the API boundary, done
---

# Auth and the API boundary, done

Every request to the app now crosses code you wrote, in this order. Your middleware loads the session and, through your `resolveViewer`, the viewer: the user, the tenant from their one membership, and a 403 if the directory has disabled them. It refuses before any handler runs, and it reaches the browser as an empty shell. `POST /api/chat` reads its body through your `readChatTurn`, which describes only a conversation and a message, so a tenant id in the body goes nowhere. Your `takeToken` decides, in one locked UPDATE, whether this question is allowed. And your `withHeartbeat` keeps the answer's stream open while it's quiet and stops the model when the tab closes.

Each layer covers a different mistake. A route that forgot the middleware has no `context.viewer` to act on. And RLS (section 09) enforces whichever tenant a transaction names: handed Harbour's id from a request body, it would faithfully show Harbour. That's why the tenant comes from the membership and nowhere else.

## What to notice in the lab

Run `pnpm dev`, sign in as `leo.martin@kestrelpay.example` (password `dev-password`), and open `/labs/boundary` (dev only).

- **The log** lists the last 50 requests through the middleware, newest first: route or server function, viewer, tenant, status, time, and the viewer's buckets. Ask a question in `/chat` in another tab and watch `/api/chat` appear with `chat` one token lower.
- **Take a token** spends one from the lab's own bucket (`lab`, 10 tokens, one every 6 s, through your `takeToken`), so you can drain it without asking the model anything. Click it eleven times: ten 200s counting down, then a 429 with Retry-After 6. Wait 6 seconds: one more.
- **Send one signed out** makes a request to a chat route from the page with the cookie left off (`credentials: "omit"`): your middleware answers 401, and the log shows it with no viewer.
- **Server functions show by name**: the lab's own `takeLabToken` and `getRequestLog` (in `src/routes/labs/boundary.tsx`), alongside the app's routes.

## What comes next

Section 12 builds the page side of this: `useChat` reading your stream, citation chips opening pages through a route behind your middleware. Section 13's agents get their own per-user budgets on the same bucket table. Section 17 puts guardrails at this boundary, and section 22 runs it on Vercel, where several servers sharing one bucket row is no longer hypothetical.
