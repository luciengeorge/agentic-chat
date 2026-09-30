import * as client from "openid-client";

import type { Env } from "./env";
import type { Tenant } from "./tenants";

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  expiresAt: number;
  sub?: string;
  username?: string;
}

export interface OidcClient {
  authorizationUrl(tenant: Tenant, params: { state: string; nonce: string; codeChallenge: string }): Promise<URL>;
  exchangeCode(
    tenant: Tenant,
    callbackUrl: URL,
    checks: { state: string; nonce: string; codeVerifier: string },
  ): Promise<TokenSet>;
  refresh(tenant: Tenant, refreshToken: string): Promise<TokenSet>;
  endSessionUrl(tenant: Tenant, idToken: string | undefined): Promise<URL>;
}

export const SCOPE = "openid profile";

export const callbackUrl = (env: Env) => new URL("/auth/callback", env.AC_WEB_ORIGIN).href;

function toTokenSet(response: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers): TokenSet {
  const claims = response.claims();
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    idToken: response.id_token,
    expiresAt: Date.now() + (response.expiresIn() ?? 300) * 1000,
    sub: claims?.sub,
    username: typeof claims?.preferred_username === "string" ? claims.preferred_username : undefined,
  };
}

export function createOidcClient(env: Env, options: { fetch?: client.CustomFetch } = {}): OidcClient {
  const configs = new Map<Tenant, Promise<client.Configuration>>();

  function config(tenant: Tenant): Promise<client.Configuration> {
    let pending = configs.get(tenant);
    if (!pending) {
      const issuer = new URL(`/realms/${tenant}`, env.AC_KEYCLOAK_URL);
      pending = client.discovery(
        issuer,
        env.AC_WEB_CLIENT_ID,
        undefined,
        client.ClientSecretPost(env.AC_WEB_CLIENT_SECRET),
        {
          execute: issuer.protocol === "http:" ? [client.allowInsecureRequests] : [],
          ...(options.fetch && { [client.customFetch]: options.fetch }),
        },
      );
      // Don't cache a failed discovery (Keycloak not up yet); retry on the next request.
      pending.catch(() => configs.delete(tenant));
      configs.set(tenant, pending);
    }
    return pending;
  }

  return {
    async authorizationUrl(tenant, { state, nonce, codeChallenge }) {
      return client.buildAuthorizationUrl(await config(tenant), {
        redirect_uri: callbackUrl(env),
        scope: SCOPE,
        state,
        nonce,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
      });
    },
    async exchangeCode(tenant, url, { state, nonce, codeVerifier }) {
      const response = await client.authorizationCodeGrant(await config(tenant), url, {
        pkceCodeVerifier: codeVerifier,
        expectedState: state,
        expectedNonce: nonce,
        idTokenExpected: true,
      });
      return toTokenSet(response);
    },
    async refresh(tenant, refreshToken) {
      return toTokenSet(await client.refreshTokenGrant(await config(tenant), refreshToken));
    },
    async endSessionUrl(tenant, idToken) {
      return client.buildEndSessionUrl(await config(tenant), {
        post_logout_redirect_uri: new URL("/", env.AC_WEB_ORIGIN).href,
        ...(idToken && { id_token_hint: idToken }),
      });
    },
  };
}
