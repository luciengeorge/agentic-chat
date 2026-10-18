import { withTenantOn } from "#learn/acl/tenant";

import type { Db } from "./create";

import { appDb } from "./pool";

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** `withTenantOn` lives in `#learn/acl/tenant` (section 09.6); every importer keeps importing it from here. */
export { withTenantOn };

/** `withTenantOn` the app role's pool. */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantOn(appDb(), tenantId, fn);
}
