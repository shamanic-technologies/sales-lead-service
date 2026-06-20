# Project: lead-service

Apollo/sales-lead service — buffering, deduplication, enrichment caching, and lead retrieval. All journalist functionality has been moved to journalists-service.

## Commands

- `npm test` — run all tests (Vitest)
- `npm run test:unit` — run unit tests only
- `npm run test:integration` — run integration tests only
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas
- `npm run db:generate` — generate Drizzle migrations (⚠️ see Migrations below — do NOT use)
- `npm run db:migrate` — run Drizzle migrations
- `npm run db:push` — push schema directly (dev only)

## Migrations — hand-author, do NOT `db:generate`

The drizzle meta snapshots (`drizzle/meta/*_snapshot.json`) stop at `0007`; migrations `0008`+ were all hand-authored. So `npm run db:generate` (`drizzle-kit generate`) has no recent snapshot to diff against and drops into an interactive prompt asking to **recreate every table** — it cannot produce a clean incremental migration. Convention: **hand-author the `.sql` file + add the journal entry to `drizzle/meta/_journal.json` yourself**. Make every statement idempotent (`DROP COLUMN IF EXISTS`, `DROP INDEX IF EXISTS`, `CREATE INDEX IF NOT EXISTS`, or `DO $$ … IF EXISTS … $$`) — see `0022`/`0023` as templates. `npm run db:migrate` (`drizzle-kit migrate`) applies the journal's `.sql` files and does NOT need the snapshots, so this works at boot.

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/routes/` — Express route handlers (buffer, leads, cursor, health, stats)
- `src/middleware/auth.ts` — API key + multi-tenant header auth
- `src/lib/buffer.ts` — pullNext(), fillBufferFromSearch() buffer logic
- `src/lib/dedup.ts` — checkDelivered() (via email-gateway), markServed() deduplication
- `src/lib/email-gateway-client.ts` — Email-gateway POST /status client for delivery checks
- `src/lib/leads-registry.ts` — Global lead identity registry (leads + leadEmails tables)
- `src/lib/people-client.ts` — human-service people gateway client (provider-agnostic search/enrich via apollo OR apify; lead-service no longer calls apollo/apify directly). **Do NOT branch on provider in the consumer** (`if (provider === "apollo")`). The gateway is provider-agnostic: pass every identity field you stored (`providerPersonId` from the apollo-specific column when present, `firstName`/`lastName`/`domain` when present) and let the gateway pick the reveal path. The `(provider, providerPersonId)` pair is what disambiguates the id — `provider` qualifies it, so a generic wire field is correct; don't push per-provider routing back into lead-service. (Set 2026-06-14, v0.21.2 apollo reveal-by-person-id regression fix.)
- `src/lib/campaign-client.ts` — Campaign service client (fetch campaign details for search context)
- `src/lib/brand-client.ts` — Brand service client (fetch brand details for search context)
- `src/lib/runs-client.ts` — Runs service client for distributed tracing
- `src/db/schema.ts` — Drizzle ORM table definitions (PostgreSQL)
- `src/db/index.ts` — Database connection
- `src/config.ts` — Environment config
- `src/instrument.ts` — Sentry instrumentation
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated from Zod schemas, do NOT edit manually

## Data Layering

- lead-service owns silver lead entities (`leads`, `lead_contact_methods`, `leads_organizations`, `organizations`) and per-campaign lifecycle rows (`leads_campaigns`).
- `GET /orgs/leads?view=basic` is a Gold serving projection for dashboard list views: return only the locked slim lead shape, current-employer org summary, primary email, lifecycle fields, and live delivery overlay.
- Prefer a Gold view/projection before a Gold table. Materialize only after profiling proves the joins themselves are the bottleneck; do not materialize live delivery status, and do not bake the known multi-`current=true` employment defect into stored Gold state.
- For current employer reads, never trust a bare `current=true` filter alone. Use deterministic winner selection: enriched org first, newest employment row next, stable organization id last.

## API Design Rules

- **Minimal request body.** Everything that workflow-service auto-injects as headers (`x-org-id`, `x-user-id`, `x-run-id`, `x-campaign-id`, `x-brand-id`, `x-workflow-slug`, `x-feature-slug`) MUST be read from headers, never duplicated in the body.
- **No `.default()` on Zod fields.** If a field is needed, make it required. A missing field is a 400, not a silent default.
- **No optional "convenience" fields.** If the service can fetch data internally (campaign context from campaign-service, brand fields from brand-service), do NOT accept it as a body parameter. Fetch it yourself. **This extends to identity HEADERS, not just body fields: a header carrying a producer-owned attribute that is *derivable* from an entity already identified by another header must be fetched, not required.** The `goal` (signup|meetingBooked|purchase) is a brand attribute (brand-service `brands.currentGoal`), derivable from `x-brand-id` via `GET /internal/brands/:brandId/runtime-context` — so lead-service fetches it inside buffer/next, never requires `x-goal` (v0.25). Carve-out: headers that ARE the request's identity (`x-org-id`, `x-campaign-id`, `x-brand-id`, `x-run-id`, `x-audience-id`) stay headers — they name *which* entity, they are not derivable attributes OF it.
- **Audience selection is campaign-owned — lead-service NEVER re-ranks/re-selects.** campaign-service decides the priority audience per run (`internal.ts` → features persona-stats) and propagates it as `x-audience-id` to every downstream DAG node. `buffer/next` serves the audience named by `x-audience-id` (`req.audienceId`) directly; no `x-audience-id` ⟹ clean `found:false` (campaign selected none). Do NOT re-introduce a features-service `persona-stats`/`getTopAudienceId` call in lead-service — that duplicated, divergent selection let an uncommitted audience be picked and 422 at serve-next (v0.26.1 removed it). Serveability (audience has a committed provider) is enforced upstream in human-service; lead-service treats serve-next 422 "no committed provider" as `found:false` (reason `audience_not_serveable`), never a 500.
- **Idempotency is internal.** Use `x-run-id` as the idempotency key. Never expose idempotency keys in the API surface.
