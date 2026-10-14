/**
 * What a content source must offer for Kestrel to mirror it (section 02). SharePoint through Graph is one
 * (`graphConnector` in `#learn/connectors/graph`); Google Drive or Confluence would be others. Drive sync
 * (`#learn/connectors/drive-sync`) speaks only this interface, so it never sees a Graph type.
 */

/** A file as the source describes it: enough to decide whether its content, its place or its name changed. */
export interface SourceFile {
  /** The source's stable id; `documents.external_id`. */
  id: string;
  name: string;
  /** Its folder path and name, from the source's root: `/Finance/AP/Batch.pdf`. */
  path: string;
  mimeType: string;
  /** Changes on any edit, content or not (Graph's eTag). */
  version: string;
  /** sha256 of the content, lower-case hex: new content, new hash. */
  contentHash: string;
}

/** One entry of a delta: a file in its current state, or the id of one that's gone. */
export type Change = { type: "file"; file: SourceFile } | { type: "deleted"; id: string };

export interface Subscription {
  id: string;
  expiresAt: Date;
}

/**
 * A failed call to the source. `status` is the HTTP status, or 0 when no answer came back. Throttling (429), an
 * outage (5xx) and no answer are worth trying again later, after `retryAfterMs` when the source said.
 */
export class ConnectorError extends Error {
  override name = "ConnectorError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

/** The delta cursor is too old for the source to answer from: enumerate everything again (a full crawl). */
export class ResyncRequiredError extends ConnectorError {
  override name = "ResyncRequiredError";
}

export interface Connector {
  /** Every file, a page at a time, as the source lists them. A file may appear twice; the last one wins. */
  crawl(): AsyncIterable<SourceFile[]>;

  /** A cursor for "from now on". Take it before a crawl: every change the crawl might miss comes in the next delta. */
  latestCursor(): Promise<string>;

  /** What changed since `cursor`, each item once, and the cursor to read from next. Throws `ResyncRequiredError`
   * when the cursor has expired. */
  delta(cursor: string): Promise<{ changes: Change[]; cursor: string }>;

  /** The ids of the users and groups that may read the file, its own grants and the ones it inherits. */
  permissions(fileId: string): Promise<string[]>;

  content(fileId: string): Promise<{ bytes: Uint8Array; contentType: string | null }>;

  /** Change notifications to `notificationUrl`, which echo `clientState` so the receiver can trust them. */
  subscribe(request: { notificationUrl: string; clientState: string; expiresAt: Date }): Promise<Subscription>;

  /** Moves a subscription's expiry on. A `ConnectorError` with status 404 means the source forgot it. */
  renew(subscriptionId: string, expiresAt: Date): Promise<Subscription>;
}
