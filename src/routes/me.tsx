import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth-client";
import { getOptionalViewer } from "@/lib/auth.functions";

export const Route = createFileRoute("/me")({
  beforeLoad: async () => {
    const viewer = await getOptionalViewer();
    if (!viewer) throw redirect({ to: "/login" });
    return { viewer };
  },
  component: MePage,
});

function MePage() {
  const { viewer } = Route.useRouteContext();
  const router = useRouter();
  const [signingOut, setSigningOut] = useState(false);

  const signOut = async () => {
    setSigningOut(true);
    await authClient.signOut();
    await router.navigate({ to: "/login" });
  };

  return (
    <div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{viewer.name}</CardTitle>
          <CardDescription>{viewer.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Username</dt>
            <dd>{viewer.username}</dd>
            <dt className="text-muted-foreground">Tenant</dt>
            <dd>{viewer.tenant.slug}</dd>
          </dl>
        </CardContent>
        <CardFooter>
          <Button variant="outline" onClick={signOut} disabled={signingOut}>
            {signingOut ? <Spinner /> : null}
            Sign out
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
