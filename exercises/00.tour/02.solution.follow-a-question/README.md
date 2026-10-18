---
title: Follow a question
type: guided
---

# Follow a question

👨‍💼 When a Kestrel employee says "the assistant gave me the wrong answer", you need to know which part went wrong. Was the right document never found, found but ranked too low, or found and then ignored by the model? Following one question end to end is how you tell.

## Terms

- A **route** is the code that answers one URL. A **server route** is a plain HTTP handler; the app uses them for streams, webhooks and starting workflows.
- **Retrieval** finds the chunks of documents that might answer a question. A **chunk** is a short piece of a document, a few paragraphs long.
- A **reranker** reads the question and each candidate chunk together and scores how well they match. It's slower than search, so it runs on the top few dozen only.
- A **workflow** is a function whose progress is saved after each **step**, so a crash resumes where it stopped. A **run** is one execution of a workflow. An **agent run** is one: the model picks tools in a loop, and each turn is saved as it goes. A **sync** is another: it copies the file store's changes into the database.
- The **run viewer** is Workflow's web page that lists runs and shows each step's input, output and timing.

## Do this

1. 🐨 With the app running (step 00.1), ask the assistant a question, such as "What's the meal allowance on a work trip?" A plain question like this is answered inside the request, so it starts no workflow.
2. 🐨 Find the server route that received it, under `src/routes/`, and follow the calls: retrieval, then the reranker, then the model. Note which file each one lives in.
3. 🐨 Now make a run to watch. Turn on **Run as agent** under the message box and ask again: the agent works as a workflow. (A sync is one too: `pnpm sync` asks for one for each tenant.) Open the run viewer at http://localhost:3000/_workflow (or run `pnpm exec workflow web`, which opens the same viewer), pick that run, and click through its steps in order, reading what each one received and returned.

🦉 Each step's result is saved before the next one starts. That's what lets a run survive a restart: on the way back up, Workflow replays the saved results instead of doing the work again.

📜 [Vercel Workflow](https://vercel.com/docs/workflow)
