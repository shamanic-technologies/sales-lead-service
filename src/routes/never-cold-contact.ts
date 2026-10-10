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
 * The outcomes that close a person to cold outreach BY THIS BRAND, forever (owner 2026-10-10:
 * a booked meeting blocks cold re-contact by that brand for good). A sale (plus its legacy
 * "purchase" spelling) and every meeting step: the person is in a conversation or a client,
 * never a cold prospect again. Stored spellings, not the leg graph: nothing is implied here,
 * only what a person, the tracker or the CRM actually evidenced.
 */
export const NEVER_COLD_CONTACT_EVENTS: string[] = [
  SALE_STEP,
  "purchase",
  "meeting_booked",
  "meeting_attended",
];

/**
 * The CRM people facts that close a person to cold outreach BY THIS BRAND, whether or not the person
 * is a lead yet (owner 2026-10-10, brief LEAD-NO-COLD-TO-OWN-USERS: a user who signed up to the
 * brand's product, or paid it, must never get a cold first email from that brand). Read off the
 * bronze copy of crm-service's people fact feed (`crm_facts`), keyed on the fact's own emails: a
 * signup or payment months before the person is ever sourced is exactly the case the outcome
 * ledger cannot see (it only holds facts paired to an existing lead). The meeting and sale types
 * are the same doctrine as NEVER_COLD_CONTACT_EVENTS, for CRM people not paired to a lead.
 */
export const NEVER_COLD_CONTACT_CRM_FACT_TYPES: string[] = [
  "signup",
  "payment",
  SALE_STEP,
  "meeting_booked",
  "meeting_attended",
];

interface NeverColdContactCrmRow {
  person_key: string;
  emails: string[] | null;
  first_at: Date | string | null;
  types: string[];
  sources: string[];
}

interface NeverColdContactRow {
  lead_id: string;
  emails: string[] | null;
  first_at: Date | string | null;
  steps: string[];
  sources: string[];
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** The legacy spelling reads as the step it was renamed to. */
function canonicalStep(event: string): string {
  return event === "purchase" ? SALE_STEP : event;
}

/**
 * GET /orgs/brands/:brandId/never-cold-contact[?email=<address>]
 *
 * The people this brand must NEVER cold-contact again, keyed by email, for the people gateway's
 * serve gate. Wider than `/won-leads` (which stays "paying clients" only): a live, attributed
 * `sale`, `meeting_booked` or `meeting_attended` on the outcome ledger, whoever observed it
 * (`manual`, `tracker`, `crm`, `reply`). Same three filters every outcome read applies
 * (`attribution_status = 'attributed'`, `withdrawn_at IS NULL`, the (org, brand)), so a withdrawn
 * statement stops counting on the very next read.
 *
 * Plus `crmPeople`: every person the brand's own CRM shows as signed up, paying, met or sold
 * (`crm_facts`, any source, any date, lead or not yet a lead), keyed on the fact's emails; a fact
 * stops counting once crm-service withdraws it. `emails` is the union of both.
 *
 * Identity is every email registered to the lead, lowercased; `?email=` narrows the SAME queries.
 * Failure is loud: any error is a 500, never an empty set (empty means "re-contact freely").
 */
router.get(
  "/orgs/brands/:brandId/never-cold-contact",
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
        WITH closed AS (
          SELECT ce.matched_lead_id AS lead_id,
                 min(ce.received_at) AS first_at,
                 array_agg(DISTINCT ce.event ORDER BY ce.event) AS steps,
                 array_agg(DISTINCT ce.source ORDER BY ce.source) AS sources
          FROM conversion_events ce
          WHERE ce.org_id = ${req.orgId}
            AND ce.brand_id = ${brandId}
            AND ce.event = ANY(${sql.param(NEVER_COLD_CONTACT_EVENTS)}::text[])
            AND ce.attribution_status = 'attributed'
            AND ce.withdrawn_at IS NULL
            AND ce.matched_lead_id IS NOT NULL
          GROUP BY ce.matched_lead_id
        )
        SELECT closed.lead_id, closed.first_at, closed.steps, closed.sources,
               (SELECT array_agg(DISTINCT lower(trim(cm.value)) ORDER BY lower(trim(cm.value)))
                FROM lead_contact_methods cm
                WHERE cm.lead_id = closed.lead_id AND cm.channel = 'email') AS emails
        FROM closed
        ${
          email === null
            ? sql``
            : sql`WHERE EXISTS (
                SELECT 1 FROM lead_contact_methods cm
                WHERE cm.lead_id = closed.lead_id
                  AND cm.channel = 'email'
                  AND lower(trim(cm.value)) = ${email}
              )`
        }
        ORDER BY closed.lead_id
      `)) as unknown as NeverColdContactRow[];

      // CRM people of the brand (lead or not): a live (never withdrawn) closing fact, by email.
      const crmRows = (await db.execute(sql`
        SELECT f.person_key,
               min(f.occurred_at) AS first_at,
               array_agg(DISTINCT f.type ORDER BY f.type) AS types,
               array_agg(DISTINCT f.source ORDER BY f.source) AS sources,
               (SELECT array_agg(DISTINCT lower(trim(e)) ORDER BY lower(trim(e)))
                FROM crm_facts f2, unnest(f2.emails) AS e
                WHERE f2.org_id = ${req.orgId}
                  AND f2.brand_id = ${brandId}
                  AND f2.person_key = f.person_key
                  AND f2.type = ANY(${sql.param(NEVER_COLD_CONTACT_CRM_FACT_TYPES)}::text[])
                  AND NOT EXISTS (
                    SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f2.fact_id
                  )
                  AND trim(e) <> '') AS emails
        FROM crm_facts f
        WHERE f.org_id = ${req.orgId}
          AND f.brand_id = ${brandId}
          AND f.type = ANY(${sql.param(NEVER_COLD_CONTACT_CRM_FACT_TYPES)}::text[])
          AND NOT EXISTS (
            SELECT 1 FROM crm_facts w WHERE w.type = 'withdrawn' AND w.withdrawn_of = f.fact_id
          )
          ${
            email === null
              ? sql``
              : sql`AND EXISTS (SELECT 1 FROM unnest(f.emails) AS e WHERE lower(trim(e)) = ${email})`
          }
        GROUP BY f.person_key
        ORDER BY f.person_key
      `)) as unknown as NeverColdContactCrmRow[];

      const leads = rows.map((r) => ({
        leadId: r.lead_id,
        emails: r.emails ?? [],
        firstAt: toIsoTimestamp(r.first_at),
        steps: Array.from(new Set(r.steps.map(canonicalStep))).sort(),
        sources: r.sources,
      }));
      const crmPeople = crmRows.map((r) => ({
        personKey: r.person_key,
        emails: r.emails ?? [],
        firstAt: toIsoTimestamp(r.first_at),
        types: Array.from(new Set(r.types.map(canonicalStep))).sort(),
        sources: r.sources,
      }));
      const emails =
        email !== null
          ? leads.length > 0 || crmPeople.length > 0
            ? [email]
            : []
          : Array.from(new Set([...leads.flatMap((l) => l.emails), ...crmPeople.flatMap((p) => p.emails)])).sort();

      res.json({ brandId, emails, leads, crmPeople });
    } catch (error) {
      console.error("[lead-service] never-cold-contact error:", error);
      res.status(500).json({ error: "Could not read the brand's never-cold-contact set" });
    }
  },
);

export default router;
