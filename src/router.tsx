import { QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createIsomorphicFn } from "@tanstack/react-start";

import { newNonce } from "./lib/csp";
import { routeTree } from "./routeTree.gen";

// A CSP nonce per server render; the root route puts it in the policy and TanStack on every script it writes. In
// the browser the router reads it back from the page's csp-nonce meta tag.
const ssrOptions = createIsomorphicFn()
  .server(() => ({ nonce: newNonce() }))
  .client(() => undefined);

// On the server TanStack Start calls this once per request, so each request gets its own QueryClient. A shared one
// would serve one user's cached queries to the next.
export function getRouter() {
  const queryClient = new QueryClient();
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    ssr: ssrOptions(),
  });
  // Sends the server's queries to the browser with the page, and wraps the app in a QueryClientProvider.
  setupRouterSsrQueryIntegration({ router, queryClient });

  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
