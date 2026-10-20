import { ArrowRight01Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { cn } from "@/lib/utils";

import type { SectionRow, StepRow } from "./workshop-server";

function StatusMark({ step }: { step: StepRow }) {
  if (step.status === "active") {
    return (
      <span className="flex size-4 items-center justify-center" aria-hidden>
        <span className="size-2 rounded-full bg-primary ring-4 ring-primary/20" />
      </span>
    );
  }
  if (step.passed) {
    return <HugeiconsIcon icon={CheckmarkCircle02Icon} strokeWidth={2} className="size-4 text-primary" aria-hidden />;
  }
  return (
    <span className="flex size-4 items-center justify-center" aria-hidden>
      <span className="size-2 rounded-full border border-muted-foreground/50" />
    </span>
  );
}

function statusText(step: StepRow): string {
  if (step.status === "active") return step.passed ? "active, passed" : "active";
  return step.passed ? "passed" : "not started";
}

/**
 * The course as a docs site's side nav: each section folds open to its steps, with each step's progress. A section
 * starts open when it holds the step on screen or the active step.
 */
export function StepList({
  sections,
  current,
  currentSection,
}: {
  sections: SectionRow[];
  /** The step on screen, if any. */
  current?: string;
  /** The section on screen, if any. */
  currentSection?: string;
}) {
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const holds = (section: SectionRow, id: string | undefined) => section.steps.some((step) => step.id === id);

  return (
    <nav aria-label="Course" className="flex flex-col gap-1">
      {sections.map((section) => {
        const graded = section.steps.filter((step) => step.type === "graded");
        const passed = graded.filter((step) => step.passed).length;
        const hasActive = section.steps.some((step) => step.status === "active");
        const open = toggled[section.id] ?? (hasActive || holds(section, current) || currentSection === section.id);
        const listId = `workshop-section-${section.id}`;
        return (
          <div key={section.id} className="flex flex-col">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setToggled((all) => ({ ...all, [section.id]: !open }))}
              className="group flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent"
            >
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                strokeWidth={2}
                className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
              />
              <span className="w-5 shrink-0 text-xs text-muted-foreground tabular-nums">{section.id}</span>
              <span className={cn("flex-1 truncate", hasActive && "font-medium")}>{section.title}</span>
              {graded.length ? (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    passed === graded.length ? "text-primary" : "text-muted-foreground",
                  )}
                  aria-label={`${passed} of ${graded.length} graded steps passed`}
                >
                  {passed}/{graded.length}
                </span>
              ) : null}
            </button>
            {open ? (
              <ul id={listId} className="mt-0.5 mb-2 ml-[1.0625rem] flex flex-col gap-px border-l pl-2">
                <li>
                  <Link
                    to="/workshop/sections/$sectionId"
                    params={{ sectionId: section.id }}
                    className="block rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                    activeProps={{ className: "bg-sidebar-accent font-medium text-sidebar-accent-foreground" }}
                  >
                    Introduction
                  </Link>
                </li>
                {section.steps.map((step) => (
                  <li key={step.id}>
                    <Link
                      to="/workshop/$stepId"
                      params={{ stepId: step.id }}
                      search={{}}
                      className="flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-colors hover:bg-sidebar-accent"
                      activeProps={{ className: "bg-sidebar-accent font-medium text-sidebar-accent-foreground" }}
                      data-status={step.status}
                    >
                      <StatusMark step={step} />
                      <span className="w-8 shrink-0 text-xs text-muted-foreground tabular-nums">{step.id}</span>{" "}
                      <span className="flex-1 truncate">{step.title}</span>{" "}
                      {step.type !== "graded" ? (
                        <span className="text-[0.6875rem] text-muted-foreground">{step.type}</span>
                      ) : null}
                      <span className="sr-only">({statusText(step)})</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        );
      })}
    </nav>
  );
}
