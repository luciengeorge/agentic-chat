---
title: Sessions, with organizations as tenants
type: graded
slots:
  boundary/viewer: viewer.ts
---

# Sessions, with organizations as tenants

👨‍💼 Leo Martin signs in at Kestrel; Nina Osei at Harbour Health, the other customer on the same app. From then on, every request their browsers send has to be answered for the right person, inside the right tenant, and refused the moment the directory says one of them has left. better-auth tells you who holds the cookie. Which tenant that is, and whether they're still allowed in, is yours to decide.

## Terms

- A **session** is a row better-auth writes at sign-in: a random token, the user, and when it expires. The browser holds the token in a **cookie**, a value it sends back with every request to the site.
- **httpOnly** means scripts on the page can't read the cookie; only the browser sends it. So a script injected into the page can't steal the session.
- An **organization** is better-auth's word for a group of users. Here each one is a **tenant**: Kestrel or Harbour. A **member** row says a user belongs to one, and here a user belongs to exactly one.
- `activeOrganizationId` is a field on the session where better-auth's organization plugin caches "the organization this session works in".
- A **principal** is the directory's record of a person (section 09). `enabled: false` means the directory has disabled them.

## Do this

🐨 Write `resolveViewer` in `playground/viewer.ts`: from better-auth's session to the viewer, or the 401 or 403 to answer instead. `getViewer` in `src/lib/auth-server.ts` calls it on every request with the session from the cookie.

## A worked example

Leo signs in with his password. better-auth answers with one cookie: `better-auth.session_token=<token>.<signature>; Max-Age=604800; Path=/; HttpOnly; SameSite=Lax`. 604,800 seconds is 7 days. His session row caches Kestrel as its active organization, and he has one `member` row: Kestrel's. So his viewer is `leo.martin` in Kestrel.

Now write Harbour's id into that cached field by hand. The session says Harbour; the membership still says Kestrel; the viewer must still say Kestrel. And when sync disables Sam Patel, his 7-day cookie keeps working for better-auth: only your check, on his principal, inside Kestrel's tenant, answers 403 `disabled`. Peter Hall, disabled in `world.yaml` from the start, can't even sign in: 403 `BANNED_USER`.

The tests seed the world's users into a throwaway database with the real better-auth, and sign them in. They need Postgres (`pnpm ex up`).

Run the tests with `pnpm ex test 11.1`.
