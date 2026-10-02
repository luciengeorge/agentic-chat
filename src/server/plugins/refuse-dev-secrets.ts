import { definePlugin } from "nitro";

import { assertSafeSecrets } from "@/lib/auth-env";

// Nitro runs plugins at startup, so a prod server with the dev secrets stops before its first request.
export default definePlugin(() => {
  assertSafeSecrets();
});
