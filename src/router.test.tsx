import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { getRouter } from "./router";

// The real tree imports every route, the server ones included, and those need a database.
vi.mock("./routeTree.gen", async () => {
  const { createRootRoute } = await import("@tanstack/react-router");
  return { routeTree: createRootRoute() };
});

describe("getRouter", () => {
  it("gives each router, so each server request, its own QueryClient", () => {
    const [first, second] = [getRouter(), getRouter()];
    expect(first.options.context.queryClient).toBeInstanceOf(QueryClient);
    expect(first.options.context.queryClient).not.toBe(second.options.context.queryClient);
  });

  it("wires the SSR query integration, which provides that client to the app", () => {
    expect(getRouter().options.Wrap).toBeDefined();
  });
});
