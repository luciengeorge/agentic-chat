import { AiMagicIcon, ArrowUp02Icon, StopIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useForm } from "@tanstack/react-form";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const MAX_CHARS = 4000;

const ComposerSchema = z.object({
  question: z
    .string()
    .trim()
    .min(1, { error: "Type a question" })
    .max(MAX_CHARS, { error: `Keep it under ${MAX_CHARS.toLocaleString()} characters` }),
});

export function Composer({
  busy,
  onSend,
  onStop,
  autoFocus,
  agent,
  onAgentChange,
}: {
  busy: boolean;
  onSend: (question: string) => void;
  onStop: () => void;
  autoFocus?: boolean;
  /** "Run as agent": the message starts an agent run instead of a plain answer. Until section 16's router. */
  agent?: boolean;
  onAgentChange?: (agent: boolean) => void;
}) {
  const form = useForm({
    defaultValues: { question: "" },
    validators: { onSubmit: ComposerSchema },
    onSubmit: ({ value, formApi }) => {
      onSend(value.question.trim());
      formApi.reset();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) form.handleSubmit();
      }}
    >
      <form.Field name="question">
        {(field) => (
          <Field>
            <FieldLabel htmlFor={field.name} className="sr-only">
              Ask a question
            </FieldLabel>
            <div className="relative flex items-end rounded-2xl border bg-background shadow-sm transition-shadow focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
              <Textarea
                id={field.name}
                name={field.name}
                rows={1}
                autoFocus={autoFocus}
                placeholder={
                  agent ? "Ask the agent to find, email or share…" : "Ask about policies, contracts, error codes…"
                }
                className={cn(
                  "max-h-48 min-h-12 resize-none border-0 bg-transparent py-3 pr-14 pl-4 text-[0.9375rem] shadow-none focus-visible:ring-0 dark:bg-transparent",
                  onAgentChange && "pb-11",
                )}
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    if (!busy) form.handleSubmit();
                  }
                }}
                aria-invalid={!field.state.meta.isValid}
              />
              {onAgentChange ? (
                <div className="absolute bottom-2 left-2">
                  <Button
                    type="button"
                    size="xs"
                    variant={agent ? "secondary" : "ghost"}
                    aria-pressed={agent}
                    onClick={() => onAgentChange(!agent)}
                    title="Let the agent use tools: search, read, look people up, and email or share after you approve"
                  >
                    <HugeiconsIcon icon={AiMagicIcon} strokeWidth={2} data-icon="inline-start" />
                    Run as agent
                  </Button>
                </div>
              ) : null}
              <div className="absolute right-2 bottom-2">
                {busy ? (
                  <Button type="button" size="icon-sm" variant="secondary" onClick={onStop} aria-label="Stop answering">
                    <HugeiconsIcon icon={StopIcon} strokeWidth={2} />
                  </Button>
                ) : (
                  <form.Subscribe selector={(state) => state.values.question.trim().length > 0}>
                    {(ready) => (
                      <Button type="submit" size="icon-sm" disabled={!ready} aria-label="Send">
                        <HugeiconsIcon icon={ArrowUp02Icon} strokeWidth={2} />
                      </Button>
                    )}
                  </form.Subscribe>
                )}
              </div>
            </div>
            {field.state.meta.isValid ? null : <FieldError errors={field.state.meta.errors} />}
          </Field>
        )}
      </form.Field>
    </form>
  );
}
