import { createFileRoute, Link } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: LandingPage,
});

const APP_NAME = import.meta.env.VITE_APP_NAME ?? "agentic-chat";

function LandingPage() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="border-b">
        <div className="container mx-auto flex h-16 items-center px-4">
          <Link to="/" className="text-lg font-semibold">
            {APP_NAME}
          </Link>
        </div>
      </header>

      <section className="flex flex-1 items-center justify-center px-4 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-5xl font-bold tracking-tight text-balance sm:text-6xl">{APP_NAME}</h1>
          <p className="mt-6 text-lg leading-8 text-muted-foreground">
            A workshop for building a permissioned assistant and agent platform for Kestrel Pay, one layer at a time.
          </p>
        </div>
      </section>
    </div>
  );
}
