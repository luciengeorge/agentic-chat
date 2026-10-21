---
title: CI and CD
type: guided
---

# CI and CD

👨‍💼 Steps 1 to 3 deployed from your terminal. That works once. Kestrel's team needs every pull request checked and previewed, production to change only when `main` does and only once the checks pass, the database migrated before the code that needs it, and the background jobs firing on their own.

## Terms

- A **required status check** is a CI job GitHub must see pass before a pull request can merge. **Branch protection** (or a ruleset) on `main` is where you require it.
- **Vercel's Git integration** builds every push to a connected repo: a preview for each branch and pull request, production for `main`.
- **Expand and contract** is how a schema changes without downtime (section 07's tokenizer change): add the new column or index first, ship code that uses it, remove the old one in a later deploy.

## What's already here

- `.github/workflows/ci.yml` runs on every push and pull request: lint, formatting, types, the tests against a ParadeDB service container, the build, the production build's boot check (it must refuse with nothing set, refuse the dev secrets, answer 404 on the spike and 401 on a cron route), and `pnpm ex gate`.
- `.github/workflows/deploy.yml` runs after CI passes and does nothing until you give it secrets. Its first job prints "No Vercel secrets: nothing deployed".
- `vercel.json` schedules the four cron routes.

## Do this

1. 🐨 Put the repo on GitHub if it isn't yet (this checkout has no remote): `gh repo create agentic-chat --private --source . --push`. Then connect it: Vercel project, **Settings**, **Git**. Push a branch and open a pull request: Vercel comments with the preview URL.
   ```sh
   git switch -c try-preview && git commit --allow-empty -m "try a preview" && git push -u origin try-preview
   gh pr create --fill
   ```
   Sign-in trusts only the origin in `BETTER_AUTH_URL`, so to sign in on this preview, alias it as in step 3: `vercel alias set <its url> "$PREVIEW"`.
2. 🐨 Require CI before merging: GitHub, **Settings**, **Rules**, a ruleset (or **Branches**, a protection rule) for `main`: require a pull request and the status check `check` (CI's one job). Now a red CI blocks the merge, so production (built from `main`) only gets code that passed.
3. 🐨 Let CI migrate production before Vercel deploys it. Add the cloud URLs from step 2 as repository secrets; `deploy.yml`'s `migrate` job then runs `pnpm db:migrate:remote` after every green CI on `main`.
   ```sh
   gh secret set DATABASE_ADMIN_URL    # paste the owner's URL
   gh secret set DATABASE_URL          # paste ac_app's URL
   ```
4. 🐨 Merge the pull request, then watch the **Actions** tab: CI, then Deploy (`plan`, `migrate`; `deploy` skipped, since Vercel's Git integration deploys). In Vercel, **Settings**, **Cron Jobs** lists the four routes; **Run** one and read its log line, `cron pass` with what it did.
5. 🐨 Read `deploy.yml`'s header for the other shape: CI deploys, through the Vercel CLI, only after CI passes. Answer for yourself: what does it gain over the Git integration, and what does it cost?
6. 🐨 Close the loop: run step 3's smoke against production.
   ```sh
   pnpm ex smoke --target https://<project>.vercel.app    # SMOKE_PASSWORD still set
   ```

🦉 Why the migration runs before the deploy, and why that's still not enough. New code that reads a column the database doesn't have yet fails on its first query; migrated first, the old code keeps running against a schema with one extra column it ignores. That only holds if migrations add before they remove. With Vercel's Git integration, the build and the `migrate` job start from the same push, so for a few minutes either can be ahead. Expand and contract makes the order not matter: each deploy's schema works for the code before it and the code after it.

📜 [Vercel's Git integration](https://vercel.com/docs/git), [Cron Jobs](https://vercel.com/docs/cron-jobs), [GitHub rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)

When you're done: a merged pull request, a green Deploy run with its migration, four cron jobs in Vercel's settings, and `ok` against production.
