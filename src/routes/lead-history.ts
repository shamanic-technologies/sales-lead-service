/**
 * GET /orgs/leads/:id/history — what happened to this person, in order, in one place.
 *
 * `:id` is the `id` a list row already carries (the `leads_campaigns` membership row), so a panel
 * asks with nothing it did not already receive. The answer is one ordered list a consumer renders
 * without merging anything: everything we sent and when it was delivered, both directions of every
 * exchange WITH THE WORDS, what the person did, what somebody recorded by hand and who recorded
 * it, and what it converted into.
 *
 * **Scope is stated, because both questions are legitimate.** `scope=campaign` (the default) is
 * what THIS campaign did — resolved to the campaign's whole IDENTITY, exactly as every other
 * campaign-scoped read here does, because a campaign as the customer knows it exists in storage as
 * several rows. `scope=brand` is the roll-up across every campaign of the brand this person is in.
 * The response says which it gave and names the campaigns it asked about; it never silently
 * answers one when asked for the other.
 *
 * **A source that could not answer is stated as unreachable.** Each source carries its own status,
 * one failing degrades only itself, and `complete` is false while anything is missing. Answering
 * an empty list for a source we could not read would tell a customer their prospect said nothing.
 * The one thing that fails the whole read is this service's OWN data being unreadable (500) —
 * there is no history to order without it.
 *
 * **It costs what a page view can afford.** One email-gateway call for the person, one Gmail-mirror
 * call, one recorded-reply call, one recorded-opt-out call, and two per campaign in scope
 * (the messages, the copy we generated) — bounded to a handful of campaigns, six requests in
 * flight, each on its own timeout.
 */
import { Router, Request, Response, NextFunction } from "express";
import { sql } from "../db/index.js";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { toIsoTimestamp } from "../lib/basic-leads.js";
import { checkDeliveryStatus } from "../lib/email-gateway-client.js";
import { flattenCampaignSubsetStatus } from "../lib/delivery-flatten.js";
import type { StatusResult } from "../lib/email-gateway-client.js";
import { resolveCampaignFamily } from "../lib/campaign-identity-client.js";
import {
  fetchOutreachConversation,
  fetchOutreachOptOuts,
  fetchOutreachReplyStatements,
  type SourceRead,
} from "../lib/outreach-client.js";
import { fetchMailboxConversation } from "../lib/mailbox-client.js";
import { fetchGeneratedEmail } from "../lib/generated-email-client.js";
import {
  assembleLeadHistory,
  type HistoryCampaignInput,
  type HistoryStatedNever,
  type HistoryStatedOutcome,
  type HistoryTrackerConversion,
} from "../lib/lead-history.js";

const router = Router();

/** Express 4 ignores an async handler's rejection — an unguarded throw hangs the caller's socket. */
function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How many campaigns one read fans out over. A person is normally in a handful; the bound is what
 * keeps a page view a page view. When it bites, the response SAYS so (`campaignsTruncated`) and
 * `complete` is false — a capped answer must never look like a whole one.
 */
export const MAX_HISTORY_CAMPAIGNS = 8;

/** How many of those fan-out requests are in flight at once. */
const CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

interface HistoryLeadRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  brand_ids: string[];
  email: string | null;
}

interface CampaignRow {
  id: string;
  campaign_id: string;
  brand_ids: string[];
  status: string;
  created_at: Date | string | null;
  served_at: Date | string | null;
  sent_at: Date | string | null;
  followup_due_at: Date | string | null;
  followup_count: number;
  followup_last_action_at: Date | string | null;
  followup_stopped_reason: string | null;
}

/** The one membership row a caller names. `org_id` is the entitlement boundary and sits IN the
 * predicate, so a foreign row is indistinguishable from an absent one. */
async function fetchLeadRow(orgId: string, id: string): Promise<HistoryLeadRow | null> {
  const rows = (await sql`
    SELECT lc.id, lc.lead_id, lc.campaign_id, lc.brand_ids, lower(canonical.value) AS email
    FROM leads_campaigns lc
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = lc.lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) canonical ON true
    WHERE lc.id = ${id} AND lc.org_id = ${orgId}
    LIMIT 1
  `) as unknown as HistoryLeadRow[];
  return rows[0] ?? null;
}

/** Every campaign of this org this PERSON is in — the identity is the person, not one membership. */
async function fetchLeadCampaignRows(orgId: string, leadId: string): Promise<CampaignRow[]> {
  return (await sql`
    SELECT lc.id, lc.campaign_id, lc.brand_ids, lc.status,
           lc.created_at, lc.served_at, lc.sent_at,
           lc.followup_due_at, lc.followup_count, lc.followup_last_action_at,
           lc.followup_stopped_reason
    FROM leads_campaigns lc
    WHERE lc.org_id = ${orgId} AND lc.lead_id = ${leadId}
    ORDER BY lc.created_at DESC NULLS LAST, lc.id DESC
  `) as unknown as CampaignRow[];
}

interface StatementRows {
  outcomes: HistoryStatedOutcome[];
  nevers: HistoryStatedNever[];
  tracker: HistoryTrackerConversion[];
}

/**
 * This service's own record of the person: the outcomes and "never"s somebody STATED, and the
 * outcomes the tracker REPORTED. Filtered exactly as every other read here filters — a withdrawn
 * statement is the absence of one, and a retracted "never" was superseded, so neither is history a
 * consumer should render as standing.
 */
async function fetchOwnStatements(
  orgId: string,
  leadId: string,
  brandId: string,
  leadCampaignIds: string[],
): Promise<StatementRows> {
  const ids = leadCampaignIds;

  const outcomeRows = (await sql`
    SELECT id, event, campaign_id, received_at, value_cents, cost_cents, stated_by_user_id, note
    FROM conversion_events
    WHERE org_id = ${orgId}
      AND brand_id = ${brandId}
      AND source = 'manual'
      AND withdrawn_at IS NULL
      AND lead_campaign_id = ANY(${ids}::uuid[])
  `) as unknown as Array<{
    id: string;
    event: string;
    campaign_id: string | null;
    received_at: Date | string | null;
    value_cents: number | null;
    cost_cents: number | null;
    stated_by_user_id: string | null;
    note: string | null;
  }>;

  const trackerRows = (await sql`
    SELECT id, event, source, received_at, value_cents, match_confidence, attribution_status,
           caused_by_outreach
    FROM conversion_events
    WHERE org_id = ${orgId}
      AND brand_id = ${brandId}
      AND source <> 'manual'
      AND withdrawn_at IS NULL
      AND matched_lead_id = ${leadId}::uuid
  `) as unknown as Array<{
    id: string;
    event: string;
    source: string | null;
    received_at: Date | string | null;
    value_cents: number | null;
    match_confidence: string | null;
    attribution_status: string | null;
    caused_by_outreach: boolean | null;
  }>;

  const neverRows = (await sql`
    SELECT id, step, source, campaign_id, created_at, occurred_at, cost_cents, stated_by_user_id,
           note, crm_evidence->>'crmStep' AS crm_step
    FROM lead_step_disqualifications
    WHERE org_id = ${orgId}
      AND brand_id = ${brandId}
      AND retracted_at IS NULL
      AND withdrawn_at IS NULL
      AND lead_campaign_id = ANY(${ids}::uuid[])
  `) as unknown as Array<{
    id: string;
    step: string;
    source: string | null;
    campaign_id: string | null;
    created_at: Date | string | null;
    occurred_at: Date | string | null;
    crm_step: string | null;
    cost_cents: number | null;
    stated_by_user_id: string | null;
    note: string | null;
  }>;

  return {
    outcomes: outcomeRows.map((row) => ({
      id: row.id,
      step: row.event,
      campaignId: row.campaign_id,
      at: toIsoTimestamp(row.received_at),
      valueCents: row.value_cents,
      costCents: row.cost_cents,
      statedByUserId: row.stated_by_user_id,
      note: row.note,
    })),
    // A "never" a PERSON stated is their statement; one the customer's CRM evidences is not, so it
    // is served beside the other observed outcomes below.
    nevers: neverRows.filter((row) => row.source !== "crm").map((row) => ({
      id: row.id,
      step: row.step,
      campaignId: row.campaign_id,
      at: toIsoTimestamp(row.created_at),
      costCents: row.cost_cents,
      statedByUserId: row.stated_by_user_id,
      note: row.note,
    })),
    tracker: [
      ...trackerRows.map((row) => ({
        id: row.id,
        event: row.event,
        at: toIsoTimestamp(row.received_at),
        valueCents: row.value_cents,
        matchConfidence: row.match_confidence,
        attributionStatus: row.attribution_status,
        observedBy: (row.source === "crm" ? "crm" : "tracker") as "crm" | "tracker",
        causedByOutreach: row.caused_by_outreach,
      })),
      // One per PERSON, not per campaign row: the CRM "never" is written on every row of theirs.
      ...Array.from(
        new Map(
          neverRows
            .filter((row) => row.source === "crm")
            .map((row) => [`${row.step}:${row.crm_step}`, row] as const),
        ).values(),
      ).map((row) => ({
        id: row.id,
        event: row.crm_step ?? row.step,
        at: toIsoTimestamp(row.occurred_at),
        valueCents: null,
        matchConfidence: null,
        attributionStatus: null,
        observedBy: "crm" as const,
      })),
    ],
  };
}

router.get(
  "/orgs/leads/:id/history",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
      return;
    }

    const scopeRaw = typeof req.query.scope === "string" ? req.query.scope : "campaign";
    if (scopeRaw !== "campaign" && scopeRaw !== "brand") {
      res.status(400).json({ error: "scope must be one of: campaign, brand" });
      return;
    }
    const scope: "campaign" | "brand" = scopeRaw;

    const row = await fetchLeadRow(req.orgId!, id);
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    // Which brand this history is about. A caller scoping to a brand it did not list the row under
    // is naming a lead it is not reading in that scope: answer as if it did not exist.
    const brandFromQuery = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
    const brandId = brandFromQuery
      ? row.brand_ids.includes(brandFromQuery)
        ? brandFromQuery
        : null
      : (row.brand_ids[0] ?? null);
    if (!brandId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const ctx = {
      orgId: req.orgId!,
      userId: req.userId ?? null,
      runId: req.runId ?? null,
      brandId,
    };

    const allRows = await fetchLeadCampaignRows(req.orgId!, row.lead_id);

    // A campaign as the customer knows it exists in storage as several rows, so a campaign-scoped
    // read resolves the whole IDENTITY — the same resolution every other campaign-scoped read here
    // does. A resolution that fails falls back to the single named row with a loud log, never to
    // the brand: widening the scope silently would answer a question nobody asked.
    let familyIds: string[] | null = null;
    if (scope === "campaign") {
      familyIds = await resolveCampaignFamily(row.campaign_id, {
        orgId: req.orgId!,
        userId: req.userId ?? null,
        runId: req.runId ?? null,
        brandId,
      });
      if (!familyIds || familyIds.length === 0) familyIds = [row.campaign_id];
    }
    const familySet = familyIds ? new Set(familyIds) : null;

    const inScope = allRows.filter((candidate) =>
      scope === "brand"
        ? candidate.brand_ids.includes(brandId)
        : familySet!.has(candidate.campaign_id),
    );
    const campaignsTruncated = inScope.length > MAX_HISTORY_CAMPAIGNS;
    const selected = inScope.slice(0, MAX_HISTORY_CAMPAIGNS);

    const email = row.email;

    // One delivery call for the person, at brand scope, then read each campaign's own evidence out
    // of the breakdown — never a call per campaign, and never the brand roll-up stamped onto every
    // campaign (that would claim a campaign reached somebody it may have sent nothing).
    let deliveryRead: SourceRead<null> = { ok: true, data: null };
    let statusResult: StatusResult | null = null;
    if (email) {
      try {
        const response = await checkDeliveryStatus(brandId, undefined, [{ email }], {
          orgId: req.orgId!,
          userId: req.userId ?? undefined,
          runId: req.runId ?? undefined,
          brandId,
        });
        statusResult = response.results.find((r) => r.email === email) ?? null;
      } catch (error) {
        deliveryRead = {
          ok: false,
          reason: `email-gateway unreachable: ${(error as Error).message}`,
        };
      }
    } else {
      deliveryRead = {
        ok: false,
        reason: "this lead carries no registered email, so no delivery evidence can be keyed to it",
      };
    }

    // Everything else, in parallel and bounded. A source with no email to ask about answers a
    // stated refusal rather than an empty list.
    const noEmail: SourceRead<never[]> = {
      ok: false,
      reason: "this lead carries no registered email, so this source cannot be asked about it",
    };

    const [mailbox, replyStatements, optOuts, perCampaign, own] = await Promise.all([
      email
        ? fetchMailboxConversation(email, ctx)
        : Promise.resolve(noEmail as unknown as SourceRead<null>),
      email
        ? fetchOutreachReplyStatements(email, ctx)
        : Promise.resolve(noEmail as unknown as SourceRead<never[]>),
      email
        ? fetchOutreachOptOuts(email, ctx)
        : Promise.resolve(noEmail as unknown as SourceRead<never[]>),
      mapWithConcurrency(selected, CONCURRENCY, async (candidate) => {
        const [conversation, generation] = await Promise.all([
          email
            ? fetchOutreachConversation(candidate.campaign_id, email, ctx)
            : Promise.resolve(noEmail as unknown as SourceRead<null>),
          fetchGeneratedEmail(row.lead_id, candidate.campaign_id, ctx),
        ]);
        return { candidate, conversation, generation };
      }),
      fetchOwnStatements(
        req.orgId!,
        row.lead_id,
        brandId,
        selected.map((candidate) => candidate.id),
      ),
    ]);

    const campaigns: HistoryCampaignInput[] = perCampaign.map(
      ({ candidate, conversation, generation }) => ({
        leadCampaignId: candidate.id,
        campaignId: candidate.campaign_id,
        status: candidate.status,
        createdAt: toIsoTimestamp(candidate.created_at),
        servedAt: toIsoTimestamp(candidate.served_at),
        sentAt: toIsoTimestamp(candidate.sent_at),
        followupDueAt: toIsoTimestamp(candidate.followup_due_at),
        followupCount: Number(candidate.followup_count ?? 0),
        followupLastActionAt: toIsoTimestamp(candidate.followup_last_action_at),
        followupStoppedReason: candidate.followup_stopped_reason,
        delivery: statusResult
          ? flattenCampaignSubsetStatus(statusResult, new Set([candidate.campaign_id]))
          : null,
        conversation,
        generation,
      }),
    );

    const assembled = assembleLeadHistory({
      email,
      campaigns,
      deliveryRead,
      mailbox,
      replyStatements,
      optOuts,
      statedOutcomes: own.outcomes,
      statedNevers: own.nevers,
      trackerConversions: own.tracker,
    });

    res.json({
      leadCampaignId: row.id,
      leadId: row.lead_id,
      campaignId: row.campaign_id,
      brandId,
      email,
      scope,
      campaignIds: selected.map((candidate) => candidate.campaign_id),
      campaignsTruncated,
      complete: assembled.complete && !campaignsTruncated,
      sources: assembled.sources,
      events: assembled.events,
    });
  }),
);

export default router;
