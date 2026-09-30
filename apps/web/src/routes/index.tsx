import { createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { TENANTS } from "@/lib/tenants";
import { getViewer } from "@/lib/viewer";

export const Route = createFileRoute("/")({
  loader: () => getViewer(),
  component: Home,
});

function Home() {
  const viewer = Route.useLoaderData();

  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
          <span className="text-sm font-semibold tracking-tight">Agentic Chat</span>
          {viewer && (
            <div className="flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">
                <span className="text-foreground">{viewer.username}</span> · {viewer.tenant}
              </span>
              <form method="post" action="/auth/logout">
                <Button type="submit" variant="outline" size="sm">
                  Sign out
                </Button>
              </form>
            </div>
          )}
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4">
        {viewer ? (
          <p className="text-muted-foreground">
            Signed in to <span className="font-medium text-foreground">{viewer.tenant}</span> as{" "}
            <span className="font-medium text-foreground">{viewer.username}</span>.
          </p>
        ) : (
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="text-muted-foreground">Sign in with your organisation's account.</p>
            <div className="flex gap-2">
              {TENANTS.map((tenant) => (
                <Button
                  key={tenant}
                  variant="outline"
                  nativeButton={false}
                  render={<a href={`/auth/login?tenant=${tenant}`} />}
                >
                  <span className="capitalize">{tenant}</span>
                </Button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
