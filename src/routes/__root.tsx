import type { QueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { TanStackDevtools } from "@tanstack/react-devtools";
import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";

import { AppError } from "@/components/app-error";
import { GlobalLoading } from "@/components/global-loading";
import { Toaster } from "@/components/ui/sonner";
import { useToast } from "@/hooks/use-toast";
import { contentSecurityPolicy } from "@/lib/csp";
import { acEnv } from "@/lib/env";
import { getToast } from "@/lib/functions/get-toast";

import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import appCss from "../styles.css?url";

interface RouterContext {
  queryClient: QueryClient;
}

const APP_NAME = import.meta.env.VITE_APP_NAME ?? "agentic-chat";
const SITE_URL = import.meta.env.VITE_SITE_URL ?? "http://localhost:3000";
const TITLE = APP_NAME;
const DESCRIPTION = "A workshop for building a permissioned assistant and agent platform, one layer at a time.";

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    const serverToast = await getToast();
    return { serverToast };
  },
  component: RootComponent,
  errorComponent: AppError,
  // The page's CSP carries this response's nonce, so it's set here rather than in nitro.config.ts.
  headers: ({ ssr }) =>
    ssr?.nonce ? { "Content-Security-Policy": contentSecurityPolicy(ssr.nonce, acEnv()) } : undefined,
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: TITLE },
      { name: "description", content: DESCRIPTION },
      { name: "robots", content: "index, follow" },
      { property: "og:title", content: TITLE },
      { property: "og:description", content: DESCRIPTION },
      { property: "og:type", content: "website" },
      { property: "og:url", content: SITE_URL },
      { property: "og:site_name", content: APP_NAME },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: TITLE },
      { name: "twitter:description", content: DESCRIPTION },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "canonical", href: SITE_URL },
      { rel: "icon", href: "/favicon.ico" },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="mt-2 text-muted-foreground">The requested page could not be found.</p>
    </main>
  ),
  shellComponent: RootDocument,
});

function RootComponent() {
  const { serverToast } = Route.useRouteContext();
  useToast(serverToast);

  return <Outlet />;
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="font-sans antialiased">
        <GlobalLoading />
        <Toaster closeButton richColors />
        <main className="isolate flex min-h-svh w-full flex-col">{children}</main>
        <TanStackDevtools
          config={{ position: "bottom-right" }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Scripts />
      </body>
    </html>
  );
}
