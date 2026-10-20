import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";

import { Readme } from "@/components/workshop/readme";

import { courseQuery, frontDoorQuery } from "./-queries";

export const Route = createFileRoute("/workshop/")({
  loader: async ({ context }) => {
    if (context.gate.state === "ok") await context.queryClient.ensureQueryData(frontDoorQuery);
  },
  component: FrontDoor,
});

/** Where the learner is: the active step, or the first step not yet passed. */
function Continue() {
  const { data: course } = useSuspenseQuery(courseQuery);
  const steps = course.sections.flatMap((section) => section.steps);
  const active = steps.find((step) => step.status === "active");
  const next = active ?? steps.find((step) => !step.passed && step.type === "graded");
  if (!next) return null;
  return (
    <Link
      to="/workshop/$stepId"
      params={{ stepId: next.id }}
      search={{}}
      className="group flex items-center gap-4 rounded-xl border bg-card px-5 py-4 transition-colors hover:bg-muted/50"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs font-medium text-primary">{active ? "Your active step" : "Up next"}</span>
        <span className="truncate font-medium">
          <span className="text-muted-foreground tabular-nums">{next.id}</span> {next.title}
        </span>
      </div>
      <HugeiconsIcon
        icon={ArrowRight01Icon}
        strokeWidth={2}
        className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5"
      />
    </Link>
  );
}

function FrontDoor() {
  const { data: text } = useSuspenseQuery(frontDoorQuery);
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-10 md:py-14">
      <Continue />
      <Readme text={text} />
    </main>
  );
}
