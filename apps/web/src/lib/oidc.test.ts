import * as client from "openid-client";
import { describe, expect, it, vi } from "vitest";

import { createOidcClient } from "./oidc";

const env = {
  AC_ENV: "dev" as const,
  AC_REDIS_URL: "redis://localhost:6379/0",
  AC_KEYCLOAK_URL: "http://localhost:8081",
  AC_GATEWAY_URL: "http://localhost:8080",
  AC_WEB_ORIGIN: "http://localhost:3000",
  AC_WEB_CLIENT_ID: "web-bff",
  AC_WEB_CLIENT_SECRET: "secret",
};

const issuer = "http://localhost:8081/realms/kestrel";
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** An id token with the claims openid-client checks. The signature isn't verified for tokens from the token endpoint. */
function idToken(nonce: string) {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: issuer,
    aud: "web-bff",
    sub: "user-1",
    preferred_username: "smoke.kestrel",
    nonce,
    iat: now,
    exp: now + 300,
  };
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(claims)}.c2ln`;
}

/** Enough of Keycloak for discovery and the token endpoint. */
function fakeKeycloak(nonce: string) {
  return vi.fn<client.CustomFetch>(async (url, init) => {
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
        code_challenge_methods_supported: ["S256"],
      });
    }
    if (url === `${issuer}/protocol/openid-connect/token`) {
      const body = new URLSearchParams(String(init.body));
      if (body.get("grant_type") === "refresh_token") {
        return Response.json({ access_token: "access-2", token_type: "Bearer", expires_in: 300 });
      }
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        id_token: idToken(nonce),
        token_type: "Bearer",
        expires_in: 300,
      });
    }
    return new Response("not found", { status: 404 });
  });
}

function tokenRequest(fetch: ReturnType<typeof fakeKeycloak>) {
  const call = fetch.mock.calls.find(([url]) => url.endsWith("/token"))!;
  return { body: new URLSearchParams(String(call[1].body)) };
}

describe("oidc client", () => {
  it("builds an S256 PKCE authorization request against the tenant's realm", async () => {
    const oidc = createOidcClient(env, { fetch: fakeKeycloak("n") });

    const url = await oidc.authorizationUrl("kestrel", { state: "s", nonce: "n", codeChallenge: "c" });

    expect(url.origin + url.pathname).toBe(`${issuer}/protocol/openid-connect/auth`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "web-bff",
      response_type: "code",
      redirect_uri: "http://localhost:3000/auth/callback",
      scope: "openid profile",
      state: "s",
      nonce: "n",
      code_challenge: "c",
      code_challenge_method: "S256",
    });
  });

  it("exchanges the code with the verifier and client secret", async () => {
    const fetch = fakeKeycloak("n");
    const oidc = createOidcClient(env, { fetch: fetch });
    const verifier = client.randomPKCECodeVerifier();

    const tokens = await oidc.exchangeCode("kestrel", new URL("http://localhost:3000/auth/callback?code=abc&state=s"), {
      state: "s",
      nonce: "n",
      codeVerifier: verifier,
    });

    expect(tokens).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      sub: "user-1",
      username: "smoke.kestrel",
    });
    const { body } = tokenRequest(fetch);
    expect(body.get("code")).toBe("abc");
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.get("redirect_uri")).toBe("http://localhost:3000/auth/callback");
    expect(body.get("client_id")).toBe("web-bff");
    expect(body.get("client_secret")).toBe("secret");
  });

  it("rejects a callback whose state doesn't match", async () => {
    const oidc = createOidcClient(env, { fetch: fakeKeycloak("n") });
    await expect(
      oidc.exchangeCode("kestrel", new URL("http://localhost:3000/auth/callback?code=abc&state=forged"), {
        state: "s",
        nonce: "n",
        codeVerifier: client.randomPKCECodeVerifier(),
      }),
    ).rejects.toThrow();
  });

  it("rejects an id token whose nonce doesn't match", async () => {
    const oidc = createOidcClient(env, { fetch: fakeKeycloak("other") });
    await expect(
      oidc.exchangeCode("kestrel", new URL("http://localhost:3000/auth/callback?code=abc&state=s"), {
        state: "s",
        nonce: "n",
        codeVerifier: client.randomPKCECodeVerifier(),
      }),
    ).rejects.toThrow();
  });

  it("refreshes tokens", async () => {
    const fetch = fakeKeycloak("n");
    const oidc = createOidcClient(env, { fetch: fetch });

    const tokens = await oidc.refresh("kestrel", "refresh-1");

    expect(tokens.accessToken).toBe("access-2");
    expect(tokenRequest(fetch).body.get("refresh_token")).toBe("refresh-1");
  });

  it("discovers each realm once", async () => {
    const fetch = fakeKeycloak("n");
    const oidc = createOidcClient(env, { fetch: fetch });
    await oidc.authorizationUrl("kestrel", { state: "s", nonce: "n", codeChallenge: "c" });
    await oidc.endSessionUrl("kestrel", "id");
    expect(fetch.mock.calls.filter(([url]) => url.endsWith("openid-configuration"))).toHaveLength(1);
  });
});
