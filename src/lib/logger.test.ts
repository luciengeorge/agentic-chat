import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLogger } from "./logger";

describe("createLogger", () => {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

  beforeEach(() => {
    spy.mockClear();
    errSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits structured JSON", () => {
    const log = createLogger("test");
    log.info("hello", { user: "alice" });
    expect(spy).toHaveBeenCalledOnce();
    const payload = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(payload).toMatchObject({ level: "info", scope: "test", message: "hello", user: "alice" });
  });

  it("redacts sensitive keys", () => {
    const log = createLogger("test");
    log.info("login", { email: "a@b.com", password: "secret", apiKey: "xxx" });
    const payload = JSON.parse(spy.mock.calls[0]?.[0] as string);
    expect(payload.password).toBe("[REDACTED]");
    expect(payload.apiKey).toBe("[REDACTED]");
    expect(payload.email).toBe("a@b.com");
  });

  it("serializes Error objects", () => {
    const log = createLogger("test");
    log.error("boom", { error: new Error("oh no") });
    const payload = JSON.parse(errSpy.mock.calls[0]?.[0] as string);
    expect(payload.error).toMatchObject({ name: "Error", message: "oh no" });
    expect(payload.error.stack).toBeDefined();
  });
});

describe("redaction", () => {
  const spy = vi.spyOn(console, "info").mockImplementation(() => {});
  const logged = (meta: Record<string, unknown>) => {
    spy.mockClear();
    createLogger("test").info("event", meta);
    return JSON.parse(spy.mock.calls[0]?.[0] as string);
  };

  it("redacts keys by their words, in any case style", () => {
    const payload = logged({
      "x-api-key": "k1",
      api_key: "k2",
      XApiKey: "k3",
      accessToken: "t",
      bearer: "b",
      credentials: { user: "u" },
      db_password: "p",
      clientSecret: "s",
      "set-cookie": "c",
    });
    for (const key of Object.keys(payload).filter((key) => !["timestamp", "level", "scope", "message"].includes(key))) {
      expect(payload[key], key).toBe("[REDACTED]");
    }
  });

  it("keeps counts and text whose keys only look alike", () => {
    expect(logged({ inputTokens: 12, outputTokens: 34, passages: ["a", "b"], tokenizer: "o200k" })).toMatchObject({
      inputTokens: 12,
      outputTokens: 34,
      passages: ["a", "b"],
      tokenizer: "o200k",
    });
  });

  it("redacts the password in a connection string and a bearer token, wherever they appear", () => {
    const error = new Error("connect failed: postgres://ac:hunter2@db.internal:5432/ac");
    const payload = logged({
      url: "postgres://ac:hunter2@localhost:5432/ac",
      note: "sent Authorization: Bearer eyJhbGciOi.payload.sig",
      error,
    });
    expect(payload.url).toBe("postgres://ac:[REDACTED]@localhost:5432/ac");
    expect(payload.note).toBe("sent Authorization: Bearer [REDACTED]");
    expect(payload.error.message).toBe("connect failed: postgres://ac:[REDACTED]@db.internal:5432/ac");
    expect(payload.error.stack).not.toContain("hunter2");
  });

  it("survives a cycle, and prints a shared object each time", () => {
    const shared = { id: 1 };
    const node: Record<string, unknown> = { name: "a", left: shared, right: shared };
    node.self = node;
    expect(logged({ node })).toMatchObject({
      node: { name: "a", left: { id: 1 }, right: { id: 1 }, self: "[Circular]" },
    });
  });
});
