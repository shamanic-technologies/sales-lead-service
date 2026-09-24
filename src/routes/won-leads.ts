import { Router, type Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  apiKeyAuth,
  requireOrgId,
  type AuthenticatedRequest,
} from "../middleware/auth.js";
import { toIsoTimestamp } from "../lib/basic-leads.js";
import { SALE_STEP } from "../lib/closed-deal.js";

const router = Router();

/**
 * Every stored spelling of the `sale` step: the canonical name plus the legacy "purchase" the
 * ingest folds into it (`src/lib/conversions.ts`). Rows are normalized at write, but a row
 * written before the rename still carries the old spelling and is just as much a sale.
 */
const SALE_SPELLINGS: string[] = [SALE_STEP, "purchase"];

interface WonLeadRow {
  lead_id: string;
  emails: string[] | null;
  won_at: Date | string | null;
  sources: string[];
}

/** Lowercased and trimmed — the normalization every consumer of an address compares under. */
function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * GET /orgs/brands/:brandId/won-leads[?email=<address>]
 *
 * The people this brand has WON, keyed by email — so the people gateway can refuse to hand a
 * paying client back to cold outreach. Without it, the only thing standing between a closed deal
 * and a cold email from the brand that sold to them is human-service's 3-month serve suppression,
 * which knows nothing about outcomes and lapses.
 *
 * "Won" is exactly what makes a lead's standing `customer` (`src/lib/lead-standing.ts`): a live,
 * attributed `sale` on the outcome ledger, whoever observed it — a person's statement
 * (`manual`), the brand's tracker (`tracker`), or the customer's own CRM (`crm`). Every funnel
 * this service knows ends at `sale`, so the funnel's last step reached IS a sale. Nothing is
 * re-derived here: the same three filters every outcome read applies (`attribution_status =
 * 'attributed'`, `withdrawn_at IS NULL`, the brand) are the whole definition, so a withdrawn
 * statement, and a CRM row a person's statement superseded, stop counting on the very next read.
 *
 * Scope is the (org, brand) pair — every campaign and every offer of the brand — because a brand
 * row is a shared global identity and two orgs claiming the same domain are two businesses.
 *
 * Identity is the email: every address registered to the won lead, lowercased, so a person known
 * under two addresses is excluded under both. `?email=` answers for one address with the SAME
 * query narrowed, so the one-address check cannot disagree with the set. A won lead holding no
 * email address is still listed (with `emails: []`) so the set never silently shrinks.
 *
 * Failure is loud: any error is a 500, never an empty set — an empty answer here means "re-contact
 * freely", which is the one thing a failed read must never say.
 */
router.get(
  "/orgs/brands/:brandId/won-leads",
  apiKeyAuth,
  requireOrgId,
  async (req: AuthenticatedRequest, res: Response) => {
    const brandId = String(req.params.brandId ?? "").trim();
    if (!brandId) {
      res.status(400).json({ error: "brandId required" });
      return;
    }

    let email: string | null = null;
    if (req.query.email !== undefined) {
      if (typeof req.query.email !== "string" || normalizeEmail(req.query.email) === "") {
        res.status(400).json({ error: "email must be a non-empty address" });
        return;
      }
      email = normalizeEmail(req.query.email);
    }

    try {
      const rows = (await db.execute(sql`
        WITH won AS (
          SELECT ce.matched_lead_id AS lead_id,
                 min(ce.received_at) AS won_at,
                 array_agg(DISTINCT ce.source ORDER BY ce.source) AS sources
          FROM conversion_events ce
          WHERE ce.org_id = ${req.orgId}
            AND ce.brand_id = ${brandId}
            AND ce.event = ANY(${sql.param(SALE_SPELLINGS)}::text[])
            AND ce.attribution_status = 'attributed'
            AND ce.withdrawn_at IS NULL
            AND ce.matched_lead_id IS NOT NULL
          GROUP BY ce.matched_lead_id
        )
        SELECT won.lead_id, won.won_at, won.sources,
               (SELECT array_agg(DISTINCT lower(trim(cm.value)) ORDER BY lower(trim(cm.value)))
                FROM lead_contact_methods cm
                WHERE cm.lead_id = won.lead_id AND cm.channel = 'email') AS emails
        FROM won
        ${
          email === null
            ? sql``
            : sql`WHERE EXISTS (
                SELECT 1 FROM lead_contact_methods cm
                WHERE cm.lead_id = won.lead_id
                  AND cm.channel = 'email'
                  AND lower(trim(cm.value)) = ${email}
              )`
        }
        ORDER BY won.lead_id
      `)) as unknown as WonLeadRow[];

      const wonLeads = rows.map((r) => ({
        leadId: r.lead_id,
        emails: r.emails ?? [],
        wonAt: toIsoTimestamp(r.won_at),
        sources: r.sources,
      }));
      const emails =
        email !== null
          ? wonLeads.length > 0
            ? [email]
            : []
          : Array.from(new Set(wonLeads.flatMap((l) => l.emails))).sort();

      res.json({ brandId, emails, wonLeads });
    } catch (error) {
      console.error("[lead-service] won-leads error:", error);
      res.status(500).json({ error: "Could not read the brand's won leads" });
    }
  },
);

export default router;
