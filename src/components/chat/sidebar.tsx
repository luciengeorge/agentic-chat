import {
  InboxIcon,
  Logout01Icon,
  PlusSignIcon,
  TestTube01Icon,
  WorkflowSquare03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";

import { pendingApprovals } from "@/components/agent/api";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";
import { cn } from "@/lib/utils";
import { getConversations } from "@/routes/chat/-functions";

export function ChatSidebar({
  activeId,
  viewer,
}: {
  activeId: string | undefined;
  viewer: { name: string; email: string; tenant: { slug: string } };
}) {
  const router = useRouter();
  const conversations = useQuery({ queryKey: ["conversations"], queryFn: () => getConversations() });
  const approvals = useQuery({
    queryKey: ["approvals", "pending"],
    queryFn: pendingApprovals,
    refetchInterval: 30_000,
  });
  const waiting = approvals.data?.length ?? 0;

  const signOut = async () => {
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  };

  return (
    <aside className="hidden w-64 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        <span className="truncate px-1 text-sm font-semibold tracking-tight">Kestrel Assistant</span>
        <Link
          to="/chat"
          className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
          aria-label="New chat"
          title="New chat"
        >
          <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
        </Link>
      </div>

      <div className="px-2 pb-1">
        <Link
          to="/inbox"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent"
          activeProps={{ className: "bg-sidebar-accent font-medium text-sidebar-accent-foreground" }}
        >
          <HugeiconsIcon icon={InboxIcon} strokeWidth={2} className="size-4 text-muted-foreground" />
          <span className="flex-1">Inbox</span>
          {waiting ? (
            <Badge aria-label={`${waiting} waiting for approval`} className="tabular-nums">
              {waiting}
            </Badge>
          ) : null}
        </Link>
        <Link
          to="/automations"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent"
          activeProps={{ className: "bg-sidebar-accent font-medium text-sidebar-accent-foreground" }}
        >
          <HugeiconsIcon icon={WorkflowSquare03Icon} strokeWidth={2} className="size-4 text-muted-foreground" />
          <span className="flex-1">Automations</span>
        </Link>
        <Link
          to="/labs"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent"
          activeProps={{ className: "bg-sidebar-accent font-medium text-sidebar-accent-foreground" }}
        >
          <HugeiconsIcon icon={TestTube01Icon} strokeWidth={2} className="size-4 text-muted-foreground" />
          <span className="flex-1">Labs</span>
        </Link>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Conversations">
        <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">Recent</p>
        {conversations.isPending ? (
          <div className="flex flex-col gap-2 px-2 pt-1">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-3/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : conversations.data?.length ? (
          <ul className="flex flex-col gap-0.5">
            {conversations.data.map((conversation) => (
              <li key={conversation.id}>
                <Link
                  to="/chat/$conversationId"
                  params={{ conversationId: conversation.id }}
                  className={cn(
                    "block truncate rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-sidebar-accent",
                    conversation.id === activeId && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
                  )}
                >
                  {conversation.title || "Untitled"}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-2 py-1 text-sm text-muted-foreground">No conversations yet.</p>
        )}
      </nav>

      <div className="flex items-center gap-2 border-t p-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary uppercase">
          {viewer.name.slice(0, 1)}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{viewer.name}</span>
          <span className="truncate text-xs text-muted-foreground">{viewer.email}</span>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={signOut} aria-label="Sign out" title="Sign out">
          <HugeiconsIcon icon={Logout01Icon} strokeWidth={2} />
        </Button>
      </div>
    </aside>
  );
}
