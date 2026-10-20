---
title: Questions in your own words miss the policies
type: lab
---

# Questions in your own words miss the policies: the solution

**The cause.** The chunk writer labels vectors with the wrong version. `embedPendingChunks` in `src/db/embeddings.ts` writes `embedding_model_version = EMBEDDING_MODEL` (`'text-embedding-3-small'`) where it should write `embedder.version` (`'text-embedding-3-small@1536'`). Vector search only compares a query with vectors of its own version (sections 06 and 07: two models' vectors live in different spaces, so mixing them is meaningless). So every chunk embedded since is invisible to it. A question only BM25 can answer still works; a paraphrase, which needs the vectors, misses. The plant relabelled the HR policies' chunks, as last night's run would have.

## The path a good debugger takes

1. **The two questions.** "How many days of compassionate leave do I get?" shares words with the policy ("compassionate leave"); "My dad died last week. How long can I stay at home?" shares almost none. BM25 matches words, vectors match meaning. One works and one doesn't, so the lexical side is fine and the vector side is suspect. The model, the ACLs and the reranker are ruled out: they'd fail both.
2. **`/labs/lexical` confirms it.** For the paraphrase, the vector list holds nothing from `/HR/Policies`, while for other folders it looks normal. So it's these documents, not vector search as a whole.
3. **What does vector search need from a chunk?** An embedding, and a version that matches the query's (`src/core/search/vector.ts` filters on `embedding_model_version = <the query embedder's version>`). The embeddings are there (`embedding IS NOT NULL`).
4. **The labels.** `SELECT embedding_model_version, count(*) FROM chunks GROUP BY 1` gives two labels for one model: `text-embedding-3-small@1536` for most chunks, and `text-embedding-3-small`, with no `@1536`, for the HR policies' 48. The vectors are the same model's; only the label is off, and the label is what the search compares.
5. **Who writes the label?** The query side reads `deps.embedder.version`. The writing side is `embedPendingChunks`, and it writes a constant.
6. **`pnpm db:embed` confirms it.** It picks up chunks whose version differs from the embedder's, re-embeds them, writes the wrong label again, and finds the same chunks next time: it re-embeds the same 48 on every run, which costs money and fixes nothing.

## The fix

Code, then data. In `embedPendingChunks`, write `embedding_model_version = ${embedder.version}` (and drop the `EMBEDDING_MODEL` import it no longer needs). Then put the labels right: `pnpm db:embed` re-embeds the mislabelled chunks with the fixed writer (48 chunks, a fraction of a cent), or, once you've checked the vectors really are from the app's model, relabel them in SQL. Re-embedding is the safe choice when you're not sure.

## The lesson

- **A version is part of a vector.** A vector means nothing without the model that made it. The version column is what keeps two spaces apart, so whoever writes it has to write exactly what the reader compares with: one source of truth (`embedder.version`), never a second spelling.
- **Ingest succeeding isn't search working.** The overnight run "finished with no errors" because nothing checked that a freshly written chunk could be found. A canary (embed a known chunk, search for it by a paraphrase) after each run would have caught it.
- **Some bugs leave data behind.** Fixing the writer stops new damage; the rows it already wrote stay wrong until you repair them.
