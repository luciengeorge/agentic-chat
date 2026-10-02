-- The ParadeDB image creates both in its own database; throwaway and CI databases need them too.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_search;
