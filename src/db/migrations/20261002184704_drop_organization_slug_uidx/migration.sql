-- The organization plugin declares the slug unique twice: the column's UNIQUE (organization_slug_key) and this
-- index. One is enough. `pnpm auth:generate` writes the index back into src/db/schema/auth.ts; take it out again
-- (the migrations test fails until you do).
DROP INDEX "organization_slug_uidx";