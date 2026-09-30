import { describe, expect, it } from "vitest";

import { memoryKv } from "@/test/memory-kv";

import { LOGIN_TTL_SECONDS, SESSION_TTL_SECONDS, createSessionStore } from "./session-store";

const session = {
  tenant: "kestrel" as const,
  sub: "user-1",
  username: "smoke.kestrel",
  accessToken: "at",
  refreshToken: "rt",
  idToken: "it",
  expiresAt: 1_000,
};

describe("session store", () => {
  it("stores sessions under bff:session:<id> with a TTL", async () => {
    const kv = memoryKv();
    const store = createSessionStore(kv);

    const id = await store.create(session);

    expect(id).toMatch(/^[\w-]{43}$/);
    expect(kv.entries.get(`bff:session:${id}`)?.ex).toBe(SESSION_TTL_SECONDS);
    expect(await store.get(id)).toEqual(session);
  });

  it("issues a different id for every session", async () => {
    const store = createSessionStore(memoryKv());
    expect(await store.create(session)).not.toBe(await store.create(session));
  });

  it("updates and destroys sessions", async () => {
    const store = createSessionStore(memoryKv());
    const id = await store.create(session);

    await store.update(id, { ...session, accessToken: "at-2" });
    expect((await store.get(id))?.accessToken).toBe("at-2");

    await store.destroy(id);
    expect(await store.get(id)).toBeNull();
  });

  it("returns null for unknown or malformed sessions", async () => {
    const kv = memoryKv();
    const store = createSessionStore(kv);
    await kv.set("bff:session:bad", JSON.stringify({ tenant: "nope" }), { EX: 1 });

    expect(await store.get("missing")).toBeNull();
    expect(await store.get("bad")).toBeNull();
  });

  it("hands out a pending login exactly once", async () => {
    const kv = memoryKv();
    const store = createSessionStore(kv);
    const login = { tenant: "harbour" as const, state: "s", nonce: "n", codeVerifier: "v", returnTo: "/" };

    const id = await store.createLogin(login);
    expect(kv.entries.get(`bff:login:${id}`)?.ex).toBe(LOGIN_TTL_SECONDS);

    expect(await store.takeLogin(id)).toEqual(login);
    expect(await store.takeLogin(id)).toBeNull();
  });
});
