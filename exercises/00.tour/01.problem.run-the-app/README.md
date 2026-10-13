---
title: Run the app
type: guided
---

# Run the app

👨‍💼 Kestrel Pay's assistant is one web app with two helpers: a database, and a stand-in for the company's file store. Before you change any of it, get all three running on your machine.

## Terms

- **Docker Compose** runs containers from one file, `compose.yaml`. A **container** is a program packaged with everything it needs to run.
- **ParadeDB** is Postgres with two extensions: `pg_search` adds keyword search (BM25), and `pgvector` stores embeddings (lists of numbers that stand for a text's meaning). It's the only database the app uses.
- A **migration** is a SQL file that changes the database's tables. `pnpm db:migrate` applies the ones that haven't run yet.
- A **tenant** is one customer organisation. There are two here, Kestrel Pay and Harbour Health, and neither may see the other's data.
- **Seeding** fills an empty database with the tenants and people from `fixtures/world.yaml`.
- **fake-workspace** stands in for the customer's file store, the way SharePoint would. It serves the documents and says who may read each one.

## Do this

1. 🐨 Start ParadeDB, create the tables and add the people:
   ```sh
   pnpm ex up
   ```
   It does three things you can also run one at a time: `pnpm db:up` starts ParadeDB and waits until it's healthy, `pnpm db:migrate` applies the migrations, and `pnpm db:seed` adds the tenants and people. Each is safe to run again.
2. 🐨 In two more terminals, start the app and fake-workspace:
   ```sh
   pnpm dev              # http://localhost:3000
   pnpm fake-workspace   # http://localhost:8100
   ```
3. 🐨 Open http://localhost:3000 and sign in as `leo.martin@kestrelpay.example` with the password `dev-password`. The page should name the tenant `kestrel`.
4. 🐨 Run the end-to-end check:
   ```sh
   pnpm ex smoke
   ```
   Every line should say `ok`. Each line is one check, and a failure names the part to look at.

🦉 `pnpm ex smoke` signs in the way you just did, asks fake-workspace who may read a confidential memo, runs a keyword search and a vector search in ParadeDB, runs a small workflow to the end, and checks that the exercise grader works. If all of that works, every part on the path is up.

📜 [Docker Compose](https://docs.docker.com/compose/)
