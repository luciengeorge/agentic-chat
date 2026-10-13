import { defineNitroConfig } from "nitro/config";

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "frame-src 'self' https://vercel.live",
    "object-src 'none'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https://fonts.gstatic.com https:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "script-src 'self' 'unsafe-inline' https://vercel.live",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "media-src 'self' blob: data: https:",
    "upgrade-insecure-requests",
  ].join("; "),
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
      },
    },
  },
});
