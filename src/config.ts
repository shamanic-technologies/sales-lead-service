/**
 * Centralized environment configuration.
 * Validates all required env vars at import time — if anything is missing,
 * the process crashes immediately instead of failing silently at runtime.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[lead-service] Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// --- Core ---
export const PORT = optional("PORT", "3006");
export const LEAD_SERVICE_API_KEY = required("LEAD_SERVICE_API_KEY");

// --- Database (validated separately in db/index.ts) ---
// LEAD_SERVICE_DATABASE_URL is validated in db/index.ts at import time

// --- Downstream services ---
// People sourcing goes through the human-service people gateway (apollo OR apify),
// never apollo-service / apify-service directly.
export const HUMAN_SERVICE_URL = required("HUMAN_SERVICE_URL");
export const HUMAN_SERVICE_API_KEY = required("HUMAN_SERVICE_API_KEY");

export const BRAND_SERVICE_URL = required("BRAND_SERVICE_URL");
export const BRAND_SERVICE_API_KEY = required("BRAND_SERVICE_API_KEY");

export const CAMPAIGN_SERVICE_URL = required("CAMPAIGN_SERVICE_URL");
export const CAMPAIGN_SERVICE_API_KEY = required("CAMPAIGN_SERVICE_API_KEY");

export const EMAIL_GATEWAY_SERVICE_URL = required("EMAIL_GATEWAY_SERVICE_URL");
export const EMAIL_GATEWAY_SERVICE_API_KEY = required("EMAIL_GATEWAY_SERVICE_API_KEY");


export const RUNS_SERVICE_URL = required("RUNS_SERVICE_URL");
export const RUNS_SERVICE_API_KEY = required("RUNS_SERVICE_API_KEY");

export const KEY_SERVICE_URL = required("KEY_SERVICE_URL");
export const KEY_SERVICE_API_KEY = required("KEY_SERVICE_API_KEY");

export const FEATURES_SERVICE_URL = required("FEATURES_SERVICE_URL");
export const FEATURES_SERVICE_API_KEY = required("FEATURES_SERVICE_API_KEY");

export const WORKFLOW_SERVICE_URL = required("WORKFLOW_SERVICE_URL");
export const WORKFLOW_SERVICE_API_KEY = required("WORKFLOW_SERVICE_API_KEY");

export const CHAT_SERVICE_URL = required("CHAT_SERVICE_URL");
export const CHAT_SERVICE_API_KEY = required("CHAT_SERVICE_API_KEY");

// --- The customer's own CRM, as crm-service mirrors it ---
// Read-only, brand-scoped. Nothing in this service ever writes back to a customer's CRM.
export const CRM_SERVICE_URL = required("CRM_SERVICE_URL");
export const CRM_SERVICE_API_KEY = required("CRM_SERVICE_API_KEY");

// --- Sources of a lead's history (GET /orgs/leads/:id/history) ---
// Every one of these owns a fact about a person that this service does not: the messages
// exchanged and the reply statements a human recorded (instantly-service), the exchange that
// lives only in the customer's own mailbox (google-service), and the copy we generated with the
// follow-up cadence it planned (content-generation-service). None of them is re-derived here —
// each is asked for its own fact, and a source that cannot answer is REPORTED as unreachable
// rather than rendered as "nothing happened".
export const INSTANTLY_SERVICE_URL = required("INSTANTLY_SERVICE_URL");
export const INSTANTLY_SERVICE_API_KEY = required("INSTANTLY_SERVICE_API_KEY");

export const GOOGLE_SERVICE_URL = required("GOOGLE_SERVICE_URL");
export const GOOGLE_SERVICE_API_KEY = required("GOOGLE_SERVICE_API_KEY");

export const CONTENT_GENERATION_SERVICE_URL = required("CONTENT_GENERATION_SERVICE_URL");
export const CONTENT_GENERATION_SERVICE_API_KEY = required("CONTENT_GENERATION_SERVICE_API_KEY");

// --- Conversion tracking (beta) ---
// Public URL of the api-service gateway a client's website hits for
// POST /public/conversions. This is the PUBLIC gateway host, NOT the internal
// lead-service URL. Fleet-shared: same value across every service that emits a
// public ingest URL. Optional with a sane default so boot never fails; MUST be
// set to the real public host in Railway.
export const API_SERVICE_PUBLIC_URL = optional(
  "API_SERVICE_PUBLIC_URL",
  "https://api.distribute.you",
);
export const CONVERSION_INGEST_URL = `${API_SERVICE_PUBLIC_URL.replace(/\/+$/, "")}/public/conversions`;

// --- Buffer / strategy tuning ---
export const TARGET_BUFFER_SIZE = 20;
export const MAX_STRATEGY_GENERATION_ROUNDS = 15;
export const PULL_NEXT_TIMEOUT_MS = 600_000;
