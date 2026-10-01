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
