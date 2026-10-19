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
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          ...headers,
        },
        body: JSON.stringify(body),
        signal,
      });
      if (response.ok) return response;
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        await response.body?.cancel();
        const seconds = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 250 * 2 ** attempt;
        await sleep(Math.min(wait, RETRY_AFTER_CAP_MS), signal);
        continue;
      }
      const text = await response.text().catch(() => "");
      let error: { code?: string; message?: string } | undefined;
      try {
        error = (JSON.parse(text) as { error?: { code?: string; message?: string } }).error;
      } catch {
        // not JSON
      }
      throw new WorkspaceWriteError(
        response.status,
        error?.code ?? "unknown",
        error?.message ?? `HTTP ${response.status}`,
      );
    }
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
