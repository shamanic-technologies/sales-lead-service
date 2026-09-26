import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { supersedeCrmOutcome } from "../lib/crm-evidence-store.js";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { toIsoTimestamp } from "../lib/basic-leads.js";
import {
  LEAD_STEP_OUTCOMES,
  WEBSITE_VISIT,
  canonicalizeStepOutcome,
  manualOutcomeSignature,
  statementSourceOf,
  type LeadStepOutcomeName,
  type StatementSource,
  type StepState,
} from "../lib/step-statements.js";
import {
  MeasuredVisitLookupError,
  fetchMeasuredVisitEmails,
} from "../lib/measured-visits.js";
import { stepsOnlyThrough, stepsRequiredBefore } from "../lib/step-graph.js";
import {
  resolveStepStates,
  type StatedNever,
  type StatedOutcome,
} from "../lib/step-states.js";
import { readBrandColdLeads, readLeadRowCold } from "../lib/lead-cold-read.js";
import { EvidenceUnavailableError } from "../lib/lead-delivery-evidence.js";
import { COLD_AFTER_DAYS, type ColdStep } from "../lib/lead-cold.js";

const router = Router();

// Express 4 does not forward async handler rejections to the error middleware — an unguarded
// throw hangs the caller's socket instead of answering. Wrap so a DB error is a clean 500.
function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

/** `leads_campaigns.id` is a uuid column, so anything else is a caller error, not a miss. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const StepStatementBodySchema = z.object({
  step: z.string(),
  kind: z.enum(["outcome", "never"]),
  valueCents: z.number().int().optional(),
  costCents: z.number().int().optional(),
  causedByOutreach: z.boolean().optional(),
  note: z.string().optional(),
  occurredAt: z.string().optional(),
});

interface LeadRow {
  id: string;
  lead_id: string;
  campaign_id: string;
  brand_ids: string[];
  /** The lead's canonical (primary) email — the identity delivery evidence is keyed on. */
  email: string | null;
}

/**
 * The ONE membership row a caller names, or null. `org_id` is the entitlement boundary and sits
 * IN the predicate, so a row belonging to another org is indistinguishable from one that does
 * not exist — never a check afterwards.
 */
async function fetchLeadRow(orgId: string, id: string): Promise<LeadRow | null> {
  const rows = (await db.execute(sql`
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
  `)) as unknown as LeadRow[];
  return rows[0] ?? null;
}

/**
 * Which brand the statement is about. A caller scoping to a brand it did not list the row under
 * is naming a lead it is not reading in that scope: answer exactly as if the row did not exist
 * rather than leaking its existence. Unscoped, the row's own primary brand answers.
 *
 * The scope is read from `?brandId=` — the same query parameter `GET /orgs/leads/:id` takes, so a
 * panel passes back exactly what it listed with — and from the `x-brand-id` identity header when
 * the caller carries one instead.
 */
function resolveBrandId(row: LeadRow, req: AuthenticatedRequest): string | null {
  const fromQuery = typeof req.query.brandId === "string" ? req.query.brandId : undefined;
  const requested = fromQuery ? [fromQuery] : (req.brandIds ?? []);
  if (requested.length > 0) return requested.find((b) => row.brand_ids.includes(b)) ?? null;
  return row.brand_ids[0] ?? null;
}


/**
 * Has the DELIVERY LAYER already measured this lead's visit (a click on the email we sent) for
 * this brand? email-gateway owns that evidence and nothing here changes it; this is a read.
 *
 * It is what keeps the panel coherent with the counts: a visit the delivery layer measured shows
 * as an outcome the tracker reported, so nobody is invited to state a fact the system already
 * holds, and stating "never happened" about a visit that demonstrably happened is refused.
 * A lead with no registered email can carry no delivery evidence — false, never a guess.
 */
async function visitAlreadyMeasured(
  row: LeadRow,
  brandId: string,
  orgId: string,
): Promise<boolean> {
  if (!row.email) return false;
  const measured = await fetchMeasuredVisitEmails(brandId, orgId, [row.email]);
  return measured.has(row.email);
}

/** A measured-visit lookup that could not be answered is a 502, never a silent "not measured". */
function respondMeasuredVisitFailure(error: unknown, res: Response): boolean {
  if (!(error instanceof MeasuredVisitLookupError)) return false;
  console.error(error.message);
  res.status(502).json({
    error:
      "email-gateway could not say whether this lead's website visit was already measured. " +
      "No answer is returned rather than one that could contradict the counts.",
  });
  return true;
}

/**
 * POST /orgs/leads/:id/step-statements
 *
 * A HUMAN states what happened to ONE lead at ONE step — or that
 * it never will. Organisation-authenticated (the customer dashboard and the staff console are
 * both org-authenticated callers); the publishable website-tracker token is deliberately NOT a
 * door to this: it is write-only, brand-scoped, and meant for a third party's page.
 *
 * `:id` is the id a list row already carries (the `leads_campaigns` membership row), so the
 * caller re-supplies no identity for a lead it has already resolved, there is nothing to match
 * and nothing to guess — which is exactly what repairs the ~90% unmatched rate the tracker's
 * identity waterfall carries for hand-stated facts. It also fixes the campaign: the row belongs
 * to one, so the statement is attributable to the campaign it was made on, not only to the brand.
 *
 * `kind: "outcome"` writes a conversion_events row tagged `source = 'manual'` — the ledger every
 * consumer already counts, so the brand's outcome counts move on the next read with nothing
 * downstream changed, and `source` keeps it distinguishable from a tracker-reported one.
 * Restating the same step corrects the first statement rather than counting twice.
 *
 * `kind: "never"` is NOT an outcome and nothing counts it: it writes a lead_step_disqualifications
 * row, a table no count reads. It is what lets a consumer tell a lead that is DEAD at a step from
 * one still PENDING.
 *
 * The two are mutually exclusive per step, and the contradiction is resolved in the only direction
 * that can be true: stating an outcome for a step previously marked "never" RETRACTS the never
 * (people change their mind and buy), and the response says so. Marking "never" on a step that
 * already has an outcome is refused (409) — a step that already happened cannot never happen.
 */
router.post(
  "/orgs/leads/:id/step-statements",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
      return;
    }

    const parsed = StepStatementBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid body: step and kind are required" });
      return;
    }
    const body = parsed.data;

    const step = canonicalizeStepOutcome(body.step);
    if (!step) {
      res.status(400).json({ error: `step must be one of ${LEAD_STEP_OUTCOMES.join(" | ")}` });
      return;
    }

    // A "never" is not an outcome, so it can carry no value. Refused rather than dropped: a
    // silently-ignored amount reads to the caller as recorded revenue that nothing will ever show.
    if (body.kind === "never" && body.valueCents !== undefined) {
      res.status(400).json({ error: "valueCents is not accepted on a \"never\" statement" });
      return;
    }

    // WHOSE win it was is a fact about something that HAPPENED, so a "never" cannot carry it.
    // Refused rather than dropped, for the same reason a value is: a silently-ignored answer reads
    // to the caller as recorded, and nothing would ever show it.
    if (body.kind === "never" && body.causedByOutreach !== undefined) {
      res.status(400).json({
        error: "causedByOutreach is not accepted on a \"never\" statement",
      });
      return;
    }

    // A stated SALE must say what it was worth. It is the one place in the whole system where
    // estimating has no excuse: with no value, every downstream money figure — pipeline, ROI,
    // cost per acquisition — prices the deal at the brand's AVERAGE lifetime revenue, a number
    // that describes no real customer, and does it silently. Every OTHER step stays optional: an
    // unusually large lead is worth stating early, long before it closes.
    if (body.kind === "outcome" && step === "sale" && body.valueCents === undefined) {
      res.status(400).json({
        error:
          "valueCents is required on a \"sale\" outcome — a won deal states what it was worth, " +
          "it is never estimated",
      });
      return;
    }

    // WHAT THIS LEG COST THE CUSTOMER, and stating it is mandatory.
    //
    // The platform automates the first leg; the customer performs the rest —
    // they run the meeting, they close the deal — so they are the only one who knows what that
    // leg cost. Without it a cost of acquisition counts only the leg we billed for, and
    // every return displayed on it is too good.
    //
    // ABSENT IS A REFUSAL, NEVER A ZERO. Defaulting it would silently answer a question nobody
    // was asked, and the answer would be indistinguishable from a real "it cost me nothing" — so
    // the author has to choose, and zero is a legitimate choice that reads back as a stated zero.
    // A "never" carries one too: a dead leg still cost something (the meeting was run, the call
    // was taken), and a cost of acquisition that ignores it is too good for the same reason.
    //
    // This money is the CUSTOMER'S. It is recorded because they told us; it is never charged to
    // them, no runs-service cost is declared for it and nothing about it reaches the platform's
    // own spend ledger.
    if (body.costCents === undefined) {
      res.status(400).json({
        error:
          "costCents is required — state what this step cost you, in cents. Zero is a legitimate " +
          "answer and is recorded as a stated zero; leaving it out is not, because an absent cost " +
          "would be indistinguishable from a stated zero and would make the cost of " +
          "acquisition read better than it is. This is your money, never charged to you.",
        code: "cost_required",
      });
      return;
    }
    if (body.costCents < 0) {
      res.status(400).json({ error: "costCents must be zero or more" });
      return;
    }
    const costCents = body.costCents;

    // The moment the outcome happened, when the caller states a past fact. Bound as an ISO string
    // (a raw `sql` template hands params straight to postgres.js Bind, which cannot serialize a
    // Date), and rejected outright when unparseable — never silently replaced by now().
    let occurredAtIso: string | null = null;
    if (body.occurredAt !== undefined) {
      const parsedDate = new Date(body.occurredAt);
      if (Number.isNaN(parsedDate.getTime())) {
        res.status(400).json({ error: "occurredAt must be an ISO-8601 timestamp" });
        return;
      }
      occurredAtIso = parsedDate.toISOString();
    }

    const row = await fetchLeadRow(req.orgId!, id);
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const brandId = resolveBrandId(row, req);
    if (!brandId) {
      // Either the caller scoped to a brand this row is not part of (indistinguishable from an
      // absent row, deliberately), or the row carries no brand at all and there is nothing to
      // attribute the statement to. Both fail loud.
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    // A statement is only coherent against the leg graph (step-graph.ts): a "never" constrains
    // every step that can only be reached THROUGH it, an outcome every step that EVERY path to it
    // goes through.
    const nowIso = new Date().toISOString();
    const statedBy = req.userId ?? null;

    if (body.kind === "never") {
      // Everything this "never" would also make never: the step itself and every step that can only
      // be reached through it. An outcome standing on ANY of them contradicts the statement — a lead
      // that attended cannot never have booked — so the refusal that already guarded the step
      // itself guards the whole forward slice, which is what stops the two directions disagreeing
      // when statements arrive in the other order.
      const blockedBy = [step, ...stepsOnlyThrough(step)];

      // A visit the delivery layer already measured HAPPENED, whatever a person types about it.
      // Same refusal as an outcome already on the ledger, for the same reason.
      if (blockedBy.includes(WEBSITE_VISIT)) {
        let measured: boolean;
        try {
          measured = await visitAlreadyMeasured(row, brandId, req.orgId!);
        } catch (error) {
          if (respondMeasuredVisitFailure(error, res)) return;
          throw error;
        }
        if (measured) {
          res.status(409).json({
            error:
              step === WEBSITE_VISIT
                ? "website_visit was already measured for this lead (a click on the email we sent) " +
                  "— it cannot be stated as never"
                : `website_visit was already measured for this lead and can only be reached through ` +
                  `${step}, so ${step} cannot be stated as never`,
            code: "step_already_happened",
          });
          return;
        }
      }

      // Exactly the outcomes the READ answers with for this lead: a hand-stated one is keyed to
      // the row it was stated on, a tracker-reported one knows only the brand. Asking a narrower
      // question here than the read asks is how the panel and the write path come to disagree.
      const existingOutcome = (await db.execute(sql`
        SELECT event
        FROM conversion_events
        WHERE brand_id = ${brandId}
          AND matched_lead_id = ${row.lead_id}
          AND attribution_status = 'attributed'
          AND withdrawn_at IS NULL
          AND (lead_campaign_id IS NULL OR lead_campaign_id = ${row.id})
          AND event = ANY(${sql.param(blockedBy)}::text[])
        LIMIT 1
      `)) as unknown as Array<{ event: string }>;
      if (existingOutcome.length > 0) {
        const happened = existingOutcome[0].event;
        res.status(409).json({
          error:
            happened === step
              ? `${step} already happened for this lead — it cannot be stated as never`
              : `${happened} already happened for this lead and can only be reached through ` +
                `${step}, so ${step} cannot be stated as never`,
          code: "step_already_happened",
        });
        return;
      }

      const inserted = (await db.execute(sql`
        INSERT INTO lead_step_disqualifications (
          lead_id, lead_campaign_id, campaign_id, brand_id, org_id, step, cost_cents, note,
          stated_by_user_id
        ) VALUES (
          ${row.lead_id}, ${row.id}, ${row.campaign_id}, ${brandId}, ${req.orgId!}, ${step},
          ${costCents}, ${body.note ?? null}, ${statedBy}
        )
        ON CONFLICT (lead_id, campaign_id, step) DO UPDATE SET
          -- A person stating "never" on a step their CRM also evidences as dead makes it THEIR
          -- statement: a person outranks the CRM, and only a person's statement is withdrawable.
          source = 'manual',
          occurred_at = NULL,
          crm_evidence = NULL,
          cost_cents = EXCLUDED.cost_cents,
          note = EXCLUDED.note,
          stated_by_user_id = EXCLUDED.stated_by_user_id,
          lead_campaign_id = EXCLUDED.lead_campaign_id,
          brand_id = EXCLUDED.brand_id,
          -- Restating a "never" that was retracted by an outcome makes it live again: the person
          -- changed their mind again, and the row is the same statement, restated.
          retracted_at = NULL,
          retracted_by_step = NULL,
          retracted_by_user_id = NULL,
          -- Restating a statement its author had WITHDRAWN makes it live again: the withdrawal
          -- said "I never should have stated this", and this is them stating it after all.
          withdrawn_at = NULL,
          withdrawn_by_user_id = NULL,
          updated_at = now()
        RETURNING id, cost_cents, created_at, updated_at
      `)) as unknown as Array<{ id: string; created_at: Date | string; updated_at: Date | string }>;

      res.status(201).json({
        statement: {
          id: inserted[0].id,
          leadCampaignId: row.id,
          leadId: row.lead_id,
          campaignId: row.campaign_id,
          brandId,
          step,
          kind: "never",
          // A "never" has no source: nothing observes it, a person states it. Counted by nothing.
          source: "manual" as StatementSource,
          valueCents: null,
          // A "never" is not something that happened, so there is nothing for a cause to be about.
          causedByOutreach: null,
          costCents,
          note: body.note ?? null,
          statedByUserId: statedBy,
          statedAt: toIsoTimestamp(inserted[0].updated_at),
        },
      });
      return;
    }

    // An outcome supersedes a "never" for the same step — the person did the thing after all — and
    // for every step EVERY path to it goes through: a lead that attended necessarily booked, so a
    // "never" standing on any of them is contradicted by the fact.
    //
    // The row is MARKED retracted, never deleted: what somebody actually stated is the thing that
    // makes this auditable, and it must survive being superseded. Every read filters it out, so
    // nothing counts it and nothing shows it as live.
    const supersedes = [...stepsRequiredBefore(step), step];
    const retracted = (await db.execute(sql`
      UPDATE lead_step_disqualifications
      SET retracted_at = now(),
          retracted_by_step = ${step},
          retracted_by_user_id = ${statedBy},
          updated_at = now()
      WHERE lead_id = ${row.lead_id}
        AND campaign_id = ${row.campaign_id}
        AND step = ANY(${sql.param(supersedes)}::text[])
        AND retracted_at IS NULL
        AND withdrawn_at IS NULL
      RETURNING step
    `)) as unknown as Array<{ step: string }>;

    // Written into conversion_events — the ledger the counts already read — so a hand-stated
    // outcome moves the brand's numbers with no consumer change. match_* records how the identity
    // was established: the caller NAMED the lead, which is as deterministic as identity gets.
    const inserted = (await db.execute(sql`
      INSERT INTO conversion_events (
        brand_id, org_id, event, dedupe_signature, value_cents, cost_cents, caused_by_outreach,
        stated_caused_by_outreach, matched_lead_id, match_method, match_confidence,
        attribution_status, candidate_count, received_at, source, campaign_id, lead_campaign_id,
        stated_by_user_id, note
      ) VALUES (
        ${brandId}, ${req.orgId!}, ${step}, ${manualOutcomeSignature(row.id, step)},
        ${body.valueCents ?? null}, ${costCents}, ${body.causedByOutreach ?? null},
        ${body.causedByOutreach ?? null},
        ${row.lead_id}, 'manual', 'deterministic',
        'attributed', 1, ${occurredAtIso ?? nowIso}, 'manual', ${row.campaign_id}, ${row.id},
        ${statedBy}, ${body.note ?? null}
      )
      ON CONFLICT (brand_id, dedupe_signature) WHERE dedupe_signature IS NOT NULL DO UPDATE SET
        value_cents = EXCLUDED.value_cents,
        cost_cents = EXCLUDED.cost_cents,
        -- A restatement REPLACES the statement, exactly as it replaces the value and the note: it
        -- is the same person saying the thing again, and what they say now is what stands. So
        -- restating without naming a cause returns the outcome to the owner's date RULE rather than
        -- quietly keeping an answer the author did not repeat (outcome-cause.ts). The rule's
        -- stored answer still stands when the date did not move; a moved date drops it, and the
        -- worker answers again within one interval.
        stated_caused_by_outreach = EXCLUDED.stated_caused_by_outreach,
        caused_by_outreach = COALESCE(
          EXCLUDED.stated_caused_by_outreach,
          CASE WHEN conversion_events.received_at IS NOT DISTINCT FROM EXCLUDED.received_at
               THEN (conversion_events.cause_rule->>'causedByOutreach')::boolean END
        ),
        cause_rule = CASE WHEN conversion_events.received_at IS NOT DISTINCT FROM EXCLUDED.received_at
                          THEN conversion_events.cause_rule END,
        note = EXCLUDED.note,
        received_at = EXCLUDED.received_at,
        stated_by_user_id = EXCLUDED.stated_by_user_id,
        campaign_id = EXCLUDED.campaign_id,
        -- Restating a withdrawn outcome revives the same row: the withdrawal is the absence of a
        -- statement, and this is the statement being made again.
        withdrawn_at = NULL,
        withdrawn_by_user_id = NULL
      RETURNING id, received_at
    `)) as unknown as Array<{ id: string; received_at: Date | string }>;

    // A person stating a step outranks what their CRM evidences for it, and the two must not both
    // count: the ledger counts ROWS, so a CRM-evidenced outcome on the same person and step would
    // make one deal read as two. It is set aside (never deleted); the CRM sync stands it back up if
    // this statement is later withdrawn.
    await supersedeCrmOutcome(brandId, row.lead_id, step);

    res.status(201).json({
      statement: {
        id: inserted[0].id,
        leadCampaignId: row.id,
        leadId: row.lead_id,
        campaignId: row.campaign_id,
        brandId,
        step,
        kind: "outcome",
        source: "manual" as StatementSource,
        valueCents: body.valueCents ?? null,
        // WHOSE win it was, echoed back. null is "nobody was asked", never "not us".
        causedByOutreach: body.causedByOutreach ?? null,
        costCents,
        note: body.note ?? null,
        statedByUserId: statedBy,
        statedAt: toIsoTimestamp(inserted[0].received_at),
      },
      // Kept as a boolean for the callers that already read it; the steps say WHICH statements the
      // outcome superseded, including the earlier ones every path to it goes through.
      retractedNever: retracted.length > 0,
      retractedNeverSteps: retracted.map((r) => r.step),
    });
  }),
);

/**
 * What every step of this lead reads as, right now: the live statements (an outcome on the
 * ledger, a "never" on its own table) plus what the delivery layer measured, with the leg graph's
 * two rules applied on READ.
 *
 * Shared by the read and the withdrawal, deliberately: a withdrawal answers with the step states
 * that FOLLOW from it, and computing them a second way is how two surfaces come to disagree about
 * the same lead. Nothing is written here; a statement that was retracted or withdrawn is filtered
 * out at the source, so everything it implied falls away with it automatically.
 *
 * Throws MeasuredVisitLookupError when email-gateway cannot answer — the caller turns that into a
 * 502, never a guessed step state.
 */
async function loadStepStates(
  row: LeadRow,
  brandId: string,
  orgId: string,
) {
  // Outcomes credited to this person for this brand. A hand-stated one is keyed to the row it
  // was stated on; a tracker-reported one knows only the brand, so it is matched on the lead.
  const outcomeRows = (await db.execute(sql`
    SELECT event, source, value_cents, cost_cents, caused_by_outreach, note, stated_by_user_id,
           received_at
    FROM conversion_events
    WHERE brand_id = ${brandId}
      AND matched_lead_id = ${row.lead_id}
      AND attribution_status = 'attributed'
      AND withdrawn_at IS NULL
      AND (lead_campaign_id IS NULL OR lead_campaign_id = ${row.id})
    -- What the customer's CRM evidences answers a step only when nobody and nothing else of ours
    -- did: a person's statement and the tracker's report come first.
    ORDER BY (source = 'crm') ASC, received_at DESC NULLS LAST
  `)) as unknown as Array<{
    event: string;
    source: string;
    value_cents: number | null;
    cost_cents: number | null;
    caused_by_outreach: boolean | null;
    note: string | null;
    stated_by_user_id: string | null;
    received_at: Date | string | null;
  }>;

  // Retracted statements are excluded: they are kept for the record, not to be read as live.
  const neverRows = (await db.execute(sql`
    SELECT step, source, cost_cents, note, stated_by_user_id,
           -- A CRM "never" is dated by the CRM or not at all — never by when we synced it.
           CASE WHEN source = 'crm' THEN occurred_at ELSE updated_at END AS updated_at
    FROM lead_step_disqualifications
    WHERE lead_id = ${row.lead_id}
      AND campaign_id = ${row.campaign_id}
      AND retracted_at IS NULL
      AND withdrawn_at IS NULL
  `)) as unknown as Array<{
    step: string;
    source: string | null;
    cost_cents: number | null;
    note: string | null;
    stated_by_user_id: string | null;
    updated_at: Date | string | null;
  }>;

  // Rows arrive newest first, so the first one seen for a step is the one that answers.
  const outcomes = new Map<LeadStepOutcomeName, StatedOutcome>();
  for (const o of outcomeRows) {
    const step = canonicalizeStepOutcome(o.event);
    if (!step || outcomes.has(step)) continue;
    outcomes.set(step, {
      source: statementSourceOf(o.source),
      valueCents: o.value_cents,
      // Null is "nobody was ever asked" — a tracker event observes a page load and knows nothing
      // about the customer's spend, and a statement predating the mandatory cost carries none.
      // 0 is a stated zero. Never conflated.
      costCents: o.cost_cents,
      // WHOSE win it was. Null is "nobody was asked" — never "not us", and never "us".
      causedByOutreach: o.caused_by_outreach,
      note: o.note,
      statedByUserId: o.stated_by_user_id,
      at: toIsoTimestamp(o.received_at),
    });
  }

  const nevers = new Map<LeadStepOutcomeName, StatedNever>();
  for (const n of neverRows) {
    const step = canonicalizeStepOutcome(n.step);
    if (!step) continue;
    nevers.set(step, {
      source: n.source === "crm" ? "crm" : "manual",
      costCents: n.cost_cents,
      note: n.note,
      statedByUserId: n.stated_by_user_id,
      at: toIsoTimestamp(n.updated_at),
    });
  }

  // The website visit is the one step that is ALSO measured automatically — a click on the email
  // we sent, owned by the delivery layer. A hand-stated visit is written like any other outcome
  // (and read above); a MEASURED one is not in this ledger at all, so it is read where it lives.
  // Without this the panel would offer to state a visit the system already knows about, and the
  // count (which suppresses the hand-stated duplicate) would disagree with what the panel shows.
  // A hand statement already on the row wins the display — it is the more specific fact, and it
  // carries the note and the date the person gave.
  if (!outcomes.has(WEBSITE_VISIT)) {
    // Throws on an unanswerable lookup; the caller answers 502 rather than guessing.
    const measured = await visitAlreadyMeasured(row, brandId, orgId);
    if (measured) {
      outcomes.set(WEBSITE_VISIT, {
        source: "tracker",
        valueCents: null,
        // The delivery layer measured a click. It knows nothing about what the customer spent,
        // so nobody was asked: null, never a fabricated zero.
        costCents: null,
        // Nor does it know WHY: a measured click is not somebody stating what caused anything.
        causedByOutreach: null,
        note: null,
        statedByUserId: null,
        at: null,
      });
    }
  }

  return resolveStepStates({
    allSteps: LEAD_STEP_OUTCOMES,
    outcomes,
    nevers,
  });
}

/**
 * GET /orgs/leads/:id/step-statements
 *
 * What is known about EVERY step of this lead, so a panel can state each one by hand and read back
 * what it stated — with the leg graph's two rules already applied (step-graph.ts), because no two
 * surfaces may show a lead as dead at one step and alive at a step only reachable through it.
 *
 * One entry per step of the outcome vocabulary, always all of them:
 *
 *   outcome — it happened. Either because somebody stated it (or the tracker reported it), or
 *             because a step only reachable THROUGH it did: a lead that attended a meeting booked
 *             one.
 *   never   — it will not happen. Either stated, or implied by a never on a step every path to it
 *             goes through: a lead that will never book will never attend. Nothing counts either.
 *   pending — nobody spoke and neither rule reaches it. The honest "still on its way".
 *
 * `origin` is what tells a reader a step somebody STATED from one the graph IMPLIES, and an implied
 * step carries no author, no note and no date because nobody made that statement. `statedState`
 * keeps what a person really said readable even where the graph concluded otherwise, so a real
 * statement is never lost. Because implication is computed on READ from the live statements,
 * retracting or superseding one moves everything it implied with it, automatically.
 *
 * The order is the LEGS' and nothing else: no campaign-service read is needed to answer, and a lead
 * on a campaign stating no leg reads exactly like any other.
 */
router.get(
  "/orgs/leads/:id/step-statements",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
      return;
    }

    const row = await fetchLeadRow(req.orgId!, id);
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const brandId = resolveBrandId(row, req);
    if (!brandId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    let steps;
    try {
      steps = await loadStepStates(row, brandId, req.orgId!);
    } catch (error) {
      if (respondMeasuredVisitFailure(error, res)) return;
      throw error;
    }

    // Whether the lead WENT COLD at a step (lead-cold.ts). Derived by the SAME resolver the Leads
    // board reads its standing from; a step's `state` is untouched by it.
    let cold;
    try {
      cold = await readLeadRowCold(
        {
          id: row.id,
          leadId: row.lead_id,
          campaignId: row.campaign_id,
          brandIds: row.brand_ids,
          email: row.email,
        },
        req.orgId!,
        brandId,
      );
    } catch (error) {
      console.error(`[step-statements] could not derive whether lead row ${row.id} went cold: ${error}`);
      res.status(502).json({
        error:
          "The delivery layer could not say when this lead replied, so whether it went cold is " +
          "unknown. No answer is returned rather than one that could contradict the board.",
        code: "cold_unresolvable",
      });
      return;
    }

    res.json({
      leadCampaignId: row.id,
      leadId: row.lead_id,
      campaignId: row.campaign_id,
      brandId,
      steps,
      wentCold: cold.wentCold,
      coldRule: {
        afterDays: COLD_AFTER_DAYS,
        applies: cold.eligibility.eligible,
        reason: cold.eligibility.reason,
      },
    });
  }),
);

/**
 * DELETE /orgs/leads/:id/step-statements/:step
 *
 * TAKE BACK a statement somebody made by hand about one step of one lead. Wrong lead, wrong step,
 * a reply read the wrong way round: until this existed the only correction on offer was stating
 * the opposite thing, which is itself a false statement and one that keeps counting.
 *
 * A withdrawal is NOT a third kind of statement — there is nothing new for a consumer to learn to
 * count. It is the ABSENCE of one: the row is marked withdrawn, every read already filters it out
 * alongside a retracted one, so the brand's outcome counts drop it, the cost the customer stated
 * for that leg stops counting as their spend, and the step reads exactly as it did before anybody
 * spoke. Because the leg graph's rules are computed on READ, everything the withdrawn statement
 * implied falls away with it — a step that only read as reached, or as dead, because of it falls
 * back to whatever the remaining statements imply. The response carries the re-derived steps, so a
 * caller never has to guess what its withdrawal did.
 *
 * NOTHING IS DELETED. What somebody actually stated, and the fact that they later withdrew it,
 * both stay readable — the same posture retraction already takes. The two are different facts and
 * stay apart: a RETRACTION is the graph resolving a contradiction (an outcome proved the "never"
 * wrong), a WITHDRAWAL is the author saying it should never have been stated. Withdrawing an
 * outcome therefore also un-retracts the "never"s that outcome retracted — those statements were
 * only superseded because of a statement that is now gone — while leaving any that were withdrawn
 * on their own account alone.
 *
 * ONLY A STATEMENT A PERSON MADE IS WITHDRAWABLE, and the refusals say which is which:
 *   409 not_a_statement — the step reads as an outcome because the TRACKER reported it or the
 *                         delivery layer MEASURED it. Nobody stated it; there is nothing to take
 *                         back, and this service does not edit what another system observed.
 *   409 nothing_stated  — nobody stated this step at all. It may still READ as reached or as dead
 *                         because the graph implies it from a statement on ANOTHER step: withdraw
 *                         that one. `state` / `origin` in the body say which case it is.
 * Both are distinguishable from a 500 by carrying a `code`.
 *
 * IDEMPOTENT: withdrawing a statement already withdrawn answers 200 with
 * `alreadyWithdrawn: true` and writes nothing.
 */
router.delete(
  "/orgs/leads/:id/step-statements/:step",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const id = req.params.id;
    if (!UUID_RE.test(id)) {
      res.status(400).json({ error: "id must be the `id` of a lead row, a uuid" });
      return;
    }

    const step = canonicalizeStepOutcome(req.params.step);
    if (!step) {
      res.status(400).json({ error: `step must be one of ${LEAD_STEP_OUTCOMES.join(" | ")}` });
      return;
    }

    const row = await fetchLeadRow(req.orgId!, id);
    if (!row) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }
    const brandId = resolveBrandId(row, req);
    if (!brandId) {
      res.status(404).json({ error: "Lead not found" });
      return;
    }

    const withdrawnBy = req.userId ?? null;

    // The live HAND statements for this step, and only the hand ones: `source = 'manual'` on the
    // outcome side is what keeps a tracker-reported event out of reach of a withdrawal.
    const liveOutcome = (await db.execute(sql`
      SELECT id
      FROM conversion_events
      WHERE brand_id = ${brandId}
        AND matched_lead_id = ${row.lead_id}
        AND event = ${step}
        AND source = 'manual'
        AND attribution_status = 'attributed'
        AND withdrawn_at IS NULL
        AND (lead_campaign_id IS NULL OR lead_campaign_id = ${row.id})
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;

    const liveNever = (await db.execute(sql`
      SELECT id
      FROM lead_step_disqualifications
      WHERE lead_id = ${row.lead_id}
        AND campaign_id = ${row.campaign_id}
        AND step = ${step}
        -- Only a person's "never". One the customer's CRM evidences is not a statement.
        AND source = 'manual'
        AND retracted_at IS NULL
        AND withdrawn_at IS NULL
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;

    const kind: "outcome" | "never" | null =
      liveOutcome.length > 0 ? "outcome" : liveNever.length > 0 ? "never" : null;

    // Nothing live to withdraw: say WHY, and never as a 500. Either somebody already withdrew it
    // (idempotent success), or what makes the step read as it does is not a statement at all.
    if (!kind) {
      const alreadyWithdrawn = (await db.execute(sql`
        SELECT 1 AS hit
        FROM conversion_events
        WHERE brand_id = ${brandId}
          AND matched_lead_id = ${row.lead_id}
          AND event = ${step}
          AND source = 'manual'
          AND withdrawn_at IS NOT NULL
          AND (lead_campaign_id IS NULL OR lead_campaign_id = ${row.id})
        UNION ALL
        SELECT 1 AS hit
        FROM lead_step_disqualifications
        WHERE lead_id = ${row.lead_id}
          AND campaign_id = ${row.campaign_id}
          AND step = ${step}
          AND source = 'manual'
          AND withdrawn_at IS NOT NULL
        LIMIT 1
      `)) as unknown as Array<{ hit: number }>;

      let steps;
      try {
        steps = await loadStepStates(row, brandId, req.orgId!);
      } catch (error) {
        if (respondMeasuredVisitFailure(error, res)) return;
        throw error;
      }
      const current = steps.find((s) => s.step === step)!;

      if (alreadyWithdrawn.length > 0) {
        res.json({
          leadCampaignId: row.id,
          leadId: row.lead_id,
          campaignId: row.campaign_id,
          brandId,
          step,
          withdrawn: false,
          alreadyWithdrawn: true,
          restoredNeverSteps: [],
          steps,
        });
        return;
      }

      // A step that reads as stated with nothing hand-stated behind it was reported by the
      // tracker, measured by the delivery layer, or evidenced by the customer's own CRM. None of
      // them is anybody's statement.
      const observed = current.origin === "stated" && current.source !== "manual";
      res.status(409).json({
        error: observed
          ? current.source === "crm"
            ? `${step} is evidenced by your own CRM for this lead, not stated by a person — there ` +
              "is no statement to withdraw. If this CRM contact is not this lead, reject the " +
              "pairing; otherwise state the step yourself, which takes precedence."
            : `${step} was reported by the website tracker or measured by the delivery layer for ` +
              "this lead, not stated by a person — there is no statement to withdraw, and what " +
              "another system observed is not edited here."
          : `Nobody has stated ${step} for this lead, so there is nothing to withdraw.` +
            (current.origin === "implied"
              ? ` It reads as "${current.state}" because ${current.impliedBy} was stated and this ` +
                "leg graph implies it — withdraw that statement instead."
              : ""),
        code: observed ? "not_a_statement" : "nothing_stated",
        state: current.state,
        origin: current.origin,
        impliedBy: current.impliedBy,
      });
      return;
    }

    let restoredNeverSteps: string[] = [];

    if (kind === "outcome") {
      await db.execute(sql`
        UPDATE conversion_events
        SET withdrawn_at = now(),
            withdrawn_by_user_id = ${withdrawnBy}
        WHERE id = ${liveOutcome[0].id}
          AND withdrawn_at IS NULL
      `);

      // The "never"s this outcome retracted were superseded by a statement that no longer stands,
      // so they stand again. One a person withdrew on its own account stays withdrawn: that was
      // their decision, not a consequence of this one.
      const restored = (await db.execute(sql`
        UPDATE lead_step_disqualifications
        SET retracted_at = NULL,
            retracted_by_step = NULL,
            retracted_by_user_id = NULL,
            updated_at = now()
        WHERE lead_id = ${row.lead_id}
          AND campaign_id = ${row.campaign_id}
          AND retracted_by_step = ${step}
          AND retracted_at IS NOT NULL
          AND withdrawn_at IS NULL
        RETURNING step
      `)) as unknown as Array<{ step: string }>;
      restoredNeverSteps = restored.map((r) => r.step);
    } else {
      await db.execute(sql`
        UPDATE lead_step_disqualifications
        SET withdrawn_at = now(),
            withdrawn_by_user_id = ${withdrawnBy},
            updated_at = now()
        WHERE id = ${liveNever[0].id}
          AND withdrawn_at IS NULL
      `);
    }

    // What the lead reads as NOW. Computed the same way the panel's read computes it, from the
    // statements that remain — never patched up locally from what was just written.
    let steps;
    try {
      steps = await loadStepStates(row, brandId, req.orgId!);
    } catch (error) {
      if (respondMeasuredVisitFailure(error, res)) return;
      throw error;
    }

    res.json({
      leadCampaignId: row.id,
      leadId: row.lead_id,
      campaignId: row.campaign_id,
      brandId,
      step,
      kind,
      withdrawn: true,
      alreadyWithdrawn: false,
      withdrawnByUserId: withdrawnBy,
      restoredNeverSteps,
      steps,
    });
  }),
);

/**
 * GET /internal/brands/:brandId/step-disqualifications[?implied=true]
 *
 * INTERNAL (service-auth: x-api-key — the same tier as the conversion-count reads, NO Clerk).
 * The people a human has stated will NEVER reach a given step, per step, for the brand.
 *
 * Nothing here is an outcome and nothing counts it as one: this is the read that lets a consumer
 * separate a lead that is DEAD at a step from one still PENDING, which is what stops a
 * cost-per-acquisition denominator from waiting forever on somebody who is never coming.
 *
 * `counts` / `byStep` are the STATEMENTS THEMSELVES — what a person actually said — and they are
 * byte-identical to what this read has always answered (retracted statements excluded, since a
 * superseded "never" was never a live one).
 *
 * `?implied=true` additionally applies the leg graph: a lead that will never book has, by the
 * same statement, never attended. It is opt-in — a consumer that does not ask sees exactly what it
 * saw before. It answers three more fields, kept apart so a reader can always tell what somebody
 * stated from what the graph concluded:
 *
 *   impliedCounts / impliedByStep   — steps NOBODY stated, which a stated "never" on a step every
 *                                     path to them goes through makes never.
 *   effectiveCounts / effectiveByStep — stated and implied together: the answer to "is this lead
 *                                     dead at this step?".
 *
 * A never contradicted by an outcome only reachable through it is dropped from the implied and
 * effective sets (the lead demonstrably got there), never from the stated ones.
 *
 * The identity returned is the lead's canonical (primary) email — the join key features-service
 * already holds from audience membership, and the SAME identity /converted-lead-emails returns —
 * lowercased and DISTINCT. A lead with no email contact method yields no join key and is excluded
 * from the email sets; the counts are over statements, so they do not depend on that join.
 *
 * Never 404 — a brand nobody has disqualified anyone for returns empty sets and zero counts.
 */
router.get(
  "/internal/brands/:brandId/step-disqualifications",
  apiKeyAuth,
  wrap(async (req: Request, res: Response) => {
    const brandId = req.params.brandId;
    const wantsImplied = req.query.implied === "true";

    const counts = Object.fromEntries(LEAD_STEP_OUTCOMES.map((s) => [s, 0])) as Record<
      LeadStepOutcomeName,
      number
    >;
    const byStep = Object.fromEntries(LEAD_STEP_OUTCOMES.map((s) => [s, [] as string[]])) as Record<
      LeadStepOutcomeName,
      string[]
    >;

    const countRows = (await db.execute(sql`
      SELECT step, count(DISTINCT lead_id)::int AS n
      FROM lead_step_disqualifications
      WHERE brand_id = ${brandId}
        AND retracted_at IS NULL
        AND withdrawn_at IS NULL
      GROUP BY step
    `)) as unknown as Array<{ step: string; n: number }>;
    for (const r of countRows) {
      const step = canonicalizeStepOutcome(r.step);
      if (step) counts[step] += r.n;
    }

    const emailRows = (await db.execute(sql`
      SELECT DISTINCT d.step, lower(canonical.value) AS email
      FROM lead_step_disqualifications d
      JOIN LATERAL (
        SELECT cm.value
        FROM lead_contact_methods cm
        WHERE cm.lead_id = d.lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
        LIMIT 1
      ) canonical ON true
      WHERE d.brand_id = ${brandId}
        AND d.retracted_at IS NULL
        AND d.withdrawn_at IS NULL
        AND canonical.value IS NOT NULL
    `)) as unknown as Array<{ step: string; email: string | null }>;
    for (const r of emailRows) {
      const step = canonicalizeStepOutcome(r.step);
      if (!step || !r.email) continue;
      byStep[step].push(r.email);
    }

    // Who WENT COLD at a step (lead-cold.ts): derived, never a statement, so it lives beside the
    // stated sets and never inside them. Empty for a brand whose CRM cannot prove an absence.
    let coldRead;
    try {
      coldRead = await readBrandColdLeads(brandId);
    } catch (error) {
      if (!(error instanceof EvidenceUnavailableError)) throw error;
      console.error(`[step-disqualifications] ${error.message}`);
      res.status(502).json({
        error:
          "email-gateway could not say when these leads replied, so who went cold is unknown. No " +
          "answer is returned rather than one that misses cold leads.",
        code: "cold_unresolvable",
      });
      return;
    }
    const coldCounts: Record<ColdStep, number> = { meeting_booked: 0, meeting_attended: 0 };
    const coldByStep: Record<ColdStep, string[]> = { meeting_booked: [], meeting_attended: [] };
    const coldLeadsByStep: Record<ColdStep, Set<string>> = {
      meeting_booked: new Set(),
      meeting_attended: new Set(),
    };
    const coldEmailsByStep: Record<ColdStep, Set<string>> = {
      meeting_booked: new Set(),
      meeting_attended: new Set(),
    };
    for (const lead of coldRead.leads) {
      coldLeadsByStep[lead.wentCold.step].add(lead.leadId);
      if (lead.email) coldEmailsByStep[lead.wentCold.step].add(lead.email);
    }
    for (const step of ["meeting_booked", "meeting_attended"] as const) {
      coldCounts[step] = coldLeadsByStep[step].size;
      coldByStep[step] = Array.from(coldEmailsByStep[step]);
    }
    const cold = {
      coldCounts,
      coldByStep,
      coldLeads: coldRead.leads.map((l) => ({
        leadId: l.leadId,
        leadCampaignId: l.leadCampaignId,
        campaignId: l.campaignId,
        email: l.email,
        ...l.wentCold,
      })),
      coldRule: {
        afterDays: COLD_AFTER_DAYS,
        applies: coldRead.eligibility.some((e) => e.eligible),
        byOrg: coldRead.eligibility.map((e) => ({
          orgId: e.orgId,
          applies: e.eligible,
          reason: e.reason,
        })),
      },
    };

    if (!wantsImplied) {
      res.json({ counts, byStep, ...cold });
      return;
    }

    // --- the leg-graph view, opt-in ---

    const statementRows = (await db.execute(sql`
      SELECT d.lead_id, d.campaign_id, d.org_id, d.step, lower(canonical.value) AS email
      FROM lead_step_disqualifications d
      LEFT JOIN LATERAL (
        SELECT cm.value
        FROM lead_contact_methods cm
        WHERE cm.lead_id = d.lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
        LIMIT 1
      ) canonical ON true
      WHERE d.brand_id = ${brandId}
        AND d.retracted_at IS NULL
        AND d.withdrawn_at IS NULL
    `)) as unknown as Array<{
      lead_id: string;
      campaign_id: string;
      org_id: string;
      step: string;
      email: string | null;
    }>;

    const impliedCounts = Object.fromEntries(LEAD_STEP_OUTCOMES.map((s) => [s, 0])) as Record<
      LeadStepOutcomeName,
      number
    >;
    const impliedByStep = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((s) => [s, [] as string[]]),
    ) as Record<LeadStepOutcomeName, string[]>;
    const effectiveCounts = Object.fromEntries(LEAD_STEP_OUTCOMES.map((s) => [s, 0])) as Record<
      LeadStepOutcomeName,
      number
    >;
    const effectiveByStep = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((s) => [s, [] as string[]]),
    ) as Record<LeadStepOutcomeName, string[]>;

    if (statementRows.length === 0) {
      res.json({ counts, byStep, impliedCounts, impliedByStep, effectiveCounts, effectiveByStep, ...cold });
      return;
    }

    // Outcomes contradict a "never" on a step every path to them goes through, so they are read
    // before anything is concluded: a lead that demonstrably attended is not dead at booking.
    const leadIds = Array.from(new Set(statementRows.map((r) => r.lead_id)));
    const outcomeRows = (await db.execute(sql`
      SELECT matched_lead_id, event
      FROM conversion_events
      WHERE brand_id = ${brandId}
        AND attribution_status = 'attributed'
        AND withdrawn_at IS NULL
        AND matched_lead_id = ANY(${sql.param(leadIds)}::uuid[])
    `)) as unknown as Array<{ matched_lead_id: string; event: string }>;

    const outcomesByLead = new Map<string, Map<LeadStepOutcomeName, StatedOutcome>>();
    for (const o of outcomeRows) {
      const step = canonicalizeStepOutcome(o.event);
      if (!step) continue;
      let m = outcomesByLead.get(o.matched_lead_id);
      if (!m) outcomesByLead.set(o.matched_lead_id, (m = new Map()));
      if (!m.has(step)) {
        m.set(step, {
          source: "manual",
          valueCents: null,
          costCents: null,
          causedByOutreach: null,
          note: null,
          statedByUserId: null,
          at: null,
        });
      }
    }

    // One resolution per (lead, campaign): that pair is the row a statement was made on.
    interface Group {
      leadId: string;
      campaignId: string;
      email: string | null;
      nevers: Map<LeadStepOutcomeName, StatedNever>;
    }
    const groups = new Map<string, Group>();
    for (const r of statementRows) {
      const step = canonicalizeStepOutcome(r.step);
      if (!step) continue;
      const key = `${r.lead_id}|${r.campaign_id}`;
      let group = groups.get(key);
      if (!group) {
        groups.set(
          key,
          (group = { leadId: r.lead_id, campaignId: r.campaign_id, email: r.email, nevers: new Map() }),
        );
      }
      group.nevers.set(step, { costCents: null, note: null, statedByUserId: null, at: null });
    }

    const impliedLeads = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((s) => [s, new Set<string>()]),
    ) as Record<LeadStepOutcomeName, Set<string>>;
    const effectiveLeads = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((s) => [s, new Set<string>()]),
    ) as Record<LeadStepOutcomeName, Set<string>>;
    const impliedEmails = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((s) => [s, new Set<string>()]),
    ) as Record<LeadStepOutcomeName, Set<string>>;
    const effectiveEmails = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((s) => [s, new Set<string>()]),
    ) as Record<LeadStepOutcomeName, Set<string>>;

    for (const group of groups.values()) {
      const states = resolveStepStates({
        allSteps: LEAD_STEP_OUTCOMES,
        outcomes: outcomesByLead.get(group.leadId) ?? new Map(),
        nevers: group.nevers,
      });
      for (const s of states) {
        if (s.state !== "never") continue;
        effectiveLeads[s.step].add(group.leadId);
        if (group.email) effectiveEmails[s.step].add(group.email);
        if (s.origin === "implied") {
          impliedLeads[s.step].add(group.leadId);
          if (group.email) impliedEmails[s.step].add(group.email);
        }
      }
    }

    for (const step of LEAD_STEP_OUTCOMES) {
      impliedCounts[step] = impliedLeads[step].size;
      effectiveCounts[step] = effectiveLeads[step].size;
      impliedByStep[step] = Array.from(impliedEmails[step]);
      effectiveByStep[step] = Array.from(effectiveEmails[step]);
    }

    res.json({ counts, byStep, impliedCounts, impliedByStep, effectiveCounts, effectiveByStep, ...cold });
  }),
);

/**
 * GET /internal/brands/:brandId/step-costs[?step=<step>]
 *
 * INTERNAL (service-auth: x-api-key — the same tier as the conversion-count reads, NO Clerk).
 * What the CUSTOMER told us each step cost THEM, one row per statement.
 *
 * The platform automates the first leg and bills for it; the customer performs
 * the rest — they run the meeting, they close the deal. Until this existed, a cost of
 * acquisition could only count the leg the platform paid for, so every return computed on it
 * was too good. This is the read that closes the gap: whoever computes money adds these legs
 * to the platform spend it already knows about.
 *
 * THIS IS NOT PLATFORM SPEND. Nothing here was ever charged to the organisation, no runs-service
 * cost was declared for it, and none of it appears in the organisation's billing. It is money the
 * customer says they spent, recorded verbatim because they are the only one who can know it.
 *
 * Per row:
 *  - `kind` — `outcome` (the step happened) or `never` (it will not, and the leg still cost). Both
 *    are real spend: a meeting that was run and went nowhere cost exactly what it cost.
 *  - `costCents` — what they stated, in cents. **0 is a stated zero.** `null` means nobody was ever
 *    asked: every statement made before the cost became mandatory, and every tracker-reported
 *    outcome (a page-load tag observes a page load and knows nothing about a customer's spend).
 *    Never conflate the two — `statedCount` / `unstatedCount` are what say how much of a step's
 *    population actually answered.
 *  - `campaignId` — every hand statement carries one (it is made on a lead row, which belongs to a
 *    campaign), so this read attributes at campaign grain and not only at brand grain.
 *  - `occurredAt` — when the outcome happened, or when the "never" was last stated. ISO-8601.
 *  - `email` / `leadId` — the join keys a consumer already holds. Email is the lead's canonical
 *    one, lowercased, and null when the lead has no email contact method (never a dropped row).
 *
 * The set is EVERY live hand statement for the brand, which is deliberately NOT the set
 * /conversion-counts counts, and the difference is not a contradiction because this is money and
 * that is a population:
 *  - a hand-stated `website_visit` whose click the delivery layer already measured is suppressed
 *    from the COUNTS (so the same visit is not counted twice) but kept HERE, because the customer
 *    spent the money either way and dropping it would understate their cost.
 *  - a RETRACTED "never" is excluded, exactly as it is from every other read: it was superseded by
 *    an outcome, and that outcome carries its own cost.
 *
 * `?step=` narrows to one step of the outcome vocabulary (legacy "purchase" folds to "sale"); an
 * unrecognised value is a 400, never a silent "all steps". Never 404 — a brand nobody has stated a
 * cost for answers zeros and an empty array.
 */
router.get(
  "/internal/brands/:brandId/step-costs",
  apiKeyAuth,
  wrap(async (req: Request, res: Response) => {
    const brandId = req.params.brandId;

    let step: LeadStepOutcomeName | null = null;
    if (req.query.step !== undefined) {
      step = canonicalizeStepOutcome(req.query.step);
      if (!step) {
        res.status(400).json({ error: `step must be one of ${LEAD_STEP_OUTCOMES.join(" | ")}` });
        return;
      }
    }
    const stepFilter = step;

    // Hand-stated OUTCOMES. `source = 'manual'` is the whole of it: a tracker row is not a customer
    // statement and carries no cost by construction, so including it would only add null rows that
    // inflate `unstatedCount` with a population nobody was ever going to ask.
    const outcomeRows = (await db.execute(sql`
      SELECT
        ce.matched_lead_id AS lead_id,
        ce.lead_campaign_id,
        ce.campaign_id,
        ce.event AS step,
        ce.cost_cents,
        ce.stated_by_user_id,
        ce.received_at AS occurred_at,
        lower(canonical.value) AS email
      FROM conversion_events ce
      LEFT JOIN LATERAL (
        SELECT cm.value
        FROM lead_contact_methods cm
        WHERE cm.lead_id = ce.matched_lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
        LIMIT 1
      ) canonical ON true
      WHERE ce.brand_id = ${brandId}
        AND ce.source = 'manual'
        AND ce.attribution_status = 'attributed'
        AND ce.withdrawn_at IS NULL
        ${stepFilter ? sql`AND ce.event = ${stepFilter}` : sql``}
      ORDER BY ce.received_at DESC NULLS LAST
    `)) as unknown as Array<{
      lead_id: string | null;
      lead_campaign_id: string | null;
      campaign_id: string | null;
      step: string;
      cost_cents: number | null;
      stated_by_user_id: string | null;
      occurred_at: Date | string | null;
      email: string | null;
    }>;

    // Stated "never"s. A dead leg still cost — the meeting was run, the call was taken — and a cost
    // of acquisition that ignores it is too good for exactly the same reason the outcome legs are.
    const neverRows = (await db.execute(sql`
      SELECT
        d.lead_id,
        d.lead_campaign_id,
        d.campaign_id,
        d.step,
        d.cost_cents,
        d.stated_by_user_id,
        d.updated_at AS occurred_at,
        lower(canonical.value) AS email
      FROM lead_step_disqualifications d
      LEFT JOIN LATERAL (
        SELECT cm.value
        FROM lead_contact_methods cm
        WHERE cm.lead_id = d.lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
        LIMIT 1
      ) canonical ON true
      WHERE d.brand_id = ${brandId}
        AND d.retracted_at IS NULL
        AND d.withdrawn_at IS NULL
        ${stepFilter ? sql`AND d.step = ${stepFilter}` : sql``}
      ORDER BY d.updated_at DESC NULLS LAST
    `)) as unknown as Array<{
      lead_id: string;
      lead_campaign_id: string | null;
      campaign_id: string | null;
      step: string;
      cost_cents: number | null;
      stated_by_user_id: string | null;
      occurred_at: Date | string | null;
      email: string | null;
    }>;

    interface StepCostRow {
      leadId: string | null;
      leadCampaignId: string | null;
      campaignId: string | null;
      email: string | null;
      step: LeadStepOutcomeName;
      kind: "outcome" | "never";
      costCents: number | null;
      statedByUserId: string | null;
      occurredAt: string | null;
    }

    const costs: StepCostRow[] = [];
    const push = (
      r: {
        lead_id: string | null;
        lead_campaign_id: string | null;
        campaign_id: string | null;
        step: string;
        cost_cents: number | null;
        stated_by_user_id: string | null;
        occurred_at: Date | string | null;
        email: string | null;
      },
      kind: "outcome" | "never",
    ) => {
      const canonical = canonicalizeStepOutcome(r.step);
      if (!canonical) return;
      costs.push({
        leadId: r.lead_id,
        leadCampaignId: r.lead_campaign_id,
        campaignId: r.campaign_id,
        email: r.email && r.email.length > 0 ? r.email : null,
        step: canonical,
        kind,
        // A raw `sql` integer comes back as a number; anything else is an absent answer, and an
        // absent answer stays null. 0 survives this check precisely because it is an answer.
        costCents: typeof r.cost_cents === "number" ? r.cost_cents : null,
        statedByUserId: r.stated_by_user_id,
        // Raw `sql` hands a timestamptz back as a Date on some paths and a string on others —
        // normalize, never `.toISOString()` on the raw value.
        occurredAt: toIsoTimestamp(r.occurred_at),
      });
    };
    for (const r of outcomeRows) push(r, "outcome");
    for (const r of neverRows) push(r, "never");

    const steps = stepFilter ? [stepFilter] : LEAD_STEP_OUTCOMES;
    const byStep = Object.fromEntries(
      steps.map((s) => [s, { costCents: 0, statedCount: 0, unstatedCount: 0 }]),
    ) as Record<LeadStepOutcomeName, { costCents: number; statedCount: number; unstatedCount: number }>;

    let totalCostCents = 0;
    let statedCount = 0;
    let unstatedCount = 0;
    for (const c of costs) {
      const bucket = byStep[c.step];
      if (!bucket) continue;
      if (c.costCents === null) {
        bucket.unstatedCount += 1;
        unstatedCount += 1;
        continue;
      }
      bucket.costCents += c.costCents;
      bucket.statedCount += 1;
      totalCostCents += c.costCents;
      statedCount += 1;
    }

    res.json({ brandId, totalCostCents, statedCount, unstatedCount, byStep, costs });
  }),
);

export default router;
