import { createClient } from "redis";

import { createBff } from "./bff";
import { getEnv } from "./env";
import { createOidcClient } from "./oidc";
import { createSessionStore } from "./session-store";

let bff: ReturnType<typeof createBff> | undefined;

/** KEYS[1] = session key, ARGV[1] = expected version, ARGV[2] = new value. Atomic, so a logout can't slip in. */
const SET_IF_VERSION = `
local current = redis.call("GET", KEYS[1])
if not current or cjson.decode(current).version ~= tonumber(ARGV[1]) then return 0 end
redis.call("SET", KEYS[1], ARGV[2], "KEEPTTL")
return 1
`;

/** The process-wide BFF, wired to the real Redis and Keycloak. Built lazily so importing it has no side effects. */
export function getBff() {
  if (!bff) {
    const env = getEnv();
    const redis = createClient({ url: env.AC_REDIS_URL });
    redis.on("error", (error) => console.error("redis", error));
    const connected = redis.connect();
    // A failed first connect drops the instance, so the next request tries again.
    connected.catch(() => {
      bff = undefined;
    });
    const kv = {
      get: async (key: string) => (await connected).get(key),
      set: async (key: string, value: string, options: { EX: number }) => (await connected).set(key, value, options),
      getDel: async (key: string) => (await connected).getDel(key),
      del: async (key: string) => (await connected).del(key),
      setIfVersion: async (key: string, version: number, value: string) =>
        (await (await connected).eval(SET_IF_VERSION, { keys: [key], arguments: [String(version), value] })) === 1,
    };
    bff = createBff({ env, store: createSessionStore(kv), oidc: createOidcClient(env), fetch });
  }
  return bff;
}
