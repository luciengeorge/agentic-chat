import { describe, expect, it } from "vitest";

import { formatGreeting } from "#learn/_sample/greeting";

describe("formatGreeting", () => {
  it.each(["smoke", "Kestrel", "a b"])("greets %s by name", (name) => {
    expect(formatGreeting(name)).toBe(`hello ${name}`);
  });
});
