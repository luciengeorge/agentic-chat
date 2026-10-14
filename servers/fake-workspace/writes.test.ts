// @vitest-environment node
import { describe, expect, it } from "vitest";

import { type Client, setupFakeWorkspace } from "./testing";

const fw = setupFakeWorkspace();

const leo = () => fw.corpus.user("kestrel", "leo.martin");
const reference = (path: string, site = "kestrel") => ({
  "@odata.type": "#microsoft.graph.referenceAttachment",
  name: path.split("/").at(-1),
  sourceUrl: `http://fw/v1.0/drives/${site}/items/${fw.corpus.id(site as "kestrel", path)}`,
});
const mail = (attachments: unknown[] = []) => ({
  message: {
    subject: "Q3",
    body: { contentType: "Text", content: "See attached." },
    toRecipients: [{ emailAddress: { address: "tom.whitfield@kestrelpay.example" } }],
    attachments,
  },
});

const sendMail = (client: Client, json: unknown, key?: string, userId = leo()) =>
  client.post(`/v1.0/users/${userId}/sendMail`, { json, headers: key ? { "Idempotency-Key": key } : {} });

const sent = async (client: Client) =>
  ((await (await client.get("/_control/mail")).json()) as { value: Array<Record<string, unknown>> }).value;

describe("sendMail", () => {
  it("accepts a mail (202), keeps it, and lists it on the control API", async () => {
    const client = fw.client();
    const response = await sendMail(client, mail([reference("/Finance/Reports/Q3 report.pdf")]), "k1");
    expect(response.status).toBe(202);
    const [one, ...rest] = await sent(client);
    expect(rest).toEqual([]);
    expect(one).toMatchObject({
      site: "kestrel",
      from: { id: leo(), address: "leo.martin@kestrelpay.example" },
      to: ["tom.whitfield@kestrelpay.example"],
      subject: "Q3",
      body: "See attached.",
      attachments: [{ itemId: fw.corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf"), name: "Q3 report.pdf" }],
      idempotencyKey: "k1",
    });
  });

  it("refuses an attachment the sender can't read, and sends nothing", async () => {
    const client = fw.client();
    const response = await sendMail(client, mail([reference("/Exec/Project Heron memo.pdf")]));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "accessDenied" } });
    expect(await sent(client)).toEqual([]);
  });

  it("refuses an attachment from another site's drive, and a disabled or unknown sender", async () => {
    const client = fw.client();
    expect((await sendMail(client, mail([reference("/Policies/expenses.pdf", "harbour")]))).status).toBe(400);
    expect((await sendMail(client, mail(), undefined, fw.corpus.user("kestrel", "peter.hall"))).status).toBe(403);
    expect((await sendMail(client, mail(), undefined, "nobody")).status).toBe(404);
    expect(await sent(client)).toEqual([]);
  });

  it("sends once per Idempotency-Key: a repeat replays the 202, a different body gets a 422", async () => {
    const client = fw.client();
    expect((await sendMail(client, mail(), "same")).status).toBe(202);
    const again = await sendMail(client, mail(), "same");
    expect(again.status).toBe(202);
    expect(again.headers.get("Idempotent-Replayed")).toBe("true");
    const changed = await sendMail(client, { ...mail(), message: { ...mail().message, subject: "Other" } }, "same");
    expect(changed.status).toBe(422);
    expect(await sent(client)).toHaveLength(1);
    expect((await sendMail(client, mail(), "another")).status).toBe(202);
    expect(await sent(client)).toHaveLength(2);
  });

  it("sends once when two requests with one key arrive together", async () => {
    const client = fw.client();
    await client.post("/_control/faults", { json: { kind: "latency", latency_ms: 0, path_prefix: "/v1.0/users" } });
    const answers = await Promise.all([sendMail(client, mail(), "race"), sendMail(client, mail(), "race")]);
    expect(answers.map((a) => a.status)).toEqual([202, 202]);
    expect(await sent(client)).toHaveLength(1);
  });

  it("answers injected faults without sending, and the retry with the same key sends once", async () => {
    const client = fw.client();
    await client.post("/_control/faults", { json: { kind: "throttle", path_prefix: "/v1.0/users", count: 1 } });
    await client.post("/_control/faults", {
      json: { kind: "error", status: 502, path_prefix: "/v1.0/users", count: 1 },
    });
    const throttled = await sendMail(client, mail(), "retry");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("1");
    expect((await sendMail(client, mail(), "retry")).status).toBe(502);
    expect((await sendMail(client, mail(), "retry")).status).toBe(202);
    expect(await sent(client)).toHaveLength(1);
  });

  it("forgets sent mail and keys on reset", async () => {
    const client = fw.client();
    await sendMail(client, mail(), "k");
    await client.post("/_control/reset");
    expect(await sent(client)).toEqual([]);
    expect((await sendMail(client, { ...mail(), message: { ...mail().message, subject: "New" } }, "k")).status).toBe(
      202,
    );
  });

  it("lists sent mail only through the control API's checks", async () => {
    const client = fw.client({ sendControl: false });
    expect((await client.get("/_control/mail")).status).toBe(403);
  });
});

describe("invite", () => {
  // Tom can read (and write) the Q3 report; Marco, in HR, can't until it's shared with him.
  const report = () => fw.corpus.id("kestrel", "/Finance/Reports/Q3 report.pdf");
  const tom = () => fw.corpus.user("kestrel", "tom.whitfield");
  const marco = () => fw.corpus.user("kestrel", "marco.bianchi");
  const invite = (
    client: Client,
    objectId: string,
    key?: string,
    itemId = report(),
    drive = "kestrel",
    actingUser: string | null = tom(),
  ) =>
    client.post(`/v1.0/drives/${drive}/items/${itemId}/invite`, {
      json: { recipients: [{ objectId }], roles: ["read"], requireSignIn: true, sendInvitation: false },
      headers: { ...(key ? { "Idempotency-Key": key } : {}), ...(actingUser ? { "X-Acting-User": actingUser } : {}) },
    });
  const invites = async (client: Client) =>
    ((await (await client.get("/_control/invites")).json()) as { value: Array<Record<string, unknown>> }).value;

  it("grants the role, shows it in permissions and delta, and notifies once", async () => {
    const client = fw.client();
    const before = (await (await client.get("/v1.0/sites/kestrel/drive/root/delta?token=latest")).json()) as {
      "@odata.deltaLink": string;
    };
    const response = await invite(client, marco(), "share-1");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      value: [{ roles: ["read"], grantedToV2: { user: { id: marco(), displayName: "Marco Bianchi" } } }],
    });
    const permissions = (await (
      await client.get(`/v1.0/sites/kestrel/drive/items/${report()}/permissions`)
    ).json()) as {
      value: Array<{ grantedToV2: { user?: { id: string } } }>;
    };
    expect(permissions.value.some((p) => p.grantedToV2.user?.id === marco())).toBe(true);

    const delta = (await (
      await client.get(before["@odata.deltaLink"].replace("http://fw", ""), {
        headers: { Prefer: "deltashowsharingchanges" },
      })
    ).json()) as { value: Array<{ id: string; "@microsoft.graph.sharedChanged"?: string }> };
    expect(delta.value).toEqual([expect.objectContaining({ id: report(), "@microsoft.graph.sharedChanged": "True" })]);

    const seq = client.runtime.workspace.sites.get("kestrel")!.seq;
    expect((await invite(client, marco(), "share-1")).status).toBe(200);
    expect(client.runtime.workspace.sites.get("kestrel")!.seq).toBe(seq);
  });

  it("changes nothing for a principal that already holds the role", async () => {
    const client = fw.client();
    const seq = client.runtime.workspace.sites.get("kestrel")!.seq;
    const finance = fw.corpus.group("kestrel", "/Kestrel/Finance");
    const response = await invite(client, finance);
    expect(response.status).toBe(200);
    expect(client.runtime.workspace.sites.get("kestrel")!.seq).toBe(seq);
  });

  it("refuses a stranger, a disabled user, another drive, and a reused key with another body", async () => {
    const client = fw.client();
    expect((await invite(client, "stranger")).status).toBe(400);
    expect((await invite(client, fw.corpus.user("kestrel", "peter.hall"))).status).toBe(400);
    expect((await invite(client, marco(), undefined, report(), "harbour")).status).toBe(403);
    expect((await invite(client, marco(), "k")).status).toBe(200);
    expect((await invite(client, fw.corpus.user("kestrel", "tom.whitfield"), "k")).status).toBe(422);
  });

  it("acts for the user in X-Acting-User: one who can't read the item can't share it", async () => {
    const client = fw.client();
    const heron = fw.corpus.id("kestrel", "/Exec/Project Heron memo.pdf");
    expect((await invite(client, marco(), undefined, heron)).status).toBe(403);
    expect((await invite(client, marco(), undefined, report(), "kestrel", null)).status).toBe(401);
    expect((await invite(client, marco(), undefined, report(), "kestrel", marco())).status).toBe(403);
    expect((await invite(client, marco(), undefined, report(), "kestrel", "nobody")).status).toBe(403);
    expect(await invites(client)).toEqual([]);
    const permissions = (await (await client.get(`/v1.0/sites/kestrel/drive/items/${heron}/permissions`)).json()) as {
      value: Array<{ grantedToV2: { user?: { id: string } } }>;
    };
    expect(permissions.value.some((p) => p.grantedToV2.user?.id === marco())).toBe(false);
  });

  it("logs each invite once, with its acting user and key", async () => {
    const client = fw.client();
    await invite(client, marco(), "log-1");
    await invite(client, marco(), "log-1");
    expect(await invites(client)).toEqual([
      expect.objectContaining({
        itemId: report(),
        by: tom(),
        recipients: [marco()],
        added: [marco()],
        idempotencyKey: "log-1",
      }),
    ]);
    expect((await fw.client({ sendControl: false }).get("/_control/invites")).status).toBe(403);
  });
});
