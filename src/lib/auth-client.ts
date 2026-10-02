import { adminClient, organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same origin: the handler is mounted at /api/auth/*, so no baseURL is needed.
export const authClient = createAuthClient({
  plugins: [adminClient(), organizationClient()],
});
