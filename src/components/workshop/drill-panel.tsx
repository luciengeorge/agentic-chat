import { CancelCircleIcon, CheckmarkCircle02Icon, PlayIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

import type { Checked, DrillCheck, DrillView } from "./workshop-server";

import { ConfirmDialog } from "./swap";

function Line({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm">
      <HugeiconsIcon
        icon={ok ? CheckmarkCircle02Icon : CancelCircleIcon}
        strokeWidth={2}
        className={ok ? "mt-0.5 size-4 shrink-0 text-primary" : "mt-0.5 size-4 shrink-0 text-destructive"}
        aria-label={ok ? "passed" : "failed"}
      />
      <span>{children}</span>
    </p>
  );
}

/** What `ex drill check` found, in plain text: the symptom's probes, then the fault's test. */
export function CheckResult({ checked }: { checked: Checked }) {
  const { test } = checked;
  const passing = test.tests.filter((t) => t.outcome === "passed").length;
  return (
    <div className="flex flex-col gap-2" role="status">
      <p className="font-medium">{checked.passed ? "Fixed." : "Not fixed yet."}</p>
      <Line ok={checked.symptom.gone}>
        {checked.symptom.gone ? "The symptom is gone." : "The symptom is still there."}
      </Line>
      {checked.symptom.probes
        .filter((probe) => !probe.ok)
        .map((probe) => (
          <p key={probe.detail} className="pl-6 text-xs text-muted-foreground">
            {probe.detail}
          </p>
        ))}
      <Line ok={test.passed}>
        {test.passed
          ? `The fault's test passes (${passing} of ${test.tests.length}).`
          : `The fault's test fails (${passing} of ${test.tests.length} pass).`}
      </Line>
      {test.error ? <pre className="pl-6 text-xs whitespace-pre-wrap text-muted-foreground">{test.error}</pre> : null}
      {test.tests
        .filter((t) => t.outcome !== "passed")
        .map((t) => (
          <div key={t.name} className="flex flex-col gap-0.5 pl-6 text-xs">
            <span>
              {t.name}
              {t.outcome === "skipped" ? " (skipped: is ParadeDB up?)" : ""}
            </span>
            {t.message ? (
              <pre className="whitespace-pre-wrap text-muted-foreground">
                {t.message.split("\n").slice(0, 4).join("\n")}
              </pre>
            ) : null}
          </div>
        ))}
      {checked.warnings.map((warning) => (
        <p key={warning} className="text-xs text-muted-foreground">
          {warning}
        </p>
      ))}
      {checked.passed ? (
        <p className="text-xs text-muted-foreground">Reset puts the original code back before the next drill.</p>
      ) : null}
    </div>
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * A drill step's tools: plant the fault, check the fix, reset. Plant and reset change the app's code and data and
 * restart the dev server, so each is a confirm away; check only grades.
 */
export function DrillPanel({
  drill,
  busy,
  onPlant,
  onReset,
  check,
}: {
  drill: DrillView;
  busy: boolean;
  onPlant: () => void;
  onReset: () => void;
  check: () => Promise<{ result: DrillCheck | null; busy: string | null }>;
}) {
  const [confirm, setConfirm] = useState<"plant" | "reset" | null>(null);
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<DrillCheck | { error: string; detail: null } | null>(null);

  const runCheck = async () => {
    setChecking(true);
    setOutcome(null);
    try {
      const { result, busy: refused } = await check();
      setOutcome(result ?? { error: refused ?? "The check didn't run.", detail: null });
    } catch (error) {
      setOutcome({ error: error instanceof Error ? error.message : "The check didn't run.", detail: null });
    } finally {
      setChecking(false);
    }
  };

  const reset = (
    <Button variant="outline" size="sm" onClick={() => setConfirm("reset")} disabled={busy || checking}>
      Reset
    </Button>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-mono text-xs">{drill.id}</span>
        {drill.planted ? <Badge>planted</Badge> : null}
        {drill.passed ? (
          <Badge variant="secondary" className="text-primary">
            fixed
          </Badge>
        ) : null}
      </div>

      {drill.needsReset ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-relaxed">
            A plant or a reset stopped partway. Reset puts the code and data back as far as it can.
          </p>
          {reset}
        </div>
      ) : drill.other ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm leading-relaxed">
            The drill <code className="font-mono">{drill.other}</code> is planted. Reset it before planting this one.
          </p>
          {reset}
        </div>
      ) : drill.planted ? (
        <div className="flex flex-col gap-3">
          {drill.symptom ? (
            <div className="flex flex-col gap-1 rounded-lg border bg-muted/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                The report{drill.plantedAt ? `, planted at ${time(drill.plantedAt)}` : ""}
              </span>
              <p className="text-sm leading-relaxed whitespace-pre-line">{drill.symptom.replace(/\n(?!\n)/g, " ")}</p>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={runCheck} disabled={busy || checking}>
              {checking ? <Spinner data-icon="inline-start" /> : null}
              Check my fix
            </Button>
            {reset}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            After a code change, restart <code>pnpm dev</code> before you check, as a deploy would.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Button onClick={() => setConfirm("plant")} disabled={busy}>
            <HugeiconsIcon icon={PlayIcon} strokeWidth={2} data-icon="inline-start" />
            Plant the fault
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Runs <code>pnpm ex drill {drill.id}</code>: changes the running app's code and data, hides the change from
            git, and restarts the dev server. Reset puts everything back.
          </p>
        </div>
      )}

      {outcome ? (
        "checked" in outcome ? (
          <CheckResult checked={outcome.checked} />
        ) : (
          <div role="alert" className="flex flex-col gap-1 text-sm">
            <p className="text-destructive">{outcome.error}</p>
            {outcome.detail ? <p className="text-muted-foreground">{outcome.detail}</p> : null}
          </div>
        )
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={confirm === "plant" ? `Plant the ${drill.id} drill?` : "Reset the drill?"}
        confirm={confirm === "plant" ? "Plant it" : "Reset"}
        onConfirm={() => (confirm === "plant" ? onPlant() : onReset())}
      >
        {confirm === "plant"
          ? "The fault goes into your running app's code and data, hidden from git, and the dev server restarts. When it's back, clear the dev server's terminal: it may have printed a reload line naming the changed file."
          : "The original code and data go back, your fix included, and the dev server restarts."}
      </ConfirmDialog>
    </div>
  );
}
