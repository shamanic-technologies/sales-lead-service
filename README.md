# Lead Service

The single source of truth for lead management. Handles buffering, deduplication, enrichment caching, and lead retrieval.

## Overview

Lead Service provides:
- **Deduplication** - Tracks served leads to prevent duplicates
- **Buffering** - Temporary staging for leads before serving
- **Enrichment Cache** - Global cache for Apollo enrichments (avoids paying twice)
- **Lead Retrieval** - List served leads with enrichment data
- **Cursor Management** - Persist pagination state across requests
- **Multi-tenancy** - Isolated data per organization and namespace

## Quick Start

```bash
# Install dependencies
npm install

# Set environment variables
export DATABASE_URL="postgres://..."
export API_KEY="your-api-key"
export APOLLO_SERVICE_URL="http://apollo-service:3003"
export APOLLO_SERVICE_API_KEY="your-apollo-key"

# Run migrations
npm run db:migrate

# Start development server
npm run dev
```

## API Reference

All endpoints (except `/health`) require authentication headers:
- `X-API-Key` - Service API key
- `X-App-Id` - Your application identifier
- `X-Org-Id` - Organization identifier

---

### Health Check

```
GET /health
```

Returns `{ "status": "ok" }`. No authentication required.

---

### Push Leads to Buffer

```
POST /buffer/push
```

Pushes leads into the buffer, skipping any already served in this namespace.

**Request Body:**
```json
{
  "namespace": "campaign-123",
  "brandId": "brand-abc",
  "clerkOrgId": "org_xyz",
  "clerkUserId": "user_123",
  "parentRunId": "run_abc",
  "leads": [
    {
      "email": "john@example.com",
      "externalId": "apollo_123",
      "data": { "name": "John" }
    }
  ]
}
```

**Response:**
```json
{
  "buffered": 8,
  "skippedAlreadyServed": 2
}
```

---

### Pull Next Lead

```
POST /buffer/next
```

Returns the next unserved lead from the buffer and marks it as served.

**Request Body:**
```json
{
  "namespace": "campaign-123",
  "parentRunId": "run_abc"
}
```

**Response (lead found):**
```json
{
  "found": true,
  "lead": {
    "email": "john@example.com",
    "externalId": "apollo_123",
    "data": { "name": "John" },
    "brandId": "brand-abc",
    "clerkOrgId": "org_xyz",
    "clerkUserId": "user_123"
  }
}
```

**Response (buffer empty):**
```json
{
  "found": false
}
```

---

### Enrich Lead

```
POST /enrich
```

Enriches a lead email via Apollo. Uses global cache to avoid paying twice.

**Request Body:**
```json
{
  "email": "john@example.com"
}
```

**Response:**
```json
{
  "id": "uuid",
  "email": "john@example.com",
  "firstName": "John",
  "lastName": "Doe",
  "title": "CEO",
  "linkedinUrl": "https://linkedin.com/in/johndoe",
  "organizationName": "Acme Inc",
  "organizationDomain": "acme.com",
  "organizationIndustry": "Technology",
  "organizationSize": "51-200",
  "cached": true
}
```

The `cached` field indicates whether the result came from cache (true) or was freshly fetched from Apollo (false).

---

### List Served Leads

```
GET /leads
```

Returns list of served leads with enrichment data. Supports filtering.

**Query Parameters:**
- `brandId` - Filter by brand
- `clerkOrgId` - Filter by Clerk organization
- `clerkUserId` - Filter by Clerk user

**Example:**
```
GET /leads?brandId=brand-123&clerkOrgId=org_abc
```

**Response:**
```json
{
  "leads": [
    {
      "id": "uuid",
      "email": "john@example.com",
      "namespace": "campaign-123",
      "brandId": "brand-123",
      "clerkOrgId": "org_abc",
      "clerkUserId": "user_123",
      "servedAt": "2024-01-15T10:00:00Z",
      "enrichment": {
        "firstName": "John",
        "lastName": "Doe",
        "title": "CEO",
        "organizationName": "Acme Inc"
      }
    }
  ]
}
```

---

### Read a Person's Lead on a Campaign

```
GET /orgs/campaigns/:campaignId/leads/by-lead/:leadId
```

The lead record of ONE person (`leadId`: what `leads/by-email` files and campaign-service's trigger-event
`ranLeads[].leadId` names) on ONE campaign, without paging the campaign's leads. Same `{ leadDetail }`
body as `GET /orgs/leads/:id`, delivery scoped to the path campaign. Org-scoped (`x-org-id`): no row, or
another org's row, = 404 `lead_not_on_campaign`. Optional `brandId`, `include=campaigns`.

---

### Get Cursor

```
GET /cursor/:namespace
```

Retrieves stored pagination state for a namespace.

**Response:**
```json
{
  "state": { "page": 5, "offset": 100 }
}
```

---

### Set Cursor

```
PUT /cursor/:namespace
```

Stores pagination state for resuming later.

**Request Body:**
```json
{
  "state": { "page": 5, "offset": 100 }
}
```

**Response:**
```json
{
  "ok": true
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                       Lead Service                          │
├─────────────────────────────────────────────────────────────┤
│  Routes                                                     │
│  ├── /health         Health check                           │
│  ├── /buffer/push    Push leads (with dedup)                │
│  ├── /buffer/next    Pull next lead                         │
│  ├── /enrich         Enrich email (cached)                  │
│  ├── /leads          List served leads                      │
│  └── /cursor/:ns     Get/set cursor                         │
├─────────────────────────────────────────────────────────────┤
│  Libraries                                                  │
│  ├── buffer.ts       pushLeads(), pullNext()                │
│  ├── dedup.ts        isServed(), markServed()               │
│  ├── enrichment.ts   getEnrichment() (with cache)           │
│  ├── apollo-client.ts Apollo service integration            │
│  └── runs-client.ts  Distributed tracing                    │
├─────────────────────────────────────────────────────────────┤
│  Database (PostgreSQL)                                      │
│  ├── organizations   Multi-tenant org mapping               │
│  ├── served_leads    Deduplication registry                 │
│  ├── lead_buffer     Temporary staging                      │
│  ├── enrichments     Global enrichment cache                │
│  └── cursors         Pagination state                       │
└─────────────────────────────────────────────────────────────┘
```

## Data Model

### Served Leads

| Field | Description |
|-------|-------------|
| `email` | Lead email (dedup key) |
| `namespace` | Logical grouping (e.g., campaign ID) |
| `brandId` | Brand identifier for filtering |
| `clerkOrgId` | Clerk organization ID |
| `clerkUserId` | Clerk user ID |
| `servedAt` | Timestamp when served |

### Enrichments (Global Cache)

| Field | Description |
|-------|-------------|
| `email` | Unique key (no org scoping) |
| `firstName`, `lastName` | Person name |
| `title` | Job title |
| `organizationName` | Company name |
| `responseRaw` | Full Apollo response |

### Lead Buffer

| Status | Description |
|--------|-------------|
| `buffered` | Waiting to be served |
| `served` | Successfully served |
| `skipped` | Skipped (already in served registry) |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `API_KEY` | Yes | Service authentication key |
| `PORT` | No | Server port (default: 3006) |
| `APOLLO_SERVICE_URL` | No | Apollo service URL for enrichment |
| `APOLLO_SERVICE_API_KEY` | No | Apollo service API key |
| `RUNS_SERVICE_URL` | No | Runs service URL for tracing |
| `SENTRY_DSN` | No | Sentry DSN for error tracking |

## Scripts

```bash
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm run start        # Run compiled code
npm run test         # Run tests
npm run db:generate  # Generate migrations
npm run db:migrate   # Run migrations
npm run db:push      # Push schema (dev only)
npm run db:studio    # Open Drizzle Studio
```
