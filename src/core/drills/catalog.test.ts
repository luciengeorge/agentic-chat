// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Fault } from "./types";

import { applyEdits, varNames } from "../../../scripts/ex/drill";
import { DRILLS } from "./catalog";
import { seal, unseal } from "./seal";

const ROOT = join(import.meta.dirname, "../../..");
const faults = DRILLS.map((drill) => ({ id: drill.id, fault: unseal<Fault>(drill.id, drill.sealed) }));
const VARIABLE =
  /^(planted|tenant \S+|user \S+ \S+|group \S+ \S+|embedder \S+|local \d\d:\d\d -?\d+|local-utc \d\d:\d\d -?\d+)$/;

describe("sealing", () => {
  it("round-trips a value, and the sealed text shows none of it", () => {
    const value = { path: "src/core/demo/thing.ts", find: "return 42;" };
    const sealed = seal("demo", value);
    expect(unseal("demo", sealed)).toEqual(value);
    expect(sealed).not.toMatch(/thing|return|src/);
    expect(() => unseal("another-name", sealed)).toThrow();
  });
});

describe("the drills", () => {
  it("are the five of section 20, each with a title", () => {
    expect(DRILLS.map((drill) => drill.id)).toEqual(["leaver", "paraphrase", "ranking", "stuck-edits", "digest"]);
    for (const drill of DRILLS) expect(drill.title.length).toBeGreaterThan(10);
  });

  it.each(faults)("$id: its edits still apply, exactly once each, to the code in this repo", ({ fault }) => {
    expect(fault.files.length).toBeGreaterThan(0);
    for (const file of fault.files) {
      const text = readFileSync(join(ROOT, file.path), "utf8");
      expect(applyEdits(text, file.edits)).not.toBe(text);
    }
  });

  it.each(faults)("$id: names real slots, known variables and a test, and undoes what it plants", ({ fault }) => {
    for (const module of fault.modules) expect(existsSync(join(ROOT, "src/core", `${module}.ts`)), module).toBe(true);
    for (const name of varNames(fault)) expect(name, "a variable drill-live.ts knows").toMatch(VARIABLE);
    expect(fault.test).toContain("vitest");
    expect(fault.probes.length).toBeGreaterThan(0);
    expect(fault.plant.length > 0, "a drill that plants data undoes it").toBe(fault.undo.length > 0);
    expect(fault.symptom).not.toMatch(/src\/|\.ts\b/);
  });

  it("leave no fault's file named in the drill code anyone can read", () => {
    const readable = [
      ...readdirSync(join(ROOT, "src/core/drills")).map((name) => join("src/core/drills", name)),
      ...readdirSync(join(ROOT, "scripts/ex"))
        .filter((name) => name.startsWith("drill"))
        .map((name) => join("scripts/ex", name)),
    ].filter((path) => path.endsWith(".ts") && !path.endsWith("sealed.ts"));
    const named = faults.flatMap(({ fault }) => fault.files.map((file) => file.path));
    for (const path of readable) {
      const text = readFileSync(join(ROOT, path), "utf8");
      for (const file of named) {
        const bare = file.replace(/\.ts$/, "");
        const specifiers = [bare.replace(/^src\//, "@/"), bare.replace(/^src\/core\//, "#learn/")];
        const names = text.includes(file) || specifiers.some((specifier) => text.includes(`"${specifier}"`));
        expect(names, `${path} names ${file}`).toBe(false);
      }
    }
  });
});
