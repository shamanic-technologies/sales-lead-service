/**
 * Vitest global setup — sets all required env vars before any module imports.
 * This prevents config.ts from throwing during test runs.
 */

const TEST_ENV_VARS: Record<string, string> = {
  LEAD_SERVICE_API_KEY: "test-api-key",
  LEAD_SERVICE_DATABASE_URL: "postgresql://test:test@localhost:5432/test",
  HUMAN_SERVICE_URL: "http://human:3012",
  HUMAN_SERVICE_API_KEY: "test-human-key",
  BRAND_SERVICE_URL: "http://brand:3005",
  BRAND_SERVICE_API_KEY: "test-brand-key",
  CAMPAIGN_SERVICE_URL: "http://campaign:3003",
  CAMPAIGN_SERVICE_API_KEY: "test-campaign-key",
  EMAIL_GATEWAY_SERVICE_URL: "http://email-gateway:3009",
  EMAIL_GATEWAY_SERVICE_API_KEY: "test-email-gateway-key",

  RUNS_SERVICE_URL: "http://runs:3007",
  RUNS_SERVICE_API_KEY: "test-runs-key",
  KEY_SERVICE_URL: "http://key-service:3001",
  KEY_SERVICE_API_KEY: "test-key-service-key",
  FEATURES_SERVICE_URL: "http://features:3010",
  FEATURES_SERVICE_API_KEY: "test-features-key",
  WORKFLOW_SERVICE_URL: "http://workflows:3002",
  WORKFLOW_SERVICE_API_KEY: "test-workflows-key",
  CHAT_SERVICE_URL: "http://chat:3011",
  CHAT_SERVICE_API_KEY: "test-chat-key",
  INSTANTLY_SERVICE_URL: "http://instantly:3013",
  INSTANTLY_SERVICE_API_KEY: "test-instantly-key",
  GOOGLE_SERVICE_URL: "http://google:3014",
  GOOGLE_SERVICE_API_KEY: "test-google-key",
  CONTENT_GENERATION_SERVICE_URL: "http://content-generation:3015",
  CONTENT_GENERATION_SERVICE_API_KEY: "test-content-generation-key",
  CRM_SERVICE_URL: "http://crm:3016",
  CRM_SERVICE_API_KEY: "test-crm-key",
  BILLING_SERVICE_URL: "http://billing:3017",
  BILLING_SERVICE_API_KEY: "test-billing-key",
  COSTS_SERVICE_URL: "http://costs:3018",
  CLOUDFLARE_SERVICE_URL: "http://cloudflare:3019",
  CLOUDFLARE_SERVICE_API_KEY: "test-cloudflare-key",
  SOCIAL_SERVICE_URL: "http://social:3020",
  SOCIAL_SERVICE_API_KEY: "test-social-key",
  APOLLO_SERVICE_URL: "http://apollo:3021",
  APOLLO_SERVICE_API_KEY: "test-apollo-key",
  CLIENT_SERVICE_URL: "http://client:3022",
  CLIENT_SERVICE_API_KEY: "test-client-key",
  NODE_ENV: "test",
};

for (const [key, value] of Object.entries(TEST_ENV_VARS)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}

// UNIT tests only: the Disqualified mark read (lead-disqualification.ts) is one extra statement in
// every lead read, and the unit suites fake the database per statement shape. They read "nobody is
// marked" unless a test mocks the module itself; the mark's SQL is covered against real Postgres in
// tests/integration/lead-disqualification-sql.test.ts.
import { expect, vi } from "vitest";

if (!(expect.getState().testPath ?? "").includes("/tests/integration/")) {
  vi.doMock("../src/lib/lead-disqualification.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../src/lib/lead-disqualification.js")>()),
    loadLiveMarks: async () => new Map(),
  }));
}

// EVERY test: the org's team (org-members.ts, client-service) is nobody unless a test states members through
// `setTestOrgMembers` (tests/helpers/org-members.ts). The client itself is covered in tests/unit/org-members.test.ts.
if (!(expect.getState().testPath ?? "").endsWith("/org-members.test.ts")) {
  vi.doMock("../src/lib/org-members.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../src/lib/org-members.js")>();
    const { testOrgMembers } = await import("./helpers/org-members.js");
    return {
      ...actual,
      loadOrgMemberKeys: async (orgId: string) =>
        new Set((testOrgMembers.get(orgId) ?? []).map((e) => actual.memberAddressKey(e)).filter((k): k is string => k !== null)),
    };
  });
}
