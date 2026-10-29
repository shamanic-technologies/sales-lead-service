/**
 * GET /orgs/leads/pipe-queue?brandId=&from=&to=[&limit=] (FACTORY-P4-PAGES) — who waits on one pipe
 * of the brand (its leg named by two catalogue steps) and how many it moved per week. Rule:
 * src/lib/pipe-queue.ts. Mounted BEFORE the leads router so `/orgs/leads/pipe-queue` is not read as a
 * lead id; the gateway reaches it through `/v1/leads/:id` (query string forwarded verbatim).
 */
import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeyAuth, requireOrgId, type AuthenticatedRequest } from "../middleware/auth.js";
import { loadLeadStateCatalogue, readLeadStates } from "../lib/lead-states-read.js";
import { LeadStateCatalogueError } from "../lib/lead-states.js";
import { CampaignLegsUnavailableError } from "../lib/campaign-leg-client.js";
import { canonicalizeStepOutcome } from "../lib/step-statements.js";
import { computePipeQueue, isoWeekStart } from "../lib/pipe-queue.js";
import { PIPE_QUEUE_MAX_LIMIT } from "../schemas.js";

const router = Router();

const STEP_RE = /^[a-z][a-z0-9_]{0,63}$/;

router.get("/orgs/leads/pipe-queue", apiKeyAuth, requireOrgId, async (req: AuthenticatedRequest, res) => {
  const q = req.query as Record<string, unknown>;
  const unknown = Object.keys(q).filter((k) => !["brandId", "from", "to", "limit"].includes(k));
  if (unknown.length > 0) return res.status(400).json({ error: `unknown query parameter(s): ${unknown.join(", ")}; accepted: brandId, from, to, limit` });
  const brandId = typeof q.brandId === "string" ? q.brandId.trim() : "";
  const from = typeof q.from === "string" ? q.from : "";
  const to = typeof q.to === "string" ? q.to : "";
  if (!brandId) return res.status(400).json({ error: "brandId is required" });
  if (!STEP_RE.test(from) || !STEP_RE.test(to)) return res.status(400).json({ error: "from and to are required: the pipe's leg as two catalogue step keys" });
  if (from === to) return res.status(400).json({ error: "from and to must differ" });
  const limit = q.limit === undefined ? 100 : Number(q.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > PIPE_QUEUE_MAX_LIMIT) {
    return res.status(400).json({ error: `limit must be an integer 1..${PIPE_QUEUE_MAX_LIMIT}` });
  }
  const orgId = req.orgId!;
  try {
    const catalogue = await loadLeadStateCatalogue();
    const { leads } = await readLeadStates({ orgId });
    const atBrand = leads.filter((l) => l.brandId === brandId);
    // A live "won't happen" on the `to` step (a person or the CRM said it), on any of the lead's rows at the brand.
    const step = canonicalizeStepOutcome(to);
    const never = step
      ? ((await db.execute(sql`
          SELECT DISTINCT lead_id::text AS lead_id FROM lead_step_disqualifications
          WHERE org_id = ${orgId} AND brand_id = ${brandId} AND step = ${step} AND retracted_at IS NULL AND withdrawn_at IS NULL
        `)) as unknown as Array<{ lead_id: string }>)
      : [];
    const computed = computePipeQueue({
      from,
      to,
      catalogue,
      leads: atBrand.map((l) => ({ leadId: l.leadId, states: l.states })),
      neverOnTo: new Set(never.map((r) => r.lead_id)),
      untilWeek: isoWeekStart(new Date().toISOString()),
    });
    const shown = computed.waiting.slice(0, limit);
    const ids = shown.map((w) => w.leadId);
    const people = new Map<string, Record<string, string | null>>();
    if (ids.length > 0) {
      const idArr = sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
      const rows = (await db.execute(sql`
        SELECT l.id::text AS lead_id, l.first_name, l.last_name, l.name, l.photo_url,
               o.org_name, o.org_domain, o.title, lc.id::text AS campaign_lead_id
        FROM leads l
        LEFT JOIN LATERAL (
          SELECT org.name AS org_name, org.primary_domain AS org_domain, lo.title
          FROM leads_organizations lo JOIN organizations org ON org.id = lo.organization_id
          WHERE lo.lead_id = l.id ORDER BY lo.current DESC, lo.start_date DESC NULLS LAST LIMIT 1
        ) o ON true
        LEFT JOIN LATERAL (
          SELECT c.id FROM leads_campaigns c
          WHERE c.lead_id = l.id AND c.org_id = ${orgId} AND c.brand_ids @> ARRAY[${brandId}]::text[]
          ORDER BY c.created_at DESC LIMIT 1
        ) lc ON true
        WHERE l.id = ANY(${idArr})
      `)) as unknown as Array<Record<string, string | null>>;
      for (const r of rows) people.set(r.lead_id as string, r);
    }
    return res.json({
      brandId,
      from,
      to,
      fromState: computed.fromState,
      toState: computed.toState,
      unservedReason: computed.unservedReason,
      waitingCount: computed.waiting.length,
      waiting: shown.map((w) => {
        const p = people.get(w.leadId);
        return {
          leadId: w.leadId,
          campaignLeadId: p?.campaign_lead_id ?? null,
          firstName: p?.first_name ?? null,
          lastName: p?.last_name ?? null,
          name: p?.name ?? null,
          title: p?.title ?? null,
          orgName: p?.org_name ?? null,
          orgDomain: p?.org_domain ?? null,
          photoUrl: p?.photo_url ?? null,
          waitingSince: w.waitingSince,
          causedByOutreach: w.causedByOutreach,
        };
      }),
      throughput: computed.throughput,
    });
  } catch (error) {
    console.error("[lead-service] pipe queue read failed:", error);
    if (error instanceof LeadStateCatalogueError || error instanceof CampaignLegsUnavailableError) {
      return res.status(502).json({ error: "dependency_unavailable", message: (error as Error).message });
    }
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
