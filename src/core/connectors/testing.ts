import type { Client } from "../../../servers/fake-workspace/testing";
import type { Fetch } from "./graph";

/** A fetch that sends each request to an in-process fake-workspace app. */
export function fetchFrom(client: Client): Fetch {
  return (url, init = {}) =>
    client.request(init.method ?? "GET", url, {
      headers: Object.fromEntries(new Headers(init.headers)),
      body: init.body as string | undefined,
    });
}
