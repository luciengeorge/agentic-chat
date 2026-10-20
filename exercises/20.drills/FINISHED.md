---
title: Debugging drills, done
---

# Debugging drills, done

Five faults, and not one threw an error a user would see. Each one was found the same way: reproduce it, say out loud what the symptom rules out, follow the data from the last place it's right to the first place it's wrong, and read the code that writes that first wrong value. (This page sits beside the section's README, so the causes stay in the solution READMEs.)

## What to notice

- **The evidence was already there.** An audit row, a queue board, a log line, two numbers on a bill, a timestamp. Most of the work was asking which part of the system a clue rules out, before opening any code.
- **The fix was rarely the whole job.** Some faults leave data behind that the fixed code doesn't repair on its own, and every code change needed a restart, as a deploy would.
- **Each fault wants a guard,** so it can't come back quietly: a check, an alert or a test that would have caught it the first day. For each drill, name the one you'd add, then compare with its solution README.

`pnpm ex drill list` shows which you've fixed. Run them again in a week without the solution READMEs, talking through each step as you would in the interview.

## What comes next

Section 21 takes the app off the internet: local models, a network with no way out, and everything vendored. The habits from here carry over: when a reranker scores every chunk the same, the column of identical numbers is the clue.
