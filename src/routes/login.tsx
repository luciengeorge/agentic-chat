import { useForm } from "@tanstack/react-form";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { getOptionalViewer } from "@/lib/auth.functions";

const LoginSchema = z.object({
  email: z.email({ error: "Enter your email address" }),
  password: z.string().min(1, { error: "Enter your password" }),
});

export const Route = createFileRoute("/login")({
  beforeLoad: async () => {
    if (await getOptionalViewer()) throw redirect({ to: "/chat" });
  },
  component: LoginPage,
});

function LoginPage() {
  const router = useRouter();

  const form = useForm({
    defaultValues: { email: "", password: "" },
    validators: {
      onSubmit: LoginSchema,
      onSubmitAsync: async ({ value }) => {
        const result = await authClient.signIn.email(value);
        if (result.error) return { form: result.error.message ?? "Sign in failed" };
        await router.navigate({ to: "/chat" });
        return undefined;
      },
    },
  });

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Use a seeded account from fixtures/world.yaml.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
          >
            <FieldGroup>
              <form.Field name="email">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Email</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      type="email"
                      autoComplete="username"
                      placeholder="leo.martin@kestrelpay.example"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                    {field.state.meta.isValid ? null : <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )}
              </form.Field>
              <form.Field name="password">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>Password</FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      type="password"
                      autoComplete="current-password"
                      value={field.state.value}
                      onChange={(e) => field.handleChange(e.target.value)}
                      onBlur={field.handleBlur}
                    />
                    {field.state.meta.isValid ? null : <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )}
              </form.Field>
              <form.Subscribe
                selector={(state) => ({ isSubmitting: state.isSubmitting, formError: state.errorMap.onSubmit?.form })}
              >
                {({ isSubmitting, formError }) => (
                  <Field>
                    <Button type="submit" disabled={isSubmitting}>
                      {isSubmitting ? <Spinner /> : null}
                      Sign in
                    </Button>
                    {formError ? <FieldError>{String(formError)}</FieldError> : null}
                  </Field>
                )}
              </form.Subscribe>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
