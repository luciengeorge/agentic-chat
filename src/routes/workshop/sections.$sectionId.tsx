import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { Readme } from "@/components/workshop/readme";
import { StepLink } from "@/components/workshop/swap";

import { sectionQuery } from "./-queries";

export const Route = createFileRoute("/workshop/sections/$sectionId")({
  loader: async ({ context, params }) => {
    if (context.gate.state === "ok") await context.queryClient.ensureQueryData(sectionQuery(params.sectionId));
  },
  head: ({ params }) => ({ meta: [{ title: `Section ${params.sectionId} · Workshop · Kestrel Assistant` }] }),
  component: SectionPage,
  notFoundComponent: () => (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-14">
      <h1 className="text-xl font-semibold tracking-tight">No such section</h1>
    </main>
  ),
});

function SectionPage() {
  const { sectionId } = Route.useParams();
  const { data: page } = useSuspenseQuery(sectionQuery(sectionId));
  const first = page.section.steps[0];
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-10 md:py-14">
      <Readme text={page.readme} />
      {first ? (
        <nav aria-label="Steps" className="flex">
          <StepLink id={first.id} title={first.title} direction="next" />
        </nav>
      ) : null}
      {page.finished ? (
        <details className="group rounded-xl border px-5 py-4">
          <summary className="cursor-pointer text-sm font-medium select-none">When you've finished the section</summary>
          <Readme text={page.finished} className="mt-4" />
        </details>
      ) : null}
    </main>
  );
}
