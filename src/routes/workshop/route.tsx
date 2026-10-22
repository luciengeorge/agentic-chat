import { ArrowLeft01Icon, Menu01Icon, Mortarboard01Icon, TestTube01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, redirect, useParams } from "@tanstack/react-router";

import { buttonVariants } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { getWorkshopGate } from "@/components/workshop/access";
import { StepList } from "@/components/workshop/step-list";

import { courseQuery } from "./-queries";

export const Route = createFileRoute("/workshop")({
  beforeLoad: async () => {
    const gate = await getWorkshopGate();
    if (gate.state === "signed-out") throw redirect({ to: "/login" });
    return { gate };
  },
  loader: async ({ context }) => {
    if (context.gate.state === "ok") await context.queryClient.ensureQueryData(courseQuery);
  },
  head: () => ({ meta: [{ title: "Workshop · Kestrel Assistant" }] }),
  component: WorkshopLayout,
});

function WorkshopLayout() {
  const { gate } = Route.useRouteContext();
  if (gate.state === "db-down") {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-3 px-6">
        <h1 className="text-xl font-semibold tracking-tight">The database isn't running</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          The workshop needs Postgres to know who you are. Start OrbStack (or Docker), then run <code>pnpm ex up</code>{" "}
          and reload this page.
        </p>
      </main>
    );
  }
  if (gate.state !== "ok") {
    return (
      <main className="mx-auto flex min-h-svh max-w-md flex-col justify-center gap-3 px-6">
        <h1 className="text-xl font-semibold tracking-tight">The workshop runs only in dev</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          It runs <code>pnpm ex</code> on the machine that serves it, which starts steps and swaps files, so it refuses
          to run anywhere but <code>pnpm dev</code>. This server runs as {gate.state === "not-dev" ? gate.env : "?"}.
        </p>
      </main>
    );
  }
  return <Workshop />;
}

function Progress() {
  const { data: course } = useSuspenseQuery(courseQuery);
  const share = course.total ? Math.round((course.passed / course.total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1.5 px-4 pb-3">
      <div className="flex items-baseline justify-between text-xs text-muted-foreground">
        <span>
          <span className="font-medium text-foreground tabular-nums">{course.passed}</span> of{" "}
          <span className="tabular-nums">{course.total}</span> graded steps passed
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={course.passed}
        aria-valuemin={0}
        aria-valuemax={course.total}
        aria-label="Graded steps passed"
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

function Nav() {
  const { data: course } = useSuspenseQuery(courseQuery);
  const params = useParams({ strict: false });
  return <StepList sections={course.sections} current={params.stepId} currentSection={params.sectionId} />;
}

function Brand() {
  return (
    <Link to="/workshop" className="flex items-center gap-2 text-sm font-semibold tracking-tight">
      <HugeiconsIcon icon={Mortarboard01Icon} strokeWidth={2} className="size-4 text-primary" />
      Kestrel workshop
    </Link>
  );
}

function RailFooter() {
  const link =
    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground";
  return (
    <div className="flex flex-col gap-0.5 border-t p-2">
      <Link to="/labs" className={link}>
        <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} className="size-4" />
        Labs
      </Link>
      <Link to="/chat" className={link}>
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} className="size-4" />
        Back to the app
      </Link>
    </div>
  );
}

function Workshop() {
  return (
    <div className="flex min-h-svh w-full">
      <aside className="sticky top-0 hidden h-svh w-72 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
        <div className="flex h-14 items-center px-4">
          <Brand />
        </div>
        <Progress />
        <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <Nav />
        </div>
        <RailFooter />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-12 items-center justify-between border-b bg-background/95 px-4 backdrop-blur md:hidden">
          <Brand />
          <Sheet>
            <SheetTrigger className={buttonVariants({ variant: "ghost", size: "icon-sm" })} aria-label="Steps">
              <HugeiconsIcon icon={Menu01Icon} strokeWidth={2} />
            </SheetTrigger>
            <SheetContent side="left" className="gap-0 bg-sidebar p-0">
              <SheetHeader>
                <SheetTitle>Steps</SheetTitle>
              </SheetHeader>
              <Progress />
              <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
                <Nav />
              </div>
              <RailFooter />
            </SheetContent>
          </Sheet>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
