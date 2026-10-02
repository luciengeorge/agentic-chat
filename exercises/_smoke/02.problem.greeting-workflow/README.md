---
title: Greeting in a workflow
type: graded
slots:
  _sample/greeting: greeting.ts
---

# Greeting in a workflow

This step proves that slots reach code that runs inside a workflow.

A **workflow** is a function whose progress is saved after each **step**, so a crash resumes where it stopped. Workflow builds step code with its own bundler, outside the dev server, so the slot needs wiring there too. `src/workflows/greeting.ts` runs `formatGreeting` inside a step, and while this step is active that call loads your copy in `playground/greeting.ts`.

Make `formatGreeting("smoke")` return `"hello smoke"`, then run `pnpm ex test _smoke.2`.
