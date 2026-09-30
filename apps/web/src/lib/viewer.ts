import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { getBff } from "./bff.server";

export const getViewer = createServerFn({ method: "GET" }).handler(async () => {
  const current = await getBff().freshSession(getRequest());
  return current ? { username: current.session.username, tenant: current.session.tenant } : null;
});
