---
title: docling compared
type: guided
---

# docling compared

👨‍💼 Kestrel's parser is a few hundred lines you now know well. Before the team trusts it with every new kind of file, they want to know where it falls short. docling is a production converter, open source from IBM, and it reads the same PDFs and Word files. Run both over the corpus's hardest documents and look at where they disagree.

## Terms

- **docling** turns PDFs and Word files into structured text: headings, paragraphs, tables, each with the page it came from. It runs a **layout model**, a neural network that looks at a picture of each page and marks where the headings, tables and text are, so it can find a table even on a scan.
- **docling-serve** runs docling as a web service. Ours runs in Docker on port 5001.
- `scripts/parse-compare.ts` parses six trap documents with both, then prints per page: the share of each parser's words the other also found, the tables each found (rows by columns), and the headings and identifiers only one of them has.

## Do this

1. 🐨 Start docling. The first start pulls an image of about 4.4 GB:
   ```sh
   docker compose --profile docling up -d docling
   curl localhost:5001/health     # {"status":"ok"} once it's up
   ```
2. 🐨 Run the comparison. It takes a minute or two; docling does most of the waiting:
   ```sh
   pnpm exec tsx scripts/parse-compare.ts
   ```
3. 🐨 Read the output with these questions:
   - **Speed.** Each document prints "ours N s, docling N s". How much slower is docling on a typed PDF? On a scan?
   - **Typed tables** (the Q3 report, the contract register). Do the table shapes match? What does docling call a heading that we don't?
   - **Identifiers.** Look for "identifiers only ours" and "only docling". Which parser lost a contract number, and how?
   - **Scans** (the AP batch, the MSA's page 3). How many tables does each find? Which invoice and contract numbers does only docling read?
   - **Handwriting** (the HR case note). Who reads the times better?
4. 🐨 Stop docling when you're done: `docker compose --profile docling stop docling`.

🦉 Our parser reads the text layer exactly and fast, but on a picture it has only OCR's lines: no tables, no headings. docling looks at the page as an image first, so a scan keeps its structure. Neither wins everywhere, which is the point of measuring.

📜 [docling](https://github.com/docling-project/docling)
📜 [docling-serve](https://github.com/docling-project/docling-serve)
