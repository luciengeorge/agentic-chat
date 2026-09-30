import { parseSetCookie } from "cookie";
import * as client from "openid-client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { memoryKv } from "@/test/memory-kv";

import type { OidcClient, TokenSet } from "./oidc";

import { createBff } from "./bff";
import { createSessionStore } from "./session-store";

const env = {
  AC_ENV: "dev" as const,
  AC_REDIS_URL: "redis://localhost:6379/0",
  AC_KEYCLOAK_URL: "http://localhost:8081",
  AC_GATEWAY_URL: "http://localhost:8080",
  AC_WEB_ORIGIN: "http://localhost:3000",
  AC_WEB_CLIENT_ID: "web-bff",
  AC_WEB_CLIENT_SECRET: "secret",
};

const tokens = (overrides: Partial<TokenSet> = {}): TokenSet => ({
  accessToken: "access-1",
  refreshToken: "refresh-1",
  idToken: "id-1",
  expiresAt: Date.now() + 300_000,
  sub: "user-1",
  username: "smoke.kestrel",
  ...overrides,
});

function fakeOidc() {
  return {
    authorizationUrl: vi.fn<OidcClient["authorizationUrl"]>(async (tenant, params) => {
      const url = new URL(`http://localhost:8081/realms/${tenant}/protocol/openid-connect/auth`);
      url.searchParams.set("state", params.state);
      url.searchParams.set("nonce", params.nonce);
      url.searchParams.set("code_challenge", params.codeChallenge);
      return url;
    }),
    exchangeCode: vi.fn<OidcClient["exchangeCode"]>(async () => tokens()),
    refresh: vi.fn<OidcClient["refresh"]>(async () => tokens({ accessToken: "access-2", refreshToken: "refresh-2" })),
    endSessionUrl: vi.fn<OidcClient["endSessionUrl"]>(
      async (tenant) => new URL(`http://localhost:8081/realms/${tenant}/protocol/openid-connect/logout`),
    ),
  };
}

function setCookies(response: Response) {
  return Object.fromEntries(
    response.headers.getSetCookie().map((header) => {
      const parsed = parseSetCookie(header);
      return [parsed.name, parsed];
    }),
  );
}

function request(path: string, cookies: Record<string, string | undefined> = {}, init: RequestInit = {}) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new Request(new URL(path, env.AC_WEB_ORIGIN), { ...init, headers: { cookie } });
}

describe("bff", () => {
  let kv: ReturnType<typeof memoryKv>;
  let oidc: ReturnType<typeof fakeOidc>;
  let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
  let bff: ReturnType<typeof createBff>;

  beforeEach(() => {
    kv = memoryKv();
    oidc = fakeOidc();
    upstream = vi.fn<typeof fetch>(async () => Response.json({ sub: "user-1", tenant: "kestrel" }));
    bff = createBff({ env, store: createSessionStore(kv), oidc, fetch: upstream });
  });

  async function signIn(tenant = "kestrel") {
    const login = await bff.login(request(`/auth/login?tenant=${tenant}`));
    const loginId = setCookies(login).ac_login!.value;
    const state = new URL(login.headers.get("location")!).searchParams.get("state");
    const callback = await bff.callback(request(`/auth/callback?code=abc&state=${state}`, { ac_login: loginId }));
    return setCookies(callback).ac_session!.value;
  }

  describe("login", () => {
    it("redirects to Keycloak with S256 PKCE, state and nonce, keeping the secrets server-side", async () => {
      const response = await bff.login(request("/auth/login?tenant=harbour"));

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname).toBe("/realms/harbour/protocol/openid-connect/auth");

      const cookie = setCookies(response).ac_login!;
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });

      const pending = JSON.parse(kv.entries.get(`bff:login:${cookie.value}`)!.value);
      expect(pending.tenant).toBe("harbour");
      expect(location.searchParams.get("state")).toBe(pending.state);
      expect(location.searchParams.get("nonce")).toBe(pending.nonce);
      expect(location.searchParams.get("code_challenge")).toBe(
        await client.calculatePKCECodeChallenge(pending.codeVerifier),
      );
      expect(location.href).not.toContain(pending.codeVerifier);
    });

    it("defaults to kestrel", async () => {
      await bff.login(request("/auth/login"));
      expect(oidc.authorizationUrl).toHaveBeenCalledWith("kestrel", expect.anything());
    });

    it("rejects unknown tenants", async () => {
      const response = await bff.login(request("/auth/login?tenant=evil"));
      expect(response.status).toBe(400);
      expect(oidc.authorizationUrl).not.toHaveBeenCalled();
    });

    it("reports an unreachable Keycloak without storing a login", async () => {
      oidc.authorizationUrl.mockRejectedValueOnce(new Error("fetch failed"));
      const response = await bff.login(request("/auth/login"));
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "idp_unavailable", detail: "fetch failed" });
      expect(kv.entries.size).toBe(0);
    });

    it("uses a fresh state and verifier for every attempt", async () => {
      await bff.login(request("/auth/login"));
      await bff.login(request("/auth/login"));
      const [first, second] = oidc.authorizationUrl.mock.calls.map(([, params]) => params);
      expect(first!.state).not.toBe(second!.state);
      expect(first!.codeChallenge).not.toBe(second!.codeChallenge);
    });
  });

  describe("callback", () => {
    it("exchanges the code with the stored checks and sets only an opaque session cookie", async () => {
      const login = await bff.login(request("/auth/login?tenant=kestrel&returnTo=/chat"));
      const loginId = setCookies(login).ac_login!.value;
      const pending = JSON.parse(kv.entries.get(`bff:login:${loginId}`)!.value);

      const response = await bff.callback(
        request(`/auth/callback?code=abc&state=${pending.state}`, { ac_login: loginId }),
      );

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/chat");
      const [tenant, url, checks] = oidc.exchangeCode.mock.calls[0]!;
      expect(tenant).toBe("kestrel");
      expect(url.href).toBe(`http://localhost:3000/auth/callback?code=abc&state=${pending.state}`);
      expect(checks).toMatchObject({ state: pending.state, nonce: pending.nonce, codeVerifier: pending.codeVerifier });

      const cookies = setCookies(response);
      expect(cookies.ac_login!.maxAge).toBe(0);
      expect(cookies.ac_session).toMatchObject({ httpOnly: true, sameSite: "lax" });
      expect(cookies.ac_session!.value).not.toContain("access");
      const stored = JSON.parse(kv.entries.get(`bff:session:${cookies.ac_session!.value}`)!.value);
      expect(stored).toMatchObject({ tenant: "kestrel", sub: "user-1", accessToken: "access-1" });
      expect(kv.entries.has(`bff:login:${loginId}`)).toBe(false);
    });

    it("fails without a pending login", async () => {
      const response = await bff.callback(request("/auth/callback?code=abc&state=x"));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "login_expired" });
      expect(oidc.exchangeCode).not.toHaveBeenCalled();
    });

    it("cannot be replayed", async () => {
      const login = await bff.login(request("/auth/login"));
      const loginId = setCookies(login).ac_login!.value;
      await bff.callback(request("/auth/callback?code=abc", { ac_login: loginId }));
      const replay = await bff.callback(request("/auth/callback?code=abc", { ac_login: loginId }));
      expect(replay.status).toBe(400);
    });

    it("reports a failed code exchange without creating a session", async () => {
      oidc.exchangeCode.mockRejectedValueOnce(new Error("unexpected state"));
      const login = await bff.login(request("/auth/login"));
      const response = await bff.callback(
        request("/auth/callback?code=abc", { ac_login: setCookies(login).ac_login!.value }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "login_failed", detail: "unexpected state" });
      expect([...kv.entries.keys()].some((k) => k.startsWith("bff:session:"))).toBe(false);
    });

    async function landsOn(returnTo: string) {
      const login = await bff.login(request(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`));
      const response = await bff.callback(
        request("/auth/callback?code=abc", { ac_login: setCookies(login).ac_login!.value }),
      );
      return response.headers.get("location");
    }

    it.each([
      "//evil.example",
      "/\\evil.example",
      "\\\\evil.example",
      "/\t/evil.example",
      "/\n/evil.example",
      "/..//evil.example",
      "/.//evil.example",
      "https://evil.example/",
      "http://localhost:3001/",
      "javascript:alert(1)",
    ])("ignores the off-site returnTo %j", async (returnTo) => {
      expect(await landsOn(returnTo)).toBe("/");
    });

    it("keeps a same-origin returnTo's path, query and fragment", async () => {
      expect(await landsOn("/chat?c=1#m")).toBe("/chat?c=1#m");
      expect(await landsOn("http://localhost:3000/chat")).toBe("/chat");
    });
  });

  describe("me", () => {
    it("401s without a session", async () => {
      const response = await bff.me(request("/api/me"));
      expect(response.status).toBe(401);
      expect(upstream).not.toHaveBeenCalled();
    });

    it("calls the gateway with the bearer token and relays its answer", async () => {
      const sessionId = await signIn();

      const response = await bff.me(request("/api/me", { ac_session: sessionId }));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ sub: "user-1", tenant: "kestrel" });
      const [url, init] = upstream.mock.calls[0]!;
      expect(String(url)).toBe("http://localhost:8080/v1/me");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-1");
    });

    it("relays gateway errors as-is", async () => {
      const sessionId = await signIn();
      upstream.mockResolvedValueOnce(Response.json({ error: "denied" }, { status: 403 }));
      const response = await bff.me(request("/api/me", { ac_session: sessionId }));
      expect(response.status).toBe(403);
    });

    it("refreshes an access token that is about to expire", async () => {
      oidc.exchangeCode.mockResolvedValueOnce(tokens({ expiresAt: Date.now() + 5_000 }));
      const sessionId = await signIn();

      await bff.me(request("/api/me", { ac_session: sessionId }));

      expect(oidc.refresh).toHaveBeenCalledWith("kestrel", "refresh-1");
      expect(new Headers(upstream.mock.calls[0]![1]?.headers).get("authorization")).toBe("Bearer access-2");
      const stored = JSON.parse(kv.entries.get(`bff:session:${sessionId}`)!.value);
      expect(stored).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
    });

    it("keeps the session's remaining TTL when it refreshes", async () => {
      oidc.exchangeCode.mockResolvedValueOnce(tokens({ expiresAt: Date.now() + 5_000 }));
      const sessionId = await signIn();
      kv.entries.get(`bff:session:${sessionId}`)!.ex = 60;

      await bff.me(request("/api/me", { ac_session: sessionId }));

      const entry = kv.entries.get(`bff:session:${sessionId}`)!;
      expect(JSON.parse(entry.value)).toMatchObject({ accessToken: "access-2" });
      expect(entry.ex).toBe(60);
    });

    it("lets a logout during a refresh win", async () => {
      oidc.exchangeCode.mockResolvedValueOnce(tokens({ expiresAt: Date.now() + 5_000 }));
      const sessionId = await signIn();
      let finishRefresh!: () => void;
      oidc.refresh.mockImplementationOnce(
        () => new Promise((resolve) => (finishRefresh = () => resolve(tokens({ accessToken: "access-2" })))),
      );

      const me = bff.me(request("/api/me", { ac_session: sessionId }));
      await vi.waitFor(() => expect(oidc.refresh).toHaveBeenCalled());
      await bff.logout(request("/auth/logout", { ac_session: sessionId }, { method: "POST" }));
      finishRefresh();

      expect((await me).status).toBe(401);
      expect(kv.entries.has(`bff:session:${sessionId}`)).toBe(false);
      expect(upstream).not.toHaveBeenCalled();
    });

    it("uses the session another request refreshed first", async () => {
      oidc.exchangeCode.mockResolvedValueOnce(tokens({ expiresAt: Date.now() + 5_000 }));
      const sessionId = await signIn();
      let finishRefresh!: () => void;
      oidc.refresh.mockImplementationOnce(
        () => new Promise((resolve) => (finishRefresh = () => resolve(tokens({ accessToken: "access-slow" })))),
      );

      const slow = bff.me(request("/api/me", { ac_session: sessionId }));
      await vi.waitFor(() => expect(oidc.refresh).toHaveBeenCalledTimes(1));
      await bff.me(request("/api/me", { ac_session: sessionId }));
      finishRefresh();
      await slow;

      const stored = JSON.parse(kv.entries.get(`bff:session:${sessionId}`)!.value);
      expect(stored.accessToken).toBe("access-2");
      expect(new Headers(upstream.mock.calls[1]![1]?.headers).get("authorization")).toBe("Bearer access-2");
    });

    it("signs the user out when the refresh fails", async () => {
      oidc.exchangeCode.mockResolvedValueOnce(tokens({ expiresAt: Date.now() - 1 }));
      oidc.refresh.mockRejectedValueOnce(new Error("invalid_grant"));
      const sessionId = await signIn();

      const response = await bff.me(request("/api/me", { ac_session: sessionId }));

      expect(response.status).toBe(401);
      expect(kv.entries.has(`bff:session:${sessionId}`)).toBe(false);
    });
  });

  describe("logout", () => {
    it("destroys the session and redirects to Keycloak's end-session endpoint", async () => {
      const sessionId = await signIn("harbour");

      const response = await bff.logout(request("/auth/logout", { ac_session: sessionId }, { method: "POST" }));

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        "http://localhost:8081/realms/harbour/protocol/openid-connect/logout",
      );
      expect(oidc.endSessionUrl).toHaveBeenCalledWith("harbour", "id-1");
      expect(setCookies(response).ac_session!.maxAge).toBe(0);
      expect(kv.entries.has(`bff:session:${sessionId}`)).toBe(false);
    });

    it("just goes home when there is no session", async () => {
      const response = await bff.logout(request("/auth/logout", {}, { method: "POST" }));
      expect(response.headers.get("location")).toBe("/");
    });
  });
});
