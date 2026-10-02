---
title: Tour, done
---

# Tour, done

You started the app and its helpers, signed in, followed a question to its answer, and watched a workflow run step by step.

What to notice:

- The browser never held a token. It holds a session cookie, and the app's server looks up who you are.
- Search, reranking and the model call are separate files with plain inputs and outputs. Later steps swap each one for your own.
- The workflow saved each step's result as it went. Long work leaves the request and survives a restart.

Next up, section 01: you write the code that talks to the model.
