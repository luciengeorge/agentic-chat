export const TENANTS = ["kestrel", "harbour"] as const;
export type Tenant = (typeof TENANTS)[number];
