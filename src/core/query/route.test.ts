// @vitest-environment node

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hashingEmbedder } from "#learn/embed/fake";
import { chunks, documentAcl, documents, principals } from "@/db/schema";
import { withTenantOn } from "@/db/tenant";
import { createTestDatabase, postgresAvailable, type TestDatabase } from "@/db/testing";

import { type DocumentCard, documentCards, routeDocuments } from "./route";

const embedder = hashingEmbedder(256);
const dbEmbedder = hashingEmbedder(1536);

async function card(documentId: string, title: string, path: string, text: string): Promise<DocumentCard> {
  const [embedding] = await embedder.embed([text]);
  return { documentId, title, path, text, embedding };
}

describe("routeDocuments", () => {
  it("puts the document a question is about first, by its title and path as well as its first chunk", async () => {
    const cards = [
      await card(
        "filing",
        "Annual Report 2025.pdf",
        "/Finance/Reports/Annual Report 2025.pdf",
        "Annual report: revenue, costs, expenses by segment.",
      ),
      await card(
        "policy",
        "Travel and Expenses Policy v2.pdf",
        "/HR/Policies/Travel and Expenses Policy v2.pdf",
        "Travel and expenses policy: meals, hotels, receipts.",
      ),
      await card(
        "runbook",
        "On-call Runbook.md",
        "/Engineering/On-call Runbook.md",
        "Paging, escalation and incident roles.",
      ),
    ];
    const question = "What does the travel policy say about hotels?";
    const [vector] = await embedder.embed([question]);

    expect(routeDocuments(question, vector, cards, 1)).toEqual(["policy"]);
    expect(routeDocuments(question, vector, cards, 2)).toHaveLength(2);
    expect(routeDocuments(question, vector, cards, 10)).toHaveLength(3);
  });

  it("still routes a card with no vector of the query's model, by its words", async () => {
    const cards = [
      {
        ...(await card("register", "Contract Register.pdf", "/Legal/Contract Register.pdf", "Contracts by number.")),
        embedding: null,
      },
      await card("menu", "Lunch Menu.md", "/Office/Lunch Menu.md", "Soup and sandwiches."),
    ];
    const question = "contract register";
    const [vector] = await embedder.embed([question]);
    expect(routeDocuments(question, vector, cards, 1)).toEqual(["register"]);
  });

  it("refuses a limit below 1", () => {
    expect(() => routeDocuments("q", [1], [], 0)).toThrow(RangeError);
  });
});

describe.skipIf(!postgresAvailable)("documentCards", () => {
  let t: TestDatabase;
  let tenantId: string;
  const [ready, other, ingesting, secret] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const user = randomUUID();

  beforeAll(async () => {
    t = await createTestDatabase();
    [{ id: tenantId }] = await t.sql`
      INSERT INTO organization (name, slug, created_at) VALUES ('Kestrel', 'kestrel', now()) RETURNING id`;
    const doc = (id: string, version: number, status: string) => ({
      id,
      tenantId,
      source: "test",
      externalId: id,
      title: `title ${id.slice(0, 4)}`,
      path: `/p/${id}`,
      mimeType: "text/markdown",
      version,
      sourceVersion: String(version),
      contentHash: id,
      status,
    });
    await t.db
      .insert(documents)
      .values([
        doc(ready, 2, "ready"),
        doc(other, 1, "ready"),
        doc(ingesting, 1, "ingesting"),
        doc(secret, 1, "ready"),
      ]);
    await t.db.insert(principals).values({
      id: user,
      tenantId,
      kind: "user",
      externalId: user,
      name: "leo.martin",
      displayName: "Leo",
      enabled: true,
      syncedAt: new Date(),
    });
    await t.db.insert(documentAcl).values(
      [ready, other, ingesting].map((documentId) => ({
        tenantId,
        documentId,
        principalId: user,
        effect: "allow",
        aclVersion: 1,
      })),
    );
    const [vector] = await dbEmbedder.embed(["v2 first"]);
    const chunk = (documentId: string, documentVersion: number, ordinal: number, text: string, embedded = false) => ({
      tenantId,
      documentId,
      documentVersion,
      ordinal,
      text,
      tokenCount: 2,
      ...(embedded && { embedding: vector, embeddingModelVersion: dbEmbedder.version }),
    });
    await t.db
      .insert(chunks)
      .values([
        chunk(ready, 1, 0, "v1 first"),
        chunk(ready, 2, 5, "v2 second"),
        chunk(ready, 2, 3, "v2 first", true),
        chunk(other, 1, 0, "other first"),
        chunk(ingesting, 1, 0, "ingesting first"),
        chunk(secret, 1, 0, "secret first"),
      ]);
  });

  afterAll(async () => {
    await t?.drop();
  });

  it("gives each readable document asked for its first chunk at its current version, with the model's vector", async () => {
    // Not ready, and not shared with the user: neither gets a card, so routing can't pick or reveal them.
    const cards = await withTenantOn(t.appDb, tenantId, (tx) =>
      documentCards(tx, user, [ready, ingesting, secret], dbEmbedder.version),
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ documentId: ready, text: "v2 first", path: `/p/${ready}` });
    expect(cards[0].embedding).toHaveLength(1536);

    const [plain] = await withTenantOn(t.appDb, tenantId, (tx) => documentCards(tx, user, [ready], "other-model@1536"));
    expect(plain.embedding).toBeNull();
  });
});
