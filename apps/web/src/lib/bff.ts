import { parseCookie, stringifySetCookie } from "cookie";
import * as client from "openid-client";

import type { Env } from "./env";
import type { OidcClient } from "./oidc";
import type { Session, SessionStore } from "./session-store";

import { callbackUrl } from "./oidc";
import { LOGIN_TTL_SECONDS, SESSION_TTL_SECONDS } from "./session-store";
import { TENANTS } from "./tenants";

export const SESSION_COOKIE = "ac_session";
export const LOGIN_COOKIE = "ac_login";

/** Refresh this long before the access token expires, so a request never goes out with a token about to lapse. */
const REFRESH_LEEWAY_MS = 30_000;

export interface BffDeps {
  env: Env;
  store: SessionStore;
  oidc: OidcClient;
  fetch: typeof fetch;
}

function cookie(env: Env, name: string, value: string, maxAge: number): string {
  return stringifySetCookie(name, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.AC_ENV === "prod",
    path: "/",
    maxAge,
  });
}

function readCookie(request: Request, name: string): string | undefined {
  return parseCookie(request.headers.get("cookie") ?? "")[name];
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

function json(body: unknown, status = 200, cookies: string[] = []): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Only same-origin paths, so `returnTo` can't be used as an open redirect. */
function safeReturnTo(env: Env, value: string | null): string {
  if (!value) return "/";
  const origin = new URL(env.AC_WEB_ORIGIN).origin;
  let url: URL;
  try {
    url = new URL(value, origin);
  } catch {
    return "/";
  }
  const path = url.pathname + url.search + url.hash;
  // `/..//evil.example` resolves on our origin to the path `//evil.example`, which a browser reads as a host.
  return url.origin === origin && !path.startsWith("//") ? path : "/";
}

export function createBff({ env, store, oidc, fetch }: BffDeps) {
  const clearSession = cookie(env, SESSION_COOKIE, "", 0);

  async function currentSession(request: Request): Promise<{ id: string; session: Session } | null> {
    const id = readCookie(request, SESSION_COOKIE);
    if (!id) return null;
    const session = await store.get(id);
    return session ? { id, session } : null;
  }

  /** The session with a live access token, refreshing it first if it's close to expiry. Null means signed out. */
  async function freshSession(request: Request): Promise<{ id: string; session: Session } | null> {
    const current = await currentSession(request);
    if (!current) return null;
    const { id, session } = current;
    if (session.expiresAt - Date.now() > REFRESH_LEEWAY_MS) return current;
    if (!session.refreshToken) {
      await store.destroy(id);
      return null;
    }
    try {
      const tokens = await oidc.refresh(session.tenant, session.refreshToken);
      const refreshed: Session = {
        ...session,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? session.refreshToken,
        idToken: tokens.idToken ?? session.idToken,
        expiresAt: tokens.expiresAt,
      };
      // A logout or another refresh got there first: theirs stands, and a logged-out session stays gone.
      if (!(await store.update(id, refreshed))) return await currentSession(request);
      return { id, session: { ...refreshed, version: refreshed.version + 1 } };
    } catch {
      await store.destroy(id);
      return null;
    }
  }

  return {
    freshSession,

    async login(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const tenantParam = url.searchParams.get("tenant") ?? "kestrel";
      const tenant = TENANTS.find((t) => t === tenantParam);
      if (!tenant) return json({ error: "unknown_tenant", detail: tenantParam }, 400);

      const state = client.randomState();
      const nonce = client.randomNonce();
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const returnTo = safeReturnTo(env, url.searchParams.get("returnTo"));

      let authorizationUrl;
      try {
        authorizationUrl = await oidc.authorizationUrl(tenant, { state, nonce, codeChallenge });
      } catch (error) {
        return json({ error: "idp_unavailable", detail: error instanceof Error ? error.message : null }, 502);
      }
      const loginId = await store.createLogin({ tenant, state, nonce, codeVerifier, returnTo });
      return redirect(authorizationUrl.href, [cookie(env, LOGIN_COOKIE, loginId, LOGIN_TTL_SECONDS)]);
    },

    async callback(request: Request): Promise<Response> {
      const clearLogin = cookie(env, LOGIN_COOKIE, "", 0);
      const loginId = readCookie(request, LOGIN_COOKIE);
      const login = loginId ? await store.takeLogin(loginId) : null;
      if (!login) return json({ error: "login_expired" }, 400, [clearLogin]);

      // Rebuild the URL on our public origin so it matches the registered redirect_uri exactly.
      const url = new URL(callbackUrl(env));
      url.search = new URL(request.url).search;

      let tokens;
      try {
        tokens = await oidc.exchangeCode(login.tenant, url, login);
      } catch (error) {
        return json({ error: "login_failed", detail: error instanceof Error ? error.message : null }, 400, [
          clearLogin,
        ]);
      }
      if (!tokens.sub) return json({ error: "login_failed", detail: "id token has no sub" }, 400, [clearLogin]);

      const sessionId = await store.create({
        tenant: login.tenant,
        sub: tokens.sub,
        username: tokens.username ?? tokens.sub,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        idToken: tokens.idToken,
        expiresAt: tokens.expiresAt,
      });
      return redirect(login.returnTo, [clearLogin, cookie(env, SESSION_COOKIE, sessionId, SESSION_TTL_SECONDS)]);
    },

    async logout(request: Request): Promise<Response> {
      const current = await currentSession(request);
      if (!current) return redirect("/", [clearSession]);
      await store.destroy(current.id);
      const endSession = await oidc.endSessionUrl(current.session.tenant, current.session.idToken);
      return redirect(endSession.href, [clearSession]);
    },

    async me(request: Request): Promise<Response> {
      const current = await freshSession(request);
      if (!current) return json({ error: "unauthenticated" }, 401, [clearSession]);
      const upstream = await fetch(new URL("/v1/me", env.AC_GATEWAY_URL), {
        headers: { authorization: `Bearer ${current.session.accessToken}` },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
        },
      });
    },
  };
}

export type Bff = ReturnType<typeof createBff>;
