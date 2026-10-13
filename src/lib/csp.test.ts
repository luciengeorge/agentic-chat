import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, newNonce } from "./csp";

const directives = (policy: string) =>
  Object.fromEntries(policy.split("; ").map((d) => [d.split(" ")[0], d.split(" ").slice(1)]));

describe("contentSecurityPolicy", () => {
  it("runs scripts from this origin or with the nonce, never inline without it", () => {
    const csp = directives(contentSecurityPolicy("abc123", "prod"));
    expect(csp["script-src"]).toEqual(["'self'", "'nonce-abc123'"]);
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(csp["object-src"]).toEqual(["'none'"]);
  });

  it("keeps images, fonts and fetches on this origin, so a rendered answer can't send data elsewhere", () => {
    const csp = directives(contentSecurityPolicy("n", "prod"));
    expect(csp["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(csp["connect-src"]).toEqual(["'self'"]);
    expect(csp["font-src"]).toEqual(["'self'", "data:"]);
    for (const list of Object.values(csp)) expect(list).not.toContain("https:");
  });

  it("lets the dev server's HMR socket connect in dev only", () => {
    expect(directives(contentSecurityPolicy("n", "dev"))["connect-src"]).toContain("ws://localhost:*");
    expect(directives(contentSecurityPolicy("n", "test"))["connect-src"]).toEqual(["'self'"]);
  });
});

describe("newNonce", () => {
  it("is 32 hex characters and different each time", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newNonce()).not.toBe(a);
  });
});
