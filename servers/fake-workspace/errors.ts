/** Errors in Microsoft Graph's shape: `{"error": {"code": "...", "message": "..."}}`. */
import type { z } from "zod";

export class GraphError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers?: Record<string, string>,
    readonly innerCode?: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export function badRequest(message: string): GraphError {
  return new GraphError(400, "invalidRequest", message);
}

export function notFound(message = "The resource could not be found."): GraphError {
  return new GraphError(404, "itemNotFound", message);
}

export function notReady(message = "No corpus is loaded yet."): GraphError {
  return new GraphError(503, "serviceNotReady", message);
}

export function errorResponse(error: GraphError): Response {
  const body: Record<string, unknown> = { code: error.code, message: error.message };
  if (error.innerCode !== undefined) body.innerError = { code: error.innerCode };
  return Response.json({ error: body }, { status: error.status, headers: error.headers });
}

/** One `where: what` per problem, joined, as a 400. */
export function invalid(error: z.ZodError, where: string): GraphError {
  const problems = error.issues.map((issue) => [where, ...issue.path.map(String)].join(".") + `: ${issue.message}`);
  return badRequest(problems.join("; "));
}
