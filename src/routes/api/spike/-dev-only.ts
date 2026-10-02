import { acEnv } from "@/lib/auth-env";

export function devOnly() {
  return acEnv() === "dev" ? null : new Response("Not found", { status: 404 });
}
