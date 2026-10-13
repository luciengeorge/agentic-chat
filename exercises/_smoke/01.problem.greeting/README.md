---
title: Greeting
type: graded
slots:
  _sample/greeting: greeting.ts
---

# Greeting

This step proves the course machinery works, on a function small enough to write in one line.

The app imports `formatGreeting` as `#learn/_sample/greeting`. A **slot** is a module the active step swaps for your copy: while this step is active, that import loads `playground/greeting.ts`, and when no step is active it loads the reference in `src/core/_sample/greeting.ts`.

Make `formatGreeting("smoke")` return `"hello smoke"`, then run `pnpm ex test _smoke.1`.
