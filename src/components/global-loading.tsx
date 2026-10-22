import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useSpinDelay } from "spin-delay";

import { cn } from "@/lib/utils";

const START = 8;
const TRICKLE_CAP = 90;
const TRICKLE_MS = 300;
const FADE_MS = 400;

export function GlobalLoading() {
  const busy = useRouterState({
    select: (state) => state.isLoading || state.status === "pending",
  });
  const pending = useSpinDelay(busy, { delay: 200, minDuration: 500 });

  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  // The bar starts and finishes when `pending` changes, set during render rather than in an effect.
  const [wasPending, setWasPending] = useState(false);
  if (pending !== wasPending) {
    setWasPending(pending);
    setProgress(pending ? START : 100);
    if (pending) setVisible(true);
  }

  useEffect(() => {
    if (!pending) return;
    const trickle = window.setInterval(() => {
      setProgress((p) => {
        if (p >= TRICKLE_CAP) return p;
        const step = Math.max(0.6, (TRICKLE_CAP - p) * 0.12);
        return Math.min(TRICKLE_CAP, p + step);
      });
    }, TRICKLE_MS);
    return () => window.clearInterval(trickle);
  }, [pending]);

  useEffect(() => {
    if (pending || !visible) return;
    const hide = window.setTimeout(() => {
      setVisible(false);
      setProgress(0);
    }, FADE_MS);
    return () => window.clearTimeout(hide);
  }, [pending, visible]);

  return (
    <div
      role="progressbar"
      aria-hidden={visible ? undefined : true}
      aria-label="Page loading"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={visible ? Math.round(progress) : undefined}
      className={cn(
        "pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 transition-opacity duration-300 ease-out",
        visible ? "opacity-100" : "opacity-0",
      )}
    >
      <div
        className="h-full bg-primary transition-[width] duration-300 ease-linear"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}
