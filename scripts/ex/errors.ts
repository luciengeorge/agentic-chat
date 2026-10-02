/** A failure `ex` reports as `{"error": message, "detail": detail}`. */
export class ExError extends Error {
  override name = "ExError";
  readonly detail: unknown;

  constructor(message: string, detail: unknown = null) {
    super(message);
    this.detail = detail;
  }
}
