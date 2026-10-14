import { useForm } from "@tanstack/react-form";
import { z } from "zod";

import { TriggerSchema } from "#learn/automations/automation";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const FormSchema = z
  .object({
    name: z.string().trim().min(1, { error: "Give it a name" }).max(100),
    prompt: z.string().trim().min(1, { error: "Say what the agent should do" }).max(4000),
    kind: z.enum(["schedule", "drive_change"]),
    cron: z.string(),
    folder: z.string(),
  })
  .superRefine((value, ctx) => {
    const trigger = TriggerSchema.safeParse(triggerOf(value));
    if (trigger.success) return;
    for (const issue of trigger.error.issues) {
      const field = issue.path.at(-1) === "cron" ? "cron" : "folder";
      ctx.addIssue({ code: "custom", path: [field], message: issue.message });
    }
  });

type FormValues = z.infer<typeof FormSchema>;

function triggerOf(value: FormValues) {
  return value.kind === "schedule"
    ? { kind: "schedule" as const, cron: value.cron, folder: value.folder.trim() || null }
    : { kind: "drive_change" as const, folder: value.folder };
}

export interface NewAutomationBody {
  name: string;
  prompt: string;
  trigger: ReturnType<typeof triggerOf>;
}

const TRIGGERS = [
  { kind: "schedule", label: "On a schedule" },
  { kind: "drive_change", label: "When a document changes" },
] as const;

/** Creates an automation: what the agent does, and when. */
export function AutomationForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (body: NewAutomationBody) => Promise<void>;
}) {
  const form = useForm({
    defaultValues: { name: "", prompt: "", kind: "schedule", cron: "0 8 * * 1-5", folder: "" } as FormValues,
    validators: { onSubmit: FormSchema },
    onSubmit: async ({ value, formApi }) => {
      await onCreate({ name: value.name.trim(), prompt: value.prompt.trim(), trigger: triggerOf(value) });
      formApi.reset();
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
      className="rounded-xl border bg-card p-4"
    >
      <FieldGroup>
        <form.Field name="name">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>Name</FieldLabel>
              <Input
                id={field.name}
                value={field.state.value}
                placeholder="Policy digest"
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                aria-invalid={!field.state.meta.isValid}
              />
              {field.state.meta.isValid ? null : <FieldError errors={field.state.meta.errors} />}
            </Field>
          )}
        </form.Field>

        <form.Field name="prompt">
          {(field) => (
            <Field>
              <FieldLabel htmlFor={field.name}>What the agent should do</FieldLabel>
              <Textarea
                id={field.name}
                rows={3}
                value={field.state.value}
                placeholder="Summarise the document in three bullet points for the HR team."
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                aria-invalid={!field.state.meta.isValid}
              />
              <FieldDescription>
                It runs as you, so any email or share it wants to make waits in your inbox for approval.
              </FieldDescription>
              {field.state.meta.isValid ? null : <FieldError errors={field.state.meta.errors} />}
            </Field>
          )}
        </form.Field>

        <form.Field name="kind">
          {(field) => (
            <Field>
              <FieldLabel>When it runs</FieldLabel>
              <div className="flex flex-wrap gap-2" role="group" aria-label="When it runs">
                {TRIGGERS.map((trigger) => (
                  <Button
                    key={trigger.kind}
                    type="button"
                    size="sm"
                    variant={field.state.value === trigger.kind ? "secondary" : "outline"}
                    aria-pressed={field.state.value === trigger.kind}
                    onClick={() => field.handleChange(trigger.kind)}
                  >
                    {trigger.label}
                  </Button>
                ))}
              </div>
            </Field>
          )}
        </form.Field>

        <form.Subscribe selector={(state) => state.values.kind}>
          {(kind) =>
            kind === "schedule" ? (
              <form.Field name="cron">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Schedule</FieldLabel>
                    <Input
                      id={field.name}
                      value={field.state.value}
                      className="font-mono"
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                      aria-invalid={!field.state.meta.isValid}
                    />
                    <FieldDescription>
                      Cron, in UTC: minute, hour, day, month, weekday. “0 8 * * 1-5” is 08:00 on weekdays.
                    </FieldDescription>
                    {field.state.meta.isValid ? null : <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )}
              </form.Field>
            ) : null
          }
        </form.Subscribe>

        <form.Subscribe selector={(state) => state.values.kind}>
          {(kind) => (
            <form.Field name="folder">
              {(field) => (
                <Field>
                  <FieldLabel htmlFor={field.name}>{kind === "schedule" ? "Folder (optional)" : "Folder"}</FieldLabel>
                  <Input
                    id={field.name}
                    value={field.state.value}
                    placeholder="/HR/Policies"
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    aria-invalid={!field.state.meta.isValid}
                  />
                  <FieldDescription>
                    {kind === "schedule"
                      ? "With a folder, each run covers the documents in it that changed since the last one, one run per document."
                      : "It runs once for each document in this folder that's added or changed."}
                  </FieldDescription>
                  {field.state.meta.isValid ? null : <FieldError errors={field.state.meta.errors} />}
                </Field>
              )}
            </form.Field>
          )}
        </form.Subscribe>

        <div className="flex justify-end">
          <Button type="submit" disabled={busy}>
            Create automation
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
