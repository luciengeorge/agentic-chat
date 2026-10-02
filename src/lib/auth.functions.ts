import { createServerFn } from "@tanstack/react-start";

import { getViewer } from "@/lib/auth-server";

/** The viewer, or null when signed out, for route guards. */
export const getOptionalViewer = createServerFn({ method: "GET" }).handler(async () => {
  try {
    return await getViewer();
  } catch (error) {
    if (error instanceof Response && error.status === 401) return null;
    throw error;
  }
});
