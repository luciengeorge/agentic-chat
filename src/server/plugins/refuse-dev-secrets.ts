import { definePlugin } from "nitro";

import { assertSafeSecrets } from "@/lib/auth-env";
import { assertProdEnv } from "@/lib/env-check";

// Nitro runs plugins at startup, so a prod server with a variable missing, or with the dev secrets, stops before its
// first request.
export default definePlugin(() => {
  assertProdEnv();
  assertSafeSecrets();
});
