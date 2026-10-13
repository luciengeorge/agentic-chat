// @vitest-environment node
import { sealData } from "iron-session";
import { beforeEach, describe, expect, it, vi } from "vitest";

const jar = new Map<string, string>();

vi.mock("@tanstack/react-start/server", () => ({
  getCookie: (name: string) => jar.get(name),
  setCookie: (name: string, value: string) => jar.set(name, value),
  deleteCookie: (name: string) => jar.delete(name),
}));

const { clearToast, hasToastCookie, readToast, writeToast } = await import("./toast-session.server");
const { TOAST_COOKIE } = await import("./toast");

const SECRET = "t".repeat(32);

describe("the toast cookie", () => {
  beforeEach(() => {
    jar.clear();
    vi.stubEnv("TOAST_SECRET", SECRET);
  });

  it("round-trips a toast and is gone once cleared", async () => {
    await writeToast({ description: "Saved", status: "success" });
    expect(jar.get(TOAST_COOKIE)).not.toContain("Saved");
    expect(await readToast()).toEqual({ description: "Saved", status: "success" });
    clearToast();
    expect(hasToastCookie()).toBe(false);
    expect(await readToast()).toBeUndefined();
  });

  it.each([
    ["another secret", () => sealData({ toast: { description: "x" } }, { password: "o".repeat(32) })],
    ["garbage", async () => "not-a-seal"],
  ])("reads a cookie sealed with %s as no toast", async (_, seal) => {
    jar.set(TOAST_COOKIE, await seal());
    expect(hasToastCookie()).toBe(true);
    expect(await readToast()).toBeUndefined();
  });
});
