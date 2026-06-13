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

// --- Buffer / strategy tuning ---
export const TARGET_BUFFER_SIZE = 20;
export const MAX_STRATEGY_GENERATION_ROUNDS = 15;
export const PULL_NEXT_TIMEOUT_MS = 600_000;
