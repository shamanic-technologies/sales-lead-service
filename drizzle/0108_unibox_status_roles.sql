-- Owner 2026-10-17: Type splits into STATUS (prospect / customer / churned, one value) and ROLES (several).
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'prospect';
--> statement-breakpoint
ALTER TABLE "unibox_rows" ADD COLUMN IF NOT EXISTS "roles" text[] NOT NULL DEFAULT '{}';
