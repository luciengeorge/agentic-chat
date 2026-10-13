import type { AcEnv } from "@/lib/env";

/** 128 random bits, hex: a fresh one per page response. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The pages' Content-Security-Policy. Scripts run only from this origin or with this response's nonce (TanStack
 * puts it on the scripts it writes into the page), so an injected inline script doesn't run. Images, fonts and
 * fetches stay on this origin: chat renders model output, and a model tricked into writing an image link must not
 * be able to send data to another host in its URL. Styles keep 'unsafe-inline' because the UI library positions
 * popups with style attributes; CSS can't run code. Dev adds the Vite HMR socket.
 */
export function contentSecurityPolicy(nonce: string, env: AcEnv): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'self'",
    "object-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    env === "dev" ? "connect-src 'self' ws://localhost:* ws://127.0.0.1:*" : "connect-src 'self'",
    "worker-src 'self' blob:",
    "media-src 'self'",
    ...(env === "prod" ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}
