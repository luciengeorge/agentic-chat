---
title: Sessions, with organizations as tenants
type: graded
slots:
  boundary/viewer: viewer.ts
---

# Sessions, with organizations as tenants: the solution

`resolveViewer` throws a 401 when there's no session. It selects the organization's id and slug from `member` joined to `organization`, where the member is the session's user; no row is a 403 `no_tenant`. Inside `deps.withTenant(tenant.id, ...)` it selects the user's principal (`kind = 'user'`); a principal that isn't enabled is a 403 `disabled`, and no principal at all is let through. It returns the user's id, email and name, the email's local part as the username, and the tenant.

## Why it works

- **better-auth answers "who", and only that.** The cookie is a signed token for a session row. `getSession` checks the signature and the expiry, and gives back the user. Everything about tenants is the app's.
- **The membership is the tenant.** One `member` row per user, enforced twice: a unique `member.user_id` in the database and a `beforeAddMember` hook in `src/lib/auth.ts`. Organizations can't be created by users or joined by invitation. So that row can't be ambiguous, and the session's `activeOrganizationId`, a cache the plugin rewrites, never has to be trusted.
- **The disabled check runs inside the tenant.** `principals` is behind RLS, so only a tenant-scoped transaction can see Sam's row. Outside one, he'd have no row, look unsynced, and get in.
- **Unsynced isn't refused.** A member the directory hasn't reached yet has no principal, and principals are never deleted, so "missing" only ever means "not yet". They get the UI and nothing else: no principal means no ACL grants and no rate-limit bucket.
- **It runs on every request.** That's what makes a 7-day cookie safe: the session says who, and each request asks the directory again whether they're still allowed.

## The worked example

Leo's sign-in sets `better-auth.session_token`, httpOnly, SameSite=Lax, for 604,800 seconds. His session caches Kestrel; his one member row is Kestrel; his viewer is Kestrel. With Harbour written into the cache by hand, still Kestrel. Sam Patel, disabled after signing in, keeps a cookie better-auth accepts and gets 403 `disabled` from you. Peter Hall can't sign in at all: 403 `BANNED_USER`.
