# Project: lead-service

Apollo/sales-lead service — buffering, deduplication, enrichment caching, and lead retrieval. All journalist functionality has been moved to journalists-service.

## Commands

- `npm test` — run all tests (Vitest)
- `npm run test:unit` — run unit tests only
- `npm run test:integration` — run integration tests only
- `npm run build` — compile TypeScript + generate OpenAPI spec
- `npm run dev` — local dev server with hot reload
- `npm run generate:openapi` — regenerate openapi.json from Zod schemas
- `npm run db:generate` — generate Drizzle migrations
- `npm run db:migrate` — run Drizzle migrations
- `npm run db:push` — push schema directly (dev only)

## Architecture

- `src/schemas.ts` — Zod schemas (source of truth for validation + OpenAPI)
- `src/routes/` — Express route handlers (buffer, leads, cursor, health, stats)
- `src/middleware/auth.ts` — API key + multi-tenant header auth
- `src/lib/buffer.ts` — pullNext(), fillBufferFromSearch() buffer logic
- `src/lib/dedup.ts` — checkDelivered() (via email-gateway), markServed() deduplication
- `src/lib/email-gateway-client.ts` — Email-gateway POST /status client for delivery checks
- `src/lib/leads-registry.ts` — Global lead identity registry (leads + leadEmails tables)
- `src/lib/people-client.ts` — human-service people gateway client (provider-agnostic search/enrich via apollo OR apify; lead-service no longer calls apollo/apify directly)
- `src/lib/campaign-client.ts` — Campaign service client (fetch campaign details for search context)
- `src/lib/brand-client.ts` — Brand service client (fetch brand details for search context)
- `src/lib/runs-client.ts` — Runs service client for distributed tracing
- `src/db/schema.ts` — Drizzle ORM table definitions (PostgreSQL)
- `src/db/index.ts` — Database connection
- `src/config.ts` — Environment config
- `src/instrument.ts` — Sentry instrumentation
- `tests/` — Test files (`*.test.ts`)
- `openapi.json` — Auto-generated from Zod schemas, do NOT edit manually

## API Design Rules

- **Minimal request body.** Everything that workflow-service auto-injects as headers (`x-org-id`, `x-user-id`, `x-run-id`, `x-campaign-id`, `x-brand-id`, `x-workflow-slug`, `x-feature-slug`) MUST be read from headers, never duplicated in the body.
- **No `.default()` on Zod fields.** If a field is needed, make it required. A missing field is a 400, not a silent default.
- **No optional "convenience" fields.** If the service can fetch data internally (campaign context from campaign-service, brand fields from brand-service), do NOT accept it as a body parameter. Fetch it yourself.
- **Idempotency is internal.** Use `x-run-id` as the idempotency key. Never expose idempotency keys in the API surface.
