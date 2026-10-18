import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";

import { ChatSidebar } from "@/components/chat/sidebar";
import { getOptionalViewer } from "@/lib/auth.functions";

export const Route = createFileRoute("/labs/")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Labs · Kestrel Assistant" }] }),
  component: LabsPage,
});

const LABS = [
  {
    section: "01",
    to: "/labs/models",
    title: "Models",
    description: "Replay a recorded model call: the request body, every server-sent event, and the tokens it cost.",
  },
  {
    section: "02",
    to: "/labs/connectors",
    title: "Connectors",
    description: "Throttle fake-workspace, pin its clock, watch its webhooks, and crawl it with your connector.",
  },
  {
    section: "03",
    to: "/labs/parsing",
    title: "Parsing",
    description:
      "See a page as the parser reads it: its blocks, text layer or OCR, the confidence, and the review queue.",
  },
  {
    section: "04",
    to: "/labs/chunking",
    title: "Chunking",
    description: "Pick a page and see where the chunker cuts it, with token counts and the overlap marked.",
  },
  {
    section: "05",
    to: "/labs/background",
    title: "Background work",
    description:
      "A queue board of jobs by class and state, the outbox, and a backfill starving a delta, capped or not.",
  },
  {
    section: "06",
    to: "/labs/vectors",
    title: "Vectors",
    description: "Recall against search time for exact, HNSW, truncated, halfvec and bit vectors, run on your code.",
  },
  {
    section: "07",
    to: "/labs/lexical",
    title: "Lexical and hybrid",
    description: "One question ranked by BM25, by vectors and fused with RRF, side by side, as you would see it.",
  },
  {
    section: "08",
    to: "/labs/rerank",
    title: "Rerank",
    description: "Every candidate the reranker read for one question: where fusion put it, and where it went.",
  },
  {
    section: "09",
    to: "/labs/acls",
    title: "Identity and ACLs",
    description: "Search as anyone, in either tenant: their groups, what came back, what was denied, the audit row.",
  },
] as const;

function LabsPage() {
  const { viewer } = Route.useRouteContext();
  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={undefined} viewer={viewer} />
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">Labs</h1>
            <p className="text-sm text-muted-foreground">
              One page per section of the course. Each runs the app's own code, yours while a step is active.
            </p>
          </div>
          <ul className="flex flex-col gap-2">
            {LABS.map((lab) => (
              <li key={lab.to}>
                <Link
                  to={lab.to}
                  className="flex items-center gap-4 rounded-xl border px-4 py-3 transition-colors hover:bg-muted"
                >
                  <span className="font-mono text-sm text-muted-foreground tabular-nums">{lab.section}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">{lab.title}</span>
                    <span className="text-sm text-muted-foreground">{lab.description}</span>
                  </span>
                  <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4 text-muted-foreground" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
