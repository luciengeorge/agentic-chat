import type { ErrorComponentProps } from "@tanstack/react-router";

import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { type DatabaseStatus, getDatabaseStatus } from "@/lib/database-status";

/**
 * What any unexpected error shows. `status` is undefined while the database check runs, and when it fails too.
 * The error's own message only shows in dev: in prod it can carry a query.
 */
export function AppErrorView({
  error,
  status,
  checking,
  onRetry,
}: {
  error: unknown;
  status: DatabaseStatus | undefined;
  checking: boolean;
  onRetry: () => void;
}) {
  if (checking) {
    return (
      <div className="flex min-h-svh items-center justify-center">
        <Spinner className="text-muted-foreground" />
      </div>
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return (
    <div role="alert" className="mx-auto flex min-h-svh w-full max-w-md flex-col justify-center gap-3 px-6">
      {status?.down ? (
        <>
          <h1 className="text-xl font-semibold tracking-tight">The database isn't running</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {status.dev ? (
              <>
                Start OrbStack (or Docker), then run <code>pnpm ex up</code>, and reload.
              </>
            ) : (
              "Postgres isn't answering. Try again in a minute."
            )}
          </p>
        </>
      ) : (
        <>
          <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {status?.dev && message ? message : "This page hit an error it didn't expect. Try again, or go home."}
          </p>
        </>
      )}
      <div className="flex gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Link to="/" className={buttonVariants({ variant: "outline" })}>
          Home
        </Link>
      </div>
    </div>
  );
}

/** The root route's error page: asks the server whether Postgres answers, since that's the usual reason in dev. */
export function AppError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const { data, isPending } = useQuery({
    queryKey: ["database-status"],
    queryFn: () => getDatabaseStatus(),
    retry: false,
    gcTime: 0,
  });
  return (
    <AppErrorView
      error={error}
      status={data}
      checking={isPending}
      onRetry={() => {
        reset();
        void router.invalidate();
      }}
    />
  );
}
