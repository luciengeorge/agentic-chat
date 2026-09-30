import { z } from "zod";

import { TENANTS } from "./tenants";

export const SESSION_TTL_SECONDS = 60 * 60 * 8;
export const LOGIN_TTL_SECONDS = 60 * 10;

/** The subset of a Redis client the store needs, so tests can use an in-memory fake. */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  getDel(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  /** Overwrites `key` only if it still exists and its JSON `version` is `version`, keeping its remaining TTL. */
  setIfVersion(key: string, version: number, value: string): Promise<boolean>;
}

const TenantSchema = z.enum(TENANTS);

const PendingLoginSchema = z.object({
  tenant: TenantSchema,
  state: z.string(),
  nonce: z.string(),
  codeVerifier: z.string(),
  returnTo: z.string(),
});
export type PendingLogin = z.infer<typeof PendingLoginSchema>;

const SessionSchema = z.object({
  tenant: TenantSchema,
  sub: z.string(),
  username: z.string(),
  accessToken: z.string(),
  refreshToken: z.string().optional(),
  idToken: z.string().optional(),
  expiresAt: z.number(),
  /** Bumped on every write, so a refresh that lost a race can't overwrite the winner (or revive a logout). */
  version: z.number().int().nonnegative(),
});
export type Session = z.infer<typeof SessionSchema>;

const sessionKey = (id: string) => `bff:session:${id}`;
const loginKey = (id: string) => `bff:login:${id}`;

function newId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function decode<T>(schema: z.ZodType<T>, raw: string | null): T | null {
  if (raw === null) return null;
  const parsed = schema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export function createSessionStore(kv: KeyValue) {
  return {
    async createLogin(login: PendingLogin): Promise<string> {
      const id = newId();
      await kv.set(loginKey(id), JSON.stringify(login), { EX: LOGIN_TTL_SECONDS });
      return id;
    },
    /** Single use: the record is deleted as it is read, so a callback can't be replayed. */
    async takeLogin(id: string): Promise<PendingLogin | null> {
      return decode(PendingLoginSchema, await kv.getDel(loginKey(id)));
    },
    async create(session: Omit<Session, "version">): Promise<string> {
      const id = newId();
      await kv.set(sessionKey(id), JSON.stringify({ ...session, version: 0 }), { EX: SESSION_TTL_SECONDS });
      return id;
    },
    async get(id: string): Promise<Session | null> {
      return decode(SessionSchema, await kv.get(sessionKey(id)));
    },
    /** Writes `session` over the version it was read at. False if the session has since changed or gone. */
    async update(id: string, session: Session): Promise<boolean> {
      const next = { ...session, version: session.version + 1 };
      return kv.setIfVersion(sessionKey(id), session.version, JSON.stringify(next));
    },
    async destroy(id: string): Promise<void> {
      await kv.del(sessionKey(id));
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
