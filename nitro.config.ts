import { defineNitroConfig } from "nitro/config";

// Pages get their Content-Security-Policy from the root route, with a nonce per response (src/lib/csp.ts).
const securityHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=(), browsing-topics=(), interest-cohort=()",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export default defineNitroConfig({
  // The secrets first: a server that must not run stops before the world recovers any run. The relay last: it
  // starts runs, so the world is up first.
  plugins: [
    "./src/server/plugins/refuse-dev-secrets.ts",
    "./src/workflows/start-world.ts",
    "./src/server/plugins/relay.ts",
    "./src/server/plugins/agent-queue.ts",
  ],
  // OCR (the ingest page route) loads tesseract.js from node_modules: bundled, it reads `__dirname`, which ESM
  // lacks, and its worker script and English model are files it finds on disk. The trailing * traces the whole
  // package into .output.
  traceDeps: ["tesseract.js*", "tesseract.js-core*", "@tesseract.js-data/eng*"],
  routeRules: {
    "/**": {
      headers: securityHeaders,
    },
    "/api/**": {
      headers: {
        "Cache-Control": "no-store",
        ...securityHeaders,
        // API responses are data, never documents that run code.
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      },
    },
  },
});
