// 👨‍💼 Two writes leave the agent for Kestrel's Microsoft 365 (fake-workspace here): a mail, and a share. Each can
//    fail on its way: a 429 when the tenant is busy, a 503 when a node restarts, a connection that drops after the
//    service did the work but before the answer came back. Trying again is right for all three, as long as the
//    service can tell a retry from a new request.

/**
 * The two Graph writes the agent makes: send a mail as a user, and share a drive item. Each carries the call's
 * `Idempotency-Key`, so retrying it (here on a 429 or a 5xx, or a whole run resumed after a crash) can't do the
 * thing twice: the service answers a repeat with the first answer.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface WorkspaceWriterOptions {
  /** e.g. http://localhost:8100 */
  baseUrl: string;
  /** The tenant's site; in Graph's write routes it's also the drive id. */
  site: string;
  token: string;
  fetch?: Fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Retries of a 429 or 5xx, with the same key. */
  maxRetries?: number;
}

export interface OutgoingMail {
  to: string[];
  subject: string;
  body: string;
  /** Drive item ids. */
  attachments: Array<{ itemId: string; name: string }>;
}

export class WorkspaceWriteError extends Error {
  override name = "WorkspaceWriteError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const RETRY_AFTER_CAP_MS = 10_000;

function abortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export function createWorkspaceWriter(options: WorkspaceWriterOptions) {
  const { site, token, maxRetries = 2 } = options;
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? abortable;
  const base = options.baseUrl.replace(/\/$/, "");

  async function post(
    path: string,
    body: unknown,
    idempotencyKey: string,
    signal: AbortSignal,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    // 🐨 POST `body` as JSON to `${base}${path}`, with `signal`, and these headers: `authorization` `Bearer <token>`,
    //    `content-type` `application/json`, `idempotency-key` the key you were given, then `headers`.
    // 🐨 A 2xx answer: return it.
    // 🐨 A 429 or any 5xx, with retries left (`attempt < maxRetries`): throw the answer's body away
    //    (`response.body?.cancel()`), wait, and send the same request again, with the same key. Wait what the
    //    `Retry-After` header says, in seconds, when it says a positive number, and 250 ms × 2^attempt when it
    //    doesn't (250, then 500); never more than RETRY_AFTER_CAP_MS. Wait with `sleep(ms, signal)`, so an abort
    //    stops the wait too.
    // 🐨 Anything else, or out of retries: read the answer's text, take Graph's `{ error: { code, message } }` from
    //    it if it parses, and throw a `WorkspaceWriteError` with the status, the code (or "unknown") and the message (or
    //    "HTTP <status>").
    //
    // 💰 `for (let attempt = 0; ; attempt++) { ... }`. `response.ok`, `response.status`,
    //    `response.headers.get("retry-after")`, `Number(...)`, `Number.isFinite(n)`, `Math.min(a, b)`.
    // 💰 `JSON.parse` throws on text that isn't JSON: wrap it in `try { } catch { }`.
    //
    // 🚨 The classic mistake is a new key on a retry. Make it per attempt (a random id, the attempt number in it)
    //    and a 503 that came back after the service sent the mail turns into a second mail.
    //
    // 🦉 Why the key goes on every attempt, unchanged. A 503 or a dropped connection doesn't say whether the work
    //    happened. fake-workspace keeps the answer to each key it has done: the same key and the same request get
    //    that answer again (with `Idempotent-Replayed: true`) and nothing is sent; the same key with a different
    //    request gets a 422, which means the key was made wrong. So a retry is safe only because the key is the
    //    same.
    // 🦉 Why a cap on Retry-After. A tool call has 30 seconds (section 13.4) before the loop gives up on it. A
    //    service that asks for 120 would hold the call past that for nothing: 10 seconds at most keeps a retry
    //    inside the call's time.
    // 🦉 Why a 400, 403 or 404 isn't retried. The request itself is wrong (no such user, an attachment the sender
    //    can't read). It fails the same way every time, and the model should hear why.
    //
    // 🚨 The tests send mail to an in-process fake-workspace with faults: a 503 then a success, 429s with and
    //    without Retry-After, a 403, a repeat of a key, and the kill proof in miniature.
    void [fetch, sleep, token, maxRetries, RETRY_AFTER_CAP_MS, body, signal, headers];
    throw new Error(`post(${base}${path}, key ${idempotencyKey}) isn't written yet`);
  }

  return {
    async sendMail(fromUserId: string, mail: OutgoingMail, idempotencyKey: string, signal: AbortSignal) {
      await post(
        `/v1.0/users/${encodeURIComponent(fromUserId)}/sendMail`,
        {
          message: {
            subject: mail.subject,
            body: { contentType: "Text", content: mail.body },
            toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
            attachments: mail.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.referenceAttachment",
              name: a.name,
              sourceUrl: `${base}/v1.0/drives/${encodeURIComponent(site)}/items/${encodeURIComponent(a.itemId)}`,
            })),
          },
          saveToSentItems: true,
        },
        idempotencyKey,
        signal,
      );
    },

    /** Shares the item as `actingUserId`, who the service checks can read it (a delegated token's subject). */
    async invite(
      actingUserId: string,
      itemId: string,
      principalId: string,
      idempotencyKey: string,
      signal: AbortSignal,
    ) {
      await post(
        `/v1.0/drives/${encodeURIComponent(site)}/items/${encodeURIComponent(itemId)}/invite`,
        { recipients: [{ objectId: principalId }], roles: ["read"], requireSignIn: true, sendInvitation: false },
        idempotencyKey,
        signal,
        { "x-acting-user": actingUserId },
      );
    },
  };
}

export type WorkspaceWriter = ReturnType<typeof createWorkspaceWriter>;
