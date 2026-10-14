// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "#learn/retrieve/types";

import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { addNote, deleteNote, listNotes, MAX_NOTE_CHARS, MAX_NOTES, MemoryFullError, rememberTool } from "./memory";

const LEO = "44444444-4444-4444-8444-444444444444";
const NORA = "55555555-5555-4555-8555-555555555555";

describe.skipIf(!postgresAvailable)("memory notes", () => {
  let t: TestDatabase;
  let leo: Viewer;
  let nora: Viewer;
  const inTenant = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(t.appDb, leo.tenantId, fn);
  const notes = (viewer = leo) => inTenant((tx) => listNotes(tx, viewer.userId));

  beforeAll(async () => {
    t = await createTestDatabase();
    const [{ id: tenant }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel Pay', 'kestrel', now()) RETURNING id`;
    for (const [id, name] of [
      [LEO, "leo.martin"],
      [NORA, "nora.kim"],
    ]) {
      await t.sql`INSERT INTO principals (id, tenant_id, kind, external_id, name, display_name, enabled, synced_at)
                  VALUES (${id}, ${tenant}, 'user', ${id}, ${name}, ${name}, true, now())`;
    }
    leo = { tenantId: tenant, userId: LEO };
    nora = { tenantId: tenant, userId: NORA };
  });

  afterAll(async () => {
    await t?.drop();
  });

  beforeEach(async () => {
    await t.sql`DELETE FROM memory_notes`;
  });

  it("stores a note once, tidied, and lists it oldest first", async () => {
    await inTenant((tx) => addNote(tx, leo, "Works  in\nFinance AP.", null));
    expect(await inTenant((tx) => addNote(tx, leo, "works in finance ap.", null))).toMatchObject({ created: false });
    await inTenant((tx) => addNote(tx, leo, "Prefers French.", null));
    expect((await notes()).map((n) => n.text)).toEqual(["Works in Finance AP.", "Prefers French."]);
    expect(await notes(nora)).toEqual([]);
  });

  it("caps the length and the count, even when notes arrive together", async () => {
    await expect(inTenant((tx) => addNote(tx, leo, "x".repeat(MAX_NOTE_CHARS + 1), null))).rejects.toThrow(RangeError);
    await expect(inTenant((tx) => addNote(tx, leo, "   ", null))).rejects.toThrow(RangeError);
    const results = await Promise.allSettled(
      Array.from({ length: MAX_NOTES + 5 }, (_, i) => inTenant((tx) => addNote(tx, leo, `fact ${i}`, null))),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(MAX_NOTES);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(MemoryFullError);
    expect(await notes()).toHaveLength(MAX_NOTES);
  });

  it("lets only its user delete a note", async () => {
    const { id } = await inTenant((tx) => addNote(tx, leo, "Prefers French.", null));
    expect(await inTenant((tx) => deleteNote(tx, nora.userId, id))).toBe(false);
    expect(await inTenant((tx) => deleteNote(tx, leo.userId, id))).toBe(true);
    expect(await notes()).toEqual([]);
  });

  it("gives the agent a remember tool that writes the acting user's notes, without approval", async () => {
    const tool = rememberTool({ withTenant: (tenantId, fn) => withTenantOn(t.appDb, tenantId, fn) });
    const runId = crypto.randomUUID();
    const ctx = {
      viewer: leo,
      runId,
      callId: "c1",
      idempotencyKey: `${runId}:c1`,
      signal: new AbortController().signal,
    };
    expect(tool.effect).toBe("write");
    expect(tool.needsApproval({ note: "x" }, ctx)).toBe(false);
    expect(tool.input.safeParse({ note: "x".repeat(MAX_NOTE_CHARS + 1) }).success).toBe(false);
    expect(await tool.execute({ note: "Leo's manager is Amara." }, ctx)).toMatchObject({ saved: true });
    expect(await notes()).toMatchObject([{ text: "Leo's manager is Amara.", sourceRunId: runId }]);
  });
});
