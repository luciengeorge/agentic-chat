import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GlobalLoading } from "./global-loading";

let busy = false;
vi.mock("@tanstack/react-router", () => ({ useRouterState: () => busy }));
vi.mock("spin-delay", () => ({ useSpinDelay: (value: boolean) => value }));

const bar = () => screen.getByRole("progressbar", { hidden: true });

describe("GlobalLoading", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    busy = false;
  });

  it("starts while the router loads, trickles, completes, then fades out", () => {
    const { rerender } = render(<GlobalLoading />);
    expect(bar()).toHaveAttribute("aria-hidden", "true");

    busy = true;
    rerender(<GlobalLoading />);
    expect(bar()).toHaveAttribute("aria-valuenow", "8");
    act(() => vi.advanceTimersByTime(3_000));
    const trickled = Number(bar().getAttribute("aria-valuenow"));
    expect(trickled).toBeGreaterThan(8);
    expect(trickled).toBeLessThanOrEqual(90);

    busy = false;
    rerender(<GlobalLoading />);
    expect(bar()).toHaveAttribute("aria-valuenow", "100");
    act(() => vi.advanceTimersByTime(400));
    expect(bar()).toHaveAttribute("aria-hidden", "true");
    expect(bar()).not.toHaveAttribute("aria-valuenow");
  });

  it("a load that starts during the fade restarts the bar and keeps it shown", () => {
    busy = true;
    const { rerender } = render(<GlobalLoading />);
    busy = false;
    rerender(<GlobalLoading />);
    act(() => vi.advanceTimersByTime(200));
    busy = true;
    rerender(<GlobalLoading />);
    act(() => vi.advanceTimersByTime(400));
    expect(bar()).not.toHaveAttribute("aria-hidden");
    expect(Number(bar().getAttribute("aria-valuenow"))).toBeLessThan(100);
  });
});
