import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseStatus } from "@/lib/database-status";

import { renderInApp } from "@/core/frontend/testing";

import { AppError } from "./app-error";

let answer: () => Promise<DatabaseStatus> = () => new Promise(() => {});
vi.mock("@/lib/database-status", () => ({ getDatabaseStatus: () => answer() }));
const answers = (status: DatabaseStatus) => (answer = async () => status);

const sessionError = new Error("Failed to get session");

describe("AppError", () => {
  it("says the database isn't running, and how to start it, when Postgres doesn't answer in dev", async () => {
    answers({ down: true, dev: true });
    await renderInApp(() => <AppError error={sessionError} reset={() => {}} />);
    expect(await screen.findByRole("heading", { name: "The database isn't running" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Start OrbStack (or Docker), then run pnpm ex up, and reload.");
    expect(screen.queryByText("Failed to get session")).not.toBeInTheDocument();
  });

  it("leaves out the dev instructions in prod", async () => {
    answers({ down: true, dev: false });
    await renderInApp(() => <AppError error={sessionError} reset={() => {}} />);
    expect(await screen.findByText("Postgres isn't answering. Try again in a minute.")).toBeInTheDocument();
    expect(screen.queryByText(/OrbStack/)).not.toBeInTheDocument();
  });

  it("shows any other error as itself in dev, and a plain line in prod", async () => {
    answers({ down: false, dev: true });
    const first = await renderInApp(() => <AppError error={new Error("loader exploded")} reset={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.getByText("loader exploded")).toBeInTheDocument();
    first.unmount();

    answers({ down: false, dev: false });
    await renderInApp(() => <AppError error={new Error("Failed query: select secret")} reset={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    expect(screen.queryByText(/select secret/)).not.toBeInTheDocument();
  });

  it("waits for the check", async () => {
    answer = () => new Promise(() => {});
    await renderInApp(() => <AppError error={sessionError} reset={() => {}} />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to the plain page when the check fails too, and retries", async () => {
    answer = async () => {
      throw new Error("the server is down too");
    };
    const reset = vi.fn();
    await renderInApp(() => <AppError error={sessionError} reset={reset} />);
    expect(await screen.findByRole("heading", { name: "Something went wrong" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
