import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeyAuth } from "../middleware/auth.js";

const router = Router();

/**
 * Parse a comma-separated query value: split on ",", trim each part, drop empties.
 * Mirrors runs-service GET /v1/stats/public/costs featureSlugs resolution byte-for-byte.
 */
function parseCsv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

interface MembershipRow {
  org_id: string;
  brand_id: string;
  workflow_slug: string;
}

/**
 * GET /internal/feature-memberships?featureSlugs=<csv>
 *
 * Returns the DISTINCT (orgId, brandId, workflowSlug) tuples that have leads for the
 * requested feature(s). brandId is unnested from brand_ids[]. featureSlugs are matched
 * exactly (same as runs-service /v1/stats/public/costs — feature slugs are not versioned).
 *
 * Auth: x-api-key only (same tier as other /internal/* routes). No identity headers required.
 */
router.get("/internal/feature-memberships", apiKeyAuth, async (req, res) => {
  try {
    const featureSlugs = parseCsv(req.query.featureSlugs);

    // No requested features -> nothing to resolve. Never run an unfiltered cross-org dump.
    if (featureSlugs.length === 0) {
      res.json({ memberships: [] });
      return;
    }

    const rows = (await db.execute(sql`
      SELECT DISTINCT org_id, unnest(brand_ids) AS brand_id, workflow_slug
      FROM leads_campaigns
      WHERE feature_slug IN (${sql.join(
        featureSlugs.map((s) => sql`${s}`),
        sql`, `,
      )})
        AND workflow_slug IS NOT NULL
    `)) as unknown as MembershipRow[];

    const memberships = rows.map((r) => ({
      orgId: r.org_id,
      brandId: r.brand_id,
      workflowSlug: r.workflow_slug,
    }));

    res.json({ memberships });
  } catch (error) {
    console.error("[lead-service] feature-memberships error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
