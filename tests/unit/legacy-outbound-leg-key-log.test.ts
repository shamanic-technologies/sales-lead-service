import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { LEGACY_OUTBOUND_LEG_KEY_MARKER, noteLegacyOutboundLegKey, servedLegKey } from "../../src/lib/leg-identity.js";
import { withRequestContext } from "../../src/lib/request-context.js";

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

const markerLines = () =>
  warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(LEGACY_OUTBOUND_LEG_KEY_MARKER));

describe("noteLegacyOutboundLegKey", () => {
  it("writes one warn line for a legacy outbound key", () => {
    noteLegacyOutboundLegKey("sales-cold-email-outreach", "start_to_conversation", "campaign-service GET /campaigns");
    expect(markerLines()).toEqual([
      "[legacy-outbound-leg-key] key=start_to_conversation featureSlug=sales-cold-email-outreach " +
        "source=campaign-service GET /campaigns route=background caller=- org=-",
    ]);
  });

  it("writes nothing for the new spelling, a non-outbound start_to_*, sourcing, or no channel", () => {
    noteLegacyOutboundLegKey("sales-cold-email-outreach", "lead_found_to_conversation", "s");
    noteLegacyOutboundLegKey("cold-linkedin-outreach", "lead_found_to_website_visit", "s");
    noteLegacyOutboundLegKey("google-ads", "start_to_website_visit", "s");
    noteLegacyOutboundLegKey("sourcing-apollo-cold-filters", "start_to_lead_found", "s");
    noteLegacyOutboundLegKey(null, "start_to_conversation", "s");
    noteLegacyOutboundLegKey("sales-cold-email-outreach", null, "s");
    expect(markerLines()).toEqual([]);
  });

  it("leaves the key accepted exactly as before", () => {
    noteLegacyOutboundLegKey("sales-cold-email-outreach", "start_to_website_visit", "s");
    expect(servedLegKey("sales-cold-email-outreach", "start_to_website_visit")).toBe("lead_found_to_website_visit");
  });

  it("inside a request: carries route, caller and org, one line per key per request", async () => {
    const app = express();
    app.use(withRequestContext);
    app.get("/orgs/leads", async (_req, res) => {
      await Promise.resolve();
      for (let i = 0; i < 3; i++) noteLegacyOutboundLegKey("cold-sms-outreach", "start_to_conversation", "src");
      noteLegacyOutboundLegKey("cold-sms-outreach", "start_to_website_visit", "src");
      res.json({ ok: true });
    });

    const res = await request(app)
      .get("/orgs/leads?brandId=b")
      .set("x-caller-service", "features-service")
      .set("x-org-id", "org-1");
    expect(res.status).toBe(200);
    expect(markerLines()).toEqual([
      "[legacy-outbound-leg-key] key=start_to_conversation featureSlug=cold-sms-outreach source=src " +
        "route=GET /orgs/leads caller=features-service org=org-1",
      "[legacy-outbound-leg-key] key=start_to_website_visit featureSlug=cold-sms-outreach source=src " +
        "route=GET /orgs/leads caller=features-service org=org-1",
    ]);

    // A second request logs again: the dedup is per request, not per process.
    await request(app).get("/orgs/leads");
    expect(markerLines()).toHaveLength(4);
  });
});
