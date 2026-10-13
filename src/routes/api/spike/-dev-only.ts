import { acEnv } from "@/lib/env";

/** Refuses a spike request outside dev, and a write that a page on another origin could send: one whose Origin
 * isn't the app's, or whose body isn't JSON (a form posts cross-origin without a preflight; JSON can't). Scripts
 * send no Origin, so they pass. */
export function devOnly(request: Request) {
  if (acEnv() !== "dev") return new Response("Not found", { status: 404 });
  if (request.method === "GET" || request.method === "HEAD") return null;

  const origin = request.headers.get("origin");
  if (origin !== null && origin !== appOrigin()) {
    return Response.json({ error: "cross-origin request refused" }, { status: 403 });
  }
  const contentType = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return Response.json({ error: "send the body as application/json" }, { status: 415 });
  }
  return null;
}

function appOrigin() {
  return new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000").origin;
}
