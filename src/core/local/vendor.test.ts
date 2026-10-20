// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { bundleTotal, type ComposeConfig, composeImages, gb } from "./vendor";

const compose = parse(readFileSync(new URL("../../../compose.yaml", import.meta.url), "utf8")) as ComposeConfig;

describe("composeImages", () => {
  it("takes the default services and the airgap profile, each image once", () => {
    expect(composeImages(compose, false)).toEqual(["paradedb/paradedb:0.26.1-pg18"]);
  });

  it("takes every profile with all", () => {
    expect(composeImages(compose, true).sort()).toEqual([
      "grafana/otel-lgtm:0.37.0",
      "paradedb/paradedb:0.26.1-pg18",
      "quay.io/docling-project/docling-serve-cpu:v1.35.0",
    ]);
  });
});

describe("bundleTotal", () => {
  it("adds the parts up, a missing one as nothing", () => {
    const total = bundleTotal([
      { part: "a", source: "a", bytes: 1_500_000_000 },
      { part: "b", source: "b", bytes: null },
      { part: "c", source: "c", bytes: 330_000_000 },
    ]);
    expect(gb(total)).toBe("1.83 GB");
  });
});
