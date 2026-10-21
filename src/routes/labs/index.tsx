import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, Link, redirect, type LinkProps } from "@tanstack/react-router";

import { ChatSidebar } from "@/components/chat/sidebar";
import { Badge } from "@/components/ui/badge";
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

interface Lab {
  section: string;
  title: string;
  description: string;
  /** The app's own page, or an outside one (`href`) such as Workflow's run viewer. */
  to?: LinkProps["to"];
  href?: string;
  /** Refuses to run anywhere but dev (test and prod alike): it shows other people's access, or drives dev-only services. */
  devOnly?: boolean;
}

const LABS: Lab[] = [
  {
    section: "00",
    href: "/_workflow",
    title: "Tour: the run viewer",
    description: "Workflow's own dashboard: every run, its steps, their inputs and outputs, and where one failed.",
    devOnly: true,
  },
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
    devOnly: true,
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
    devOnly: true,
  },
  {
    section: "07",
    to: "/labs/lexical",
    title: "Lexical and hybrid",
    description: "One question ranked by BM25, by vectors and fused with RRF, side by side, as you would see it.",
    devOnly: true,
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
    devOnly: true,
  },
  {
    section: "10",
    to: "/labs/prompt",
    title: "Prompt inspector",
    description:
      "Replay a recorded turn: the assembled prompt, the sources the budget kept and skipped, the reply, the verdict.",
  },
  {
    section: "11",
    to: "/labs/boundary",
    title: "Request log",
    description: "The last requests through the middleware: route, viewer, tenant, status, and rate-limit tokens left.",
    devOnly: true,
  },
  {
    section: "12",
    to: "/chat",
    title: "Frontend: the app itself",
    description:
      "The chat, its citation chips and the agent's timeline, on your code. Each step's README says what to click.",
  },
  {
    section: "13",
    to: "/labs/loop",
    title: "Agents: the run stepper",
    description:
      "A recorded agent run, one decision at a time, on your loop: each model turn, each call and result, the caps.",
  },
  {
    section: "14",
    to: "/labs/state",
    title: "Agents: state",
    description:
      "A run's event log, live: seq, version, type and data. Send two messages at once and watch both land, once.",
  },
  {
    section: "15",
    to: "/labs/durability",
    title: "Agents: kill the server",
    description: "A real run's send held mid-flight: stop pnpm dev, start it again, and watch it resume and mail once.",
    devOnly: true,
  },
  {
    section: "16",
    to: "/labs/orchestration",
    title: "Agents: the run tree",
    description:
      "A parent run and its sub-agents: each child's caps and spend, and what the parent has left, on your code.",
  },
  {
    section: "17",
    to: "/labs/safety",
    title: "Safety: the red-team runner",
    description:
      "Fifteen attacks on the agent's writes, on a model that obeys them, through your plan, policy and guardrails.",
    devOnly: true,
  },
  {
    section: "18",
    to: "/labs/evals",
    title: "Evals: the dashboard",
    description:
      "Every golden-set run rescored by your metrics, the judge and claims against hand labels, the agent tasks.",
  },
  {
    section: "19",
    to: "/labs/observability",
    title: "Observability",
    description:
      "The recorded chat turns priced by your code, and a link to Grafana while the observability stack runs.",
  },
  {
    section: "20",
    to: "/labs/drills",
    title: "Debugging drills",
    description: "The planted drill's report, where each drill stands, and the tools a good debugger reaches for.",
    devOnly: true,
  },
  {
    section: "21",
    to: "/labs/airgap",
    title: "Air-gapped: the egress monitor",
    description:
      "Where each model runs, and a monitor in the dev server that lists every connection it lets out or refuses.",
    devOnly: true,
  },
];

const rowClass = "flex items-center gap-4 rounded-xl border px-4 py-3 transition-colors hover:bg-muted";

function LabRow({ lab }: { lab: Lab }) {
  const body = (
    <>
      <span className="font-mono text-sm text-muted-foreground tabular-nums">{lab.section}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium">
          {lab.title}
          {lab.devOnly ? <Badge variant="outline">dev only</Badge> : null}
        </span>
        <span className="text-sm text-muted-foreground">{lab.description}</span>
      </span>
      <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} className="size-4 text-muted-foreground" />
    </>
  );
  return lab.href ? (
    <a href={lab.href} className={rowClass}>
      {body}
    </a>
  ) : (
    <Link to={lab.to} className={rowClass}>
      {body}
    </Link>
  );
}

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
              One page per section of the course. Each runs the app's own code, yours while a step of its section is
              active. Pages marked dev only refuse to run outside dev, in test as in production.
            </p>
          </div>
          <ul className="flex flex-col gap-2">
            {LABS.map((lab) => (
              <li key={lab.to ?? lab.href}>
                <LabRow lab={lab} />
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}
