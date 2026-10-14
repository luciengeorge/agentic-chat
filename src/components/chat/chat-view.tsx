import { useChat } from "@ai-sdk/react";
import { useQueryClient } from "@tanstack/react-query";
import { DefaultChatTransport } from "ai";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { routeMessage } from "@/components/agent/api";
import { RunView } from "@/components/agent/run-view";
import { TooltipProvider } from "@/components/ui/tooltip";

import type { OpenSource } from "./citations";
import type { ChatUIMessage, StoredUIMessage } from "./types";

import { Composer } from "./composer";
import { AssistantMessage, UserMessage } from "./messages";
import { SourceSheet } from "./source-sheet";

const SUGGESTIONS = [
  "What's the daily meal allowance on a work trip?",
  "When do I need a receipt for an expense?",
  "What does payments error KP-4031 mean?",
];

/** The server answers errors as JSON; turn the ones a person can act on into a sentence. */
function describe(error: Error): string {
  try {
    const body = JSON.parse(error.message) as { error?: string; retryAfterSeconds?: number };
    if (body.error === "rate_limited") {
      return `You're asking faster than the limit allows. Try again in ${body.retryAfterSeconds ?? "a few"} seconds.`;
    }
    if (body.error === "unauthorized") return "Your session has ended. Sign in again.";
    if (body.error === "not_in_directory") return "Your account isn't in the company directory yet.";
    if (body.error === "disabled") return "Your account is disabled in the company directory.";
    if (body.error === "not_found") return "This conversation isn't yours, or it no longer exists.";
  } catch {
    // not JSON: a stream error, whose message is already for people
  }
  return error.message || "Something went wrong. Try again.";
}

/** An agent run in the conversation, after this many chat messages. */
export interface RunPlacement {
  id: string;
  afterMessages: number;
}

const runsAfter = (runs: readonly RunPlacement[], count: number) =>
  runs
    .filter((run) => run.afterMessages === count)
    .map((run) => (
      <li key={run.id}>
        <RunView runId={run.id} />
      </li>
    ));

export function ChatView({
  id,
  initialMessages,
  initialRuns = [],
}: {
  id: string;
  initialMessages: StoredUIMessage[];
  initialRuns?: RunPlacement[];
}) {
  const queryClient = useQueryClient();
  const [source, setSource] = useState<OpenSource | null>(null);
  const [agent, setAgent] = useState(false);
  const [runs, setRuns] = useState(initialRuns);
  const [starting, setStarting] = useState(false);
  const [transport] = useState(
    () =>
      new DefaultChatTransport<ChatUIMessage>({
        api: "/api/chat",
        // The server keeps the history: send the conversation id and the new message only.
        prepareSendMessagesRequest: ({ id, messages }) => ({ body: { id, message: messages.at(-1) } }),
      }),
  );

  const { messages, sendMessage, status, stop } = useChat<ChatUIMessage>({
    id,
    messages: initialMessages as ChatUIMessage[],
    transport,
    onError: (error) => toast.error(describe(error)),
    onFinish: () => void queryClient.invalidateQueries({ queryKey: ["conversations"] }),
  });

  const busy = status === "submitted" || status === "streaming";
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Follow the answer as it streams, unless the reader scrolled up to look at something.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /**
   * The router (section 16.2) says where the message goes: a cited answer streams back through `useChat`; an agent
   * run shows inline; a follow-up joins the conversation's live run, whose timeline shows it.
   */
  const send = async (question: string) => {
    stick.current = true;
    setStarting(true);
    try {
      const routed = await routeMessage({
        conversationId: id,
        runId: crypto.randomUUID(),
        message: { id: crypto.randomUUID(), text: question },
        agent,
      });
      if (routed.route === "answer") {
        void sendMessage({ text: question });
        return;
      }
      if (!routed.followUp) {
        setRuns((current) =>
          current.some((run) => run.id === routed.id)
            ? current
            : [...current, { id: routed.id, afterMessages: messages.length }],
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["conversations"] });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "That didn't go through. Try again.");
    } finally {
      setStarting(false);
    }
  };

  const last = messages.at(-1);
  const waiting = status === "submitted" && last?.role === "user";

  return (
    <TooltipProvider delay={150}>
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {messages.length === 0 && runs.length === 0 ? (
            <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center gap-6 px-4 pb-16 text-center">
              <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-balance">What do you need to know?</h1>
                <p className="text-sm text-pretty text-muted-foreground">
                  Answers come only from documents you're allowed to read, and every claim links to its source.
                </p>
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void send(suggestion)}
                    className="rounded-full border bg-card px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8" aria-live="polite">
              {runsAfter(runs, 0)}
              {messages.map((message, i) => (
                <Fragment key={message.id}>
                  <li>
                    {message.role === "user" ? (
                      <UserMessage message={message} />
                    ) : (
                      <AssistantMessage
                        message={message}
                        streaming={busy && i === messages.length - 1}
                        onOpenSource={setSource}
                      />
                    )}
                  </li>
                  {runsAfter(runs, i + 1)}
                </Fragment>
              ))}
              {waiting ? (
                <li>
                  <AssistantMessage
                    message={{ id: "pending", role: "assistant", parts: [] }}
                    streaming
                    onOpenSource={setSource}
                  />
                </li>
              ) : null}
            </ol>
          )}
        </div>

        <div className="mx-auto w-full max-w-3xl px-4 pb-4">
          <Composer
            busy={busy || starting}
            onSend={(question) => void send(question)}
            onStop={() => void stop()}
            autoFocus
            agent={agent}
            onAgentChange={setAgent}
          />
          <p className="mt-2 text-center text-xs text-muted-foreground">
            Answers can be wrong. Open the sources to check them.
          </p>
        </div>
      </div>

      <SourceSheet source={source} onClose={() => setSource(null)} />
    </TooltipProvider>
  );
}
