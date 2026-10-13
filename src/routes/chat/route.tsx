import { PlusSignIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { createFileRoute, Link, Outlet, redirect, useParams } from "@tanstack/react-router";

import { ChatSidebar } from "@/components/chat/sidebar";
import { buttonVariants } from "@/components/ui/button";
import { getOptionalViewer } from "@/lib/auth.functions";

export const Route = createFileRoute("/chat")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  head: () => ({ meta: [{ title: "Chat · Kestrel Assistant" }] }),
  component: ChatLayout,
});

function ChatLayout() {
  const { viewer } = Route.useRouteContext();
  const params = useParams({ strict: false });
  return (
    <div className="flex h-svh w-full overflow-hidden">
      <ChatSidebar activeId={params.conversationId} viewer={viewer} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center justify-between border-b px-4 md:hidden">
          <span className="text-sm font-semibold tracking-tight">Kestrel Assistant</span>
          <Link to="/chat" className={buttonVariants({ variant: "ghost", size: "icon-sm" })} aria-label="New chat">
            <HugeiconsIcon icon={PlusSignIcon} strokeWidth={2} />
          </Link>
        </header>
        <Outlet />
      </div>
    </div>
  );
}
