import { Router, type Response } from "express";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { CLIENT_SENTIMENTS, readClientSentiment, type ClientSentiment } from "../lib/client-sentiment.js";
import { OrgMembersUnavailableError } from "../lib/org-members.js";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /internal/brands/:brandId/client-sentiment[?since=&sentiment=] (x-org-id) — every message a client of the brand
 * wrote it (any channel), with its Client Sentiment verdict, plus per-day counts (CLIENT-SENTIMENT-1027, rules in
 * src/lib/client-sentiment.ts). `unjudged` / `judgedThrough` tell a consumer whether a count is final, never a fake 0.
 */
router.get("/internal/brands/:brandId/client-sentiment", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res: Response) => {
  const brandId = String(req.params.brandId ?? "");
  if (!UUID_RE.test(brandId)) return res.status(400).json({ error: "invalid_brand_id" });
  const since = typeof req.query.since === "string" && req.query.since ? req.query.since : undefined;
  if (since !== undefined && Number.isNaN(Date.parse(since))) return res.status(400).json({ error: "invalid_since", message: "since must be an ISO date" });
  const raw = typeof req.query.sentiment === "string" ? req.query.sentiment : undefined;
  if (raw !== undefined && !(CLIENT_SENTIMENTS as readonly string[]).includes(raw)) {
    return res.status(400).json({ error: "invalid_sentiment", message: `sentiment is one of ${CLIENT_SENTIMENTS.join(", ")}` });
  }
  try {
    return res.json(await readClientSentiment({ orgId: req.orgId!, brandId }, { since, sentiment: raw as ClientSentiment | undefined }));
  } catch (error) {
    console.error(`[lead-service] client sentiment read failed for brand ${brandId}:`, error);
    if (error instanceof OrgMembersUnavailableError) return res.status(502).json({ error: "dependency_unavailable", message: error.message });
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
