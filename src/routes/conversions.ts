import { CRM_POSITIVE_REPLY_STEP } from "../lib/crm-evidence.js";
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeyAuth, requireOrgId, AuthenticatedRequest } from "../middleware/auth.js";
import { CONVERSION_INGEST_URL } from "../config.js";
import {
  canonicalizeConversionEvent,
  isPingEvent,
  deriveConversionStatus,
  generateConversionToken,
  computeDedupeSignature,
  matchConversion,
} from "../lib/conversions.js";
import {
  LEAD_STEP_OUTCOMES,
  WEBSITE_VISIT,
  canonicalizeStepOutcome,
  outcomeCauseOf,
  statementSourceOf,
  type LeadStepOutcomeName,
  type OutcomeCause,
  type StatementSource,
} from "../lib/step-statements.js";
import {
  MeasuredVisitLookupError,
  fetchMeasuredVisitEmails,
} from "../lib/measured-visits.js";
import { toIsoTimestamp } from "../lib/basic-leads.js";

const router = Router();

// Express 4 does not forward async handler rejections to the error middleware.
// Wrap so a DB error surfaces as a clean 500 (fail loud) instead of a hung socket.
function wrap<Req extends Request = Request>(
  fn: (req: Req, res: Response, next: NextFunction) => Promise<void>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req as Req, res, next).catch(next);
  };
}

// Transition alias for the "purchase" → "sale" rename. The internal count contracts emit the
// canonical "sale" key AND a legacy "purchase" key mirroring the same value, so consumers still
// reading `purchase` (features-service conversion-counts clients) stay green while they migrate
// to `sale`. Drop the mirror once every consumer reads `sale`.
function withLegacyPurchaseAlias<T>(
  byEvent: Record<LeadStepOutcomeName, T>,
): Record<string, T> {
  return { ...byEvent, purchase: byEvent.sale };
}

// --- Public ingest token auth ---
// The publishable write-key arrives in `x-conversion-token` OR `Authorization: Bearer`.
// It resolves to exactly one (brandId, orgId). Missing/invalid → 401. Never leak WHY.
interface ConversionRequest extends Request {
  conversionBrandId?: string;
  conversionOrgId?: string;
}

function extractToken(req: Request): string | null {
  const headerToken = req.headers["x-conversion-token"];
  if (typeof headerToken === "string" && headerToken.trim()) return headerToken.trim();

  const auth = req.headers["authorization"];
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

const conversionTokenAuth = wrap(async function conversionTokenAuth(
  req: ConversionRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const token = extractToken(req);
  if (!token) {
    res.status(401).json({ error: "Invalid conversion token" });
    return;
  }

  const rows = (await db.execute(sql`
    SELECT brand_id, org_id
    FROM brand_conversion_tokens
    WHERE token = ${token}
    LIMIT 1
  `)) as unknown as Array<{ brand_id: string; org_id: string }>;

  if (rows.length === 0) {
    res.status(401).json({ error: "Invalid conversion token" });
    return;
  }

  req.conversionBrandId = rows[0].brand_id;
  req.conversionOrgId = rows[0].org_id;
  next();
});

// --- Public ingest body ---
const ConversionIngestBodySchema = z.object({
  event: z.string(),
  email: z.string().optional(),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  companyUrl: z.string().optional(),
  dedupeKey: z.string().optional(),
  valueCents: z.number().int().optional(),
});

/**
 * POST /public/conversions
 *
 * Called directly by the CLIENT's website (token-auth, NO Clerk). Records a conversion
 * event and attributes it to a lead we emailed for that brand. NEVER leaks the match
 * result to the public caller — always returns { received: true } on success.
 */
router.post("/public/conversions", conversionTokenAuth, wrap(async (req: ConversionRequest, res) => {
  const brandId = req.conversionBrandId!;
  const orgId = req.conversionOrgId!;

  const parsed = ConversionIngestBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid or missing event" });
    return;
  }

  // Liveness heartbeat. The tag fires this on page-load: authenticate the token exactly
  // like a real event (already done above), stamp last_ping_at, and STOP — no attribution,
  // no conversion_events row, no dedupe, never counted as a conversion. Same opaque
  // { received: true } so the public caller learns nothing.
  if (isPingEvent(parsed.data.event)) {
    await db.execute(sql`
      UPDATE brand_conversion_tokens
      SET last_ping_at = now()
      WHERE brand_id = ${brandId}
    `);
    res.json({ received: true });
    return;
  }

  // Accept the canonical "sale" AND the legacy "purchase" spelling: canonicalize BEFORE
  // dedupe + storage so a legacy client firing "purchase" is stored/attributed/deduped
  // exactly like a "sale". Anything unrecognized (garbage) → fail loud 400.
  const event = canonicalizeConversionEvent(parsed.data.event);
  if (!event) {
    res.status(400).json({ error: "Invalid or missing event" });
    return;
  }

  const body = parsed.data;
  const now = new Date();

  const dedupeSignature = computeDedupeSignature({
    dedupeKey: body.dedupeKey,
    event,
    email: body.email,
    phone: body.phone,
    now,
  });

  // Dedupe: a duplicate returns 200 without a second attribution row.
  if (dedupeSignature) {
    const existing = (await db.execute(sql`
      SELECT 1
      FROM conversion_events
      WHERE brand_id = ${brandId} AND dedupe_signature = ${dedupeSignature}
      LIMIT 1
    `)) as unknown as Array<unknown>;
    if (existing.length > 0) {
      res.json({ received: true });
      return;
    }
  }

  const match = await matchConversion({
    brandId,
    email: body.email,
    phone: body.phone,
    firstName: body.firstName,
    lastName: body.lastName,
    companyUrl: body.companyUrl,
  });

  // Race-safe insert: if a concurrent request already claimed this signature, the
  // partial unique index makes this a no-op and we still return 200.
  //
  // received_at is bound as `now.toISOString()`, NOT a raw `Date`: a raw `sql` template
  // hands params straight to postgres.js `Bind`, which does not serialize a Date (only
  // drizzle's typed insert builder / postgres.js's own tagged template do). Binding a
  // `Date` throws `ERR_INVALID_ARG_TYPE ... Received an instance of Date` at Bind time —
  // a client-side throw invisible to raw-SQL/EXECUTE tests — which 500'd every real
  // conversion in prod (#357). The ISO string casts to timestamptz for the column.
  await db.execute(sql`
    INSERT INTO conversion_events (
      brand_id, org_id, event, email, phone, first_name, last_name, company_url,
      dedupe_key, dedupe_signature, value_cents, matched_lead_id, match_method,
      match_confidence, attribution_status, candidate_count, received_at
    ) VALUES (
      ${brandId}, ${orgId}, ${event}, ${body.email ?? null}, ${body.phone ?? null},
      ${body.firstName ?? null}, ${body.lastName ?? null}, ${body.companyUrl ?? null},
      ${body.dedupeKey ?? null}, ${dedupeSignature}, ${body.valueCents ?? null},
      ${match.matchedLeadId}, ${match.matchMethod}, ${match.matchConfidence},
      ${match.attributionStatus}, ${match.candidateCount}, ${now.toISOString()}
    )
    ON CONFLICT (brand_id, dedupe_signature) WHERE dedupe_signature IS NOT NULL DO NOTHING
  `);

  res.json({ received: true });
}));

/**
 * GET /orgs/brands/:brandId/conversion-token
 *
 * Get-or-create the brand's publishable write-key. Returns the token in FULL (it is a
 * publishable key, not a secret) plus the public ingest URL a third party hits.
 */
router.get(
  "/orgs/brands/:brandId/conversion-token",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const brandId = req.params.brandId;
    const orgId = req.orgId!;
    const token = generateConversionToken();

    const rows = (await db.execute(sql`
      INSERT INTO brand_conversion_tokens (brand_id, org_id, token)
      VALUES (${brandId}, ${orgId}, ${token})
      ON CONFLICT (brand_id) DO UPDATE SET updated_at = now()
      RETURNING token, last_ping_at
    `)) as unknown as Array<{ token: string; last_ping_at: Date | string | null }>;

    // Liveness overlay, DERIVED from received signals (never self-attested). Real events
    // live in conversion_events; ping never lands there, so eventTypesSeen excludes it
    // for free. array_agg over zero rows → null → [].
    const agg = (await db.execute(sql`
      SELECT max(received_at) AS last_event_at,
             array_agg(DISTINCT event) AS event_types
      FROM conversion_events
      WHERE brand_id = ${brandId}
        -- The tracker's liveness: what the customer's own CRM evidences is not a signal the
        -- website tag sent.
        AND source <> 'crm'
    `)) as unknown as Array<{
      last_event_at: Date | string | null;
      event_types: string[] | null;
    }>;

    const lastEventAt = toIsoTimestamp(agg[0]?.last_event_at ?? null);
    const lastPingAt = toIsoTimestamp(rows[0].last_ping_at ?? null);
    const eventTypesSeen = agg[0]?.event_types ?? [];
    const status = deriveConversionStatus({
      hasRealEvent: lastEventAt !== null,
      hasPing: lastPingAt !== null,
    });

    res.json({
      token: rows[0].token,
      ingestUrl: CONVERSION_INGEST_URL,
      status,
      lastEventAt,
      lastPingAt,
      eventTypesSeen,
    });
  }),
);

/**
 * POST /orgs/brands/:brandId/conversion-token/rotate
 *
 * Replace the brand's token with a fresh one; the old token immediately 401s on ingest.
 */
router.post(
  "/orgs/brands/:brandId/conversion-token/rotate",
  apiKeyAuth,
  requireOrgId,
  wrap(async (req: AuthenticatedRequest, res: Response) => {
    const brandId = req.params.brandId;
    const orgId = req.orgId!;
    const token = generateConversionToken();

    const rows = (await db.execute(sql`
      INSERT INTO brand_conversion_tokens (brand_id, org_id, token)
      VALUES (${brandId}, ${orgId}, ${token})
      ON CONFLICT (brand_id) DO UPDATE SET token = EXCLUDED.token, rotated_at = now(), updated_at = now()
      RETURNING token
    `)) as unknown as Array<{ token: string }>;

    res.json({ token: rows[0].token, ingestUrl: CONVERSION_INGEST_URL });
  }),
);


/**
 * The hand-stated `website_visit` rows this brand must NOT count, because the delivery layer
 * already measured the same person's visit as a click.
 *
 * A visit is the one step of the funnel that is BOTH measured automatically (a click, owned by
 * email-gateway, untouched here) and statable by hand. Both describe the same thing, so a lead
 * carrying both is counted once: the hand-stated row is suppressed from every outcome read, and
 * what a consumer reads for `website_visit` is the visits known ONLY by hand — the number it can
 * add to the measured click count without double-counting anybody.
 *
 * A brand with no hand-stated visit costs one extra indexed SELECT and makes NO network call, so
 * every existing brand's reads are byte-identical. A lead with no registered email is never
 * suppressed: the measured signal keys on that email, so such a lead cannot be in the measured set.
 * email-gateway unreachable throws (the route answers 502) — never a guessed count.
 */
async function measuredVisitEventIds(brandId: string): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT ce.id, ce.org_id, lower(canonical.value) AS email
    FROM conversion_events ce
    LEFT JOIN LATERAL (
      SELECT cm.value
      FROM lead_contact_methods cm
      WHERE cm.lead_id = ce.matched_lead_id AND cm.channel = 'email'
      ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
      LIMIT 1
    ) canonical ON true
    WHERE ce.brand_id = ${brandId}
      AND ce.attribution_status = 'attributed'
      AND ce.withdrawn_at IS NULL
      AND ce.event = ${WEBSITE_VISIT}
  `)) as unknown as Array<{ id: string; org_id: string | null; email: string | null }>;
  if (rows.length === 0) return [];

  // The brand can legitimately be claimed by more than one org, and delivery evidence is
  // org-scoped, so each org is asked for its own rows.
  const byOrg = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.org_id || !row.email) continue;
    const bucket = byOrg.get(row.org_id) ?? [];
    bucket.push(row.email);
    byOrg.set(row.org_id, bucket);
  }
  if (byOrg.size === 0) return [];

  const measured = new Map<string, Set<string>>();
  for (const [orgId, emails] of byOrg) {
    measured.set(orgId, await fetchMeasuredVisitEmails(brandId, orgId, emails));
  }

  return rows
    .filter((row) => row.org_id && row.email && measured.get(row.org_id)?.has(row.email))
    .map((row) => row.id);
}

/** `AND ce.id <> ALL(...)`, or nothing at all when there is nothing to suppress. */
function excludeIds(ids: string[]) {
  return ids.length > 0 ? sql`AND ce.id <> ALL(${ids}::uuid[])` : sql.empty();
}

/** A measured-visit lookup that could not be answered is a 502, never a guessed number. */
function respondMeasuredVisitFailure(error: unknown, res: Response): boolean {
  if (!(error instanceof MeasuredVisitLookupError)) return false;
  console.error(error.message);
  res.status(502).json({
    error:
      "email-gateway could not say which website visits it already measured, so the count " +
      "would risk double-counting a lead. No number is returned rather than a wrong one.",
  });
  return true;
}

/**
 * GET /internal/brands/:brandId/conversion-counts
 *
 * INTERNAL (service-auth: x-api-key — same tier as other /internal/* routes, NO Clerk).
 * Returns the per-event-type COUNT of REAL, attributed conversions for the brand, so
 * features-service can compute real signups / cost-per-signup for the dashboard.
 *
 * Each count = deduped, attributed conversion events of that type:
 *  - Rows in conversion_events are already deduped at WRITE (partial unique index on
 *    (brand_id, dedupe_signature)), so counting stored rows is inherently deduped per the
 *    same rules POST /public/conversions applies.
 *  - `attribution_status = 'attributed'` keeps only conversions credited to a lead we
 *    emailed for this brand (auto-accepted); excludes needs_review (held) + unmatched.
 *    This is the "counts toward the brand's real outcomes" set.
 *  - "ping" is a liveness heartbeat that never lands in conversion_events → excluded for free.
 *
 * All FIVE canonical step keys (signup | meeting_booked | meeting_attended | form_submission |
 * sale) are ALWAYS present (0 when none). "meeting_attended" is statable by hand only — a
 * page-load tag cannot observe somebody showing up to a meeting — but it counts exactly like the
 * four the tracker reports, which is what finally lets the booked-to-attended rate brand-service
 * prices with be measured against reality. The terminal "customer paid" event was renamed
 * "purchase" → "sale"; for the migration window the response ALSO carries a legacy "purchase"
 * key mirroring "sale" so consumers still reading `purchase` stay green until they migrate.
 *
 * `counts` totals BOTH sources and is what every existing consumer keeps reading unchanged.
 * `bySource.tracker` / `bySource.manual` split the same rows by who said so — a hand-stated
 * outcome is distinguishable from a tracker-reported one after the fact without changing what
 * either counts toward. `bySource.crm` is what the customer's OWN CRM evidences for leads paired
 * with a contact of theirs. For every key, tracker + manual + crm === counts.
 *
 * `byCause.outreach` / `byCause.other` / `byCause.unstated` split the same rows by WHOSE WIN each
 * outcome was — a brand also sells through referrals, conferences, its own pipeline and other
 * agencies, so some of the people we email buy for reasons that have nothing to do with us. A deal
 * the customer says we did NOT cause is a real deal and stays in `counts`; what this split adds is
 * the ability to leave its value out of the return computed on OUR outreach. `unstated` is nobody
 * having been asked (every outcome predating the field, and every tracker-reported one — a
 * page-load tag cannot know why somebody bought) and is never folded into either answer. For every
 * key, outreach + other + unstated === counts.
 *
 * A "never" statement ("this lead will not book / attend / buy") is NOT an outcome: it lives in
 * lead_step_disqualifications, which this read does not touch, so nothing here can count it.
 * Never 404 — a brand with zero conversions returns all-zero counts.
 */
router.get(
  "/internal/brands/:brandId/conversion-counts",
  apiKeyAuth,
  wrap(async (req: Request, res: Response) => {
    const brandId = req.params.brandId;

    let suppressed: string[];
    try {
      suppressed = await measuredVisitEventIds(brandId);
    } catch (error) {
      if (respondMeasuredVisitFailure(error, res)) return;
      throw error;
    }

    const rows = (await db.execute(sql`
      SELECT ce.event, ce.source, ce.caused_by_outreach, count(*)::int AS n
      FROM conversion_events ce
      WHERE ce.brand_id = ${brandId}
        AND ce.attribution_status = 'attributed'
        -- A statement its author took back is not a live outcome: nothing counts it.
        AND ce.withdrawn_at IS NULL
        ${excludeIds(suppressed)}
      GROUP BY ce.event, ce.source, ce.caused_by_outreach
    `)) as unknown as Array<{
      event: string;
      source: string;
      caused_by_outreach: boolean | null;
      n: number;
    }>;

    const zeroed = () =>
      Object.fromEntries(LEAD_STEP_OUTCOMES.map((e) => [e, 0])) as Record<
        LeadStepOutcomeName,
        number
      >;
    const counts = zeroed();
    const bySource: Record<StatementSource, Record<LeadStepOutcomeName, number>> = {
      tracker: zeroed(),
      manual: zeroed(),
      // What the customer's OWN CRM evidences, for leads paired with a contact of theirs.
      crm: zeroed(),
    };
    // WHOSE win each outcome was. `outreach` — the customer says ours caused it; `other` — they say
    // something else of theirs did (a referral, a conference, their own pipeline: a REAL outcome,
    // counted in `counts` exactly like any other, simply not one to compute OUR return on);
    // `unstated` — nobody was ever asked, which is every outcome stated before this existed and
    // every tracker-reported one. Three buckets, and the third is never folded into either answer.
    const byCause: Record<OutcomeCause, Record<LeadStepOutcomeName, number>> = {
      outreach: zeroed(),
      other: zeroed(),
      unstated: zeroed(),
    };

    for (const row of rows) {
      // Fold canonical + any legacy-spelled historical row into its canonical bucket.
      const canonical = canonicalizeStepOutcome(row.event);
      if (!canonical) continue;
      counts[canonical] += row.n;
      // Anything not explicitly stated by a human or evidenced by the customer's CRM came off the
      // website tracker — which is what every row written before the column existed is.
      bySource[statementSourceOf(row.source)][canonical] += row.n;
      byCause[outcomeCauseOf(row.caused_by_outreach)][canonical] += row.n;
    }

    res.json({
      counts: withLegacyPurchaseAlias(counts),
      bySource: {
        tracker: withLegacyPurchaseAlias(bySource.tracker),
        manual: withLegacyPurchaseAlias(bySource.manual),
        crm: withLegacyPurchaseAlias(bySource.crm),
      },
      byCause: {
        outreach: withLegacyPurchaseAlias(byCause.outreach),
        other: withLegacyPurchaseAlias(byCause.other),
        unstated: withLegacyPurchaseAlias(byCause.unstated),
      },
    });
  }),
);

/**
 * GET /internal/brands/:brandId/conversion-counts-by-day
 *
 * INTERNAL (service-auth: x-api-key — same tier as conversion-counts, NO Clerk).
 * Returns the SAME set of REAL, attributed conversions as conversion-counts, but broken
 * down by the CALENDAR DAY each conversion was received, so features-service can draw a
 * truthful per-day observed series on the Overview outreach-activity graph (instead of a
 * clicks × rate projection) for today AND past days.
 *
 *  - Same set as /conversion-counts: stored conversion_events rows (deduped at write via
 *    the (brand_id, dedupe_signature) partial unique index), filtered to
 *    attribution_status = 'attributed'. "ping" never lands in conversion_events → excluded.
 *  - `byDay[event]` maps a UTC calendar day (YYYY-MM-DD) → count. Days are bucketed by
 *    `received_at AT TIME ZONE 'UTC'`, matching the UTC-day convention the ingest dedupe
 *    signature already uses (`now.toISOString().slice(0,10)`). A day key appears only when
 *    its count > 0. All five canonical step keys (…, meeting_attended, sale) are ALWAYS present
 *    (empty object when none), plus a legacy "purchase" key mirroring "sale" for the rename window.
 *  - `undated[event]` counts attributed conversions whose day genuinely cannot be
 *    determined (received_at IS NULL). received_at is NOT NULL DEFAULT now() today, so this
 *    is 0 in practice — but it is surfaced EXPLICITLY, never dropped and never assigned a
 *    fabricated date, so the contract stays honest if an undated row ever exists.
 *  - Reconciliation guarantee: for every event, sum(byDay[event] values) + undated[event]
 *    === the count /conversion-counts returns for that event (same rows, same filter). No
 *    per-day figure exceeds or contradicts the total.
 *
 * Never 404 — a brand with zero attributed conversions returns all-empty byDay + all-zero
 * undated (200).
 */
router.get(
  "/internal/brands/:brandId/conversion-counts-by-day",
  apiKeyAuth,
  wrap(async (req: Request, res: Response) => {
    const brandId = req.params.brandId;

    // day is NULL only when received_at IS NULL (an undated conversion). Otherwise the UTC
    // calendar day as a YYYY-MM-DD text (cast date->text is ISO + deterministic regardless
    // of the session timezone). Same attributed-only, deduped-at-write set as /conversion-counts.
    let suppressed: string[];
    try {
      suppressed = await measuredVisitEventIds(brandId);
    } catch (error) {
      if (respondMeasuredVisitFailure(error, res)) return;
      throw error;
    }

    const rows = (await db.execute(sql`
      SELECT
        ce.event,
        CASE
          WHEN ce.received_at IS NULL THEN NULL
          ELSE (ce.received_at AT TIME ZONE 'UTC')::date::text
        END AS day,
        count(*)::int AS n
      FROM conversion_events ce
      WHERE ce.brand_id = ${brandId}
        AND ce.attribution_status = 'attributed'
        -- A statement its author took back is not a live outcome: nothing counts it.
        AND ce.withdrawn_at IS NULL
        ${excludeIds(suppressed)}
      GROUP BY ce.event, day
    `)) as unknown as Array<{ event: string; day: string | null; n: number }>;

    const byDay = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((e) => [e, {} as Record<string, number>]),
    ) as Record<LeadStepOutcomeName, Record<string, number>>;
    const undated = Object.fromEntries(
      LEAD_STEP_OUTCOMES.map((e) => [e, 0]),
    ) as Record<LeadStepOutcomeName, number>;

    for (const row of rows) {
      // Fold canonical + any legacy-spelled historical row into its canonical bucket.
      const canonical = canonicalizeStepOutcome(row.event);
      if (!canonical) continue;
      if (row.day === null) {
        undated[canonical] += row.n;
      } else {
        byDay[canonical][row.day] = (byDay[canonical][row.day] ?? 0) + row.n;
      }
    }

    res.json({
      byDay: withLegacyPurchaseAlias(byDay),
      undated: withLegacyPurchaseAlias(undated),
    });
  }),
);

/**
 * The event a per-row ledger read answers for: a step outcome (legacy "purchase" folded to
 * "sale"), or `positive_reply`. The latter is not a step outcome (no count reads it), but the
 * ledger holds it — a form their prospect submitted in their own CRM on a paired lead, after our
 * first delivered email — and a consumer counting positive replies needs it per person to union it
 * with the delivery layer's own classified replies. `null` for anything else (a 400).
 */
function ledgerEventOf(raw: unknown): string | null {
  return raw === CRM_POSITIVE_REPLY_STEP ? CRM_POSITIVE_REPLY_STEP : canonicalizeStepOutcome(raw);
}

/**
 * GET /internal/brands/:brandId/converted-lead-emails?event=<type>
 *
 * INTERNAL (service-auth: x-api-key — same tier as conversion-counts, NO Clerk).
 * Returns the SET of matched-lead canonical emails (the emails-we-served identity) that
 * have at least one REAL, attributed conversion of `event` for the brand — so
 * features-service can intersect it with each audience's email membership and count
 * conversions per audience.
 *
 *  - `event` is REQUIRED and must be one of the five step outcomes
 *    (signup | meeting_booked | meeting_attended | form_submission | sale). The legacy spelling "purchase"
 *    is still accepted and normalized to "sale". Missing/invalid → 400. "ping" is a
 *    liveness heartbeat, never a conversion → not accepted here.
 *  - Only `attribution_status = 'attributed'` rows count (credited to a lead we emailed
 *    for the brand; excludes needs_review + unmatched) — the SAME set conversion-counts uses.
 *  - The returned identity is the MATCHED LEAD's canonical (primary) email — the earliest
 *    email contact method for the lead — NOT the raw email a visitor typed on the client's
 *    site (which may differ, or be absent for a phone/name match). This is the join key
 *    features-service already holds from human-service audience membership. Lowercased +
 *    DISTINCT so the intersection is case-robust and de-duplicated.
 *  - A matched lead with no email contact method yields no join key → excluded (INNER
 *    LATERAL). Rows are already deduped at write via the (brand_id, dedupe_signature)
 *    partial unique index.
 *
 * Never 404 — a brand with zero attributed conversions of `event` returns an empty set (200).
 */
router.get(
  "/internal/brands/:brandId/converted-lead-emails",
  apiKeyAuth,
  wrap(async (req: Request, res: Response) => {
    const brandId = req.params.brandId;

    // Accept canonical "sale" AND legacy "purchase" (both resolve to the canonical "sale"
    // that stored rows carry); anything else (incl. "ping", garbage, missing) → 400.
    // Also `positive_reply` — see ledgerEventOf.
    const event = ledgerEventOf(req.query.event);
    if (!event) {
      res.status(400).json({ error: "Invalid or missing event" });
      return;
    }

    let suppressed: string[] = [];
    if (event === WEBSITE_VISIT) {
      try {
        suppressed = await measuredVisitEventIds(brandId);
      } catch (error) {
        if (respondMeasuredVisitFailure(error, res)) return;
        throw error;
      }
    }

    const rows = (await db.execute(sql`
      SELECT DISTINCT lower(canonical.value) AS email
      FROM conversion_events ce
      JOIN LATERAL (
        SELECT cm.value
        FROM lead_contact_methods cm
        WHERE cm.lead_id = ce.matched_lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
        LIMIT 1
      ) canonical ON true
      WHERE ce.brand_id = ${brandId}
        AND ce.attribution_status = 'attributed'
        -- A statement its author took back is not a live outcome: nothing counts it.
        AND ce.withdrawn_at IS NULL
        AND ce.event = ${event}
        AND canonical.value IS NOT NULL
        ${excludeIds(suppressed)}
    `)) as unknown as Array<{ email: string | null }>;

    const emails = rows
      .map((r) => r.email)
      .filter((e): e is string => typeof e === "string" && e.length > 0);

    res.json({ event, emails });
  }),
);

/**
 * GET /internal/brands/:brandId/converted-leads?event=<type>
 *
 * INTERNAL (service-auth: x-api-key — same tier as conversion-counts, NO Clerk).
 * Every attributed outcome of `event` for the brand, ONE ROW PER OUTCOME, carrying WHEN it
 * happened and HOW MUCH it was worth — not only WHO reached the step.
 *
 * `/converted-lead-emails` answers "who", and that is all a consumer could ever learn from it:
 * an outcome read through it has no date (so it can only land in an undated bucket, uncharted and
 * unattributable to a period), no campaign (so only the brand total can move — the per-campaign,
 * per-workflow and per-offer grains cannot attribute it at all) and no value (so a won deal gets
 * priced at the brand's AVERAGE lifetime revenue instead of what it was actually worth). This read
 * carries all three, so a consumer can value a lead by what somebody OBSERVED rather than by
 * projecting a funnel of declared rates through it.
 *
 * The set is EXACTLY the one /conversion-counts and /conversion-counts-by-day count: stored
 * conversion_events rows (deduped at write via the (brand_id, dedupe_signature) partial unique
 * index), `attribution_status = 'attributed'`, folded to the canonical step. So for any brand and
 * step, `outcomes.length` === the /conversion-counts total, and bucketing `occurredAt` by UTC
 * calendar day reproduces /conversion-counts-by-day exactly, `null` included (an outcome with no
 * determinable date is the `undated` bucket). No row is visible in one read and absent from the
 * other — which is why the email join is a LEFT lateral here and an INNER one on
 * /converted-lead-emails: that read is a SET of join keys and a lead with no email has none,
 * while dropping the row HERE would silently make the two reads disagree on the count.
 *
 * Per row:
 *  - `email` — the matched lead's canonical (primary) email, lowercased: the SAME join key
 *    /converted-lead-emails returns and the one features-service already holds from audience
 *    membership. Null when the lead has no email contact method (rare, and never a dropped row).
 *  - `leadId` — the matched lead, so a consumer that keys on identity rather than email can.
 *  - `campaignId` — the campaign the outcome is attributable to. A HAND-STATED outcome always has
 *    one (the statement is made on a lead row, which belongs to a campaign). A TRACKER-reported
 *    one has none: a page-load tag knows the brand and nothing else, so it is null rather than
 *    guessed at.
 *  - `occurredAt` — when the outcome actually happened (a hand-stated fact carries the date the
 *    person gave), ISO-8601. Null only when genuinely undated — never fabricated.
 *  - `valueCents` — the revenue stated for the outcome, when one was. Null means nobody said, NOT
 *    zero: a consumer falls back to its own average for those and only those.
 *  - `costCents` — what the CUSTOMER states this leg cost THEM, in cents: the meeting they ran, the
 *    call they took, the time they valued however they chose. It is the leg the platform did not
 *    pay for, and a cost of acquisition that omits it counts only the first link of the funnel. It
 *    is NEVER platform spend: nothing here was charged to the organisation, no runs-service cost
 *    was declared for it, and it is absent from the organisation's billing. 0 is a STATED zero;
 *    null means nobody was ever asked (a tracker-reported outcome knows nothing about the
 *    customer's spend, and so does every statement made before the cost became mandatory). The
 *    whole per-step picture, "never" legs included, is /internal/brands/:brandId/step-costs.
 *  - `causedByOutreach` — WHOSE win it was. `true`: the customer says our outreach caused it.
 *    `false`: they say something else of theirs did (a referral, a conference, their existing
 *    pipeline, another agency) — the deal is REAL and stays in every count, it is simply not one to
 *    compute OUR return on, which is exactly what a consumer holding the two apart needs. `null`:
 *    NOBODY WAS ASKED — every outcome stated before this existed, and every tracker-reported one,
 *    because a page-load tag observes a page load and cannot know why somebody bought. Null is
 *    never read as either answer. Deliberately NOT the `attributed / needs_review / unmatched`
 *    vocabulary, which answers whether we managed to identify who somebody was.
 *  - `source` — `manual` (a human stated it) or `tracker` (the website tag reported it).
 *
 * `event` is REQUIRED, one of the five step outcomes (legacy "purchase" normalized to "sale"), or
 * `positive_reply` — the ledger's positive replies (their CRM's form after our first email), which
 * a consumer unions per person with the delivery layer's classified replies; missing/invalid → 400. Rows come back newest-first. Never 404 — a brand with no attributed
 * outcome of `event` returns an empty array (200).
 */
router.get(
  "/internal/brands/:brandId/converted-leads",
  apiKeyAuth,
  wrap(async (req: Request, res: Response) => {
    const brandId = req.params.brandId;

    const event = ledgerEventOf(req.query.event);
    if (!event) {
      res.status(400).json({ error: "Invalid or missing event" });
      return;
    }

    let suppressed: string[] = [];
    if (event === WEBSITE_VISIT) {
      try {
        suppressed = await measuredVisitEventIds(brandId);
      } catch (error) {
        if (respondMeasuredVisitFailure(error, res)) return;
        throw error;
      }
    }

    const rows = (await db.execute(sql`
      SELECT
        ce.matched_lead_id AS lead_id,
        ce.campaign_id,
        ce.value_cents,
        ce.cost_cents,
        ce.caused_by_outreach,
        ce.stated_caused_by_outreach,
        COALESCE(ce.cause_rule, ce.crm_evidence->'rule') AS cause_rule,
        (cs.id IS NOT NULL) AS crm_override,
        ce.source,
        ce.received_at,
        lower(canonical.value) AS email
      FROM conversion_events ce
      -- A person's whose-win override of a CRM-evidenced step lives beside it, keyed on the person.
      LEFT JOIN lead_step_cause_statements cs
        ON ce.source = 'crm'
       AND cs.brand_id = ce.brand_id
       AND cs.lead_id = ce.matched_lead_id
       AND cs.step = ce.event
       AND cs.withdrawn_at IS NULL
      LEFT JOIN LATERAL (
        SELECT cm.value
        FROM lead_contact_methods cm
        WHERE cm.lead_id = ce.matched_lead_id AND cm.channel = 'email'
        ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC
        LIMIT 1
      ) canonical ON true
      WHERE ce.brand_id = ${brandId}
        AND ce.attribution_status = 'attributed'
        -- A statement its author took back is not a live outcome: nothing counts it.
        AND ce.withdrawn_at IS NULL
        AND ce.event = ${event}
        ${excludeIds(suppressed)}
      ORDER BY ce.received_at DESC NULLS LAST
    `)) as unknown as Array<{
      lead_id: string | null;
      campaign_id: string | null;
      value_cents: number | null;
      cost_cents: number | null;
      caused_by_outreach: boolean | null;
      stated_caused_by_outreach: boolean | null;
      cause_rule: { reason?: string } | string | null;
      crm_override: boolean;
      source: string | null;
      received_at: Date | string | null;
      email: string | null;
    }>;

    const outcomes = rows.map((r) => ({
      leadId: r.lead_id,
      email: r.email && r.email.length > 0 ? r.email : null,
      campaignId: r.campaign_id,
      // Raw `sql` hands a timestamptz back as a Date on some paths and a string on others —
      // normalize, never `.toISOString()` on the raw value.
      occurredAt: toIsoTimestamp(r.received_at),
      valueCents: typeof r.value_cents === "number" ? r.value_cents : null,
      costCents: typeof r.cost_cents === "number" ? r.cost_cents : null,
      // WHOSE win it was: true — the customer says our outreach caused it; false — they say
      // something else of theirs did, so its value belongs in the brand's own total and NOT in the
      // return computed on our outreach; null — nobody was ever asked, which is neither answer.
      causedByOutreach: typeof r.caused_by_outreach === "boolean" ? r.caused_by_outreach : null,
      ...causeProvenance(r),
      source: statementSourceOf(r.source),
    }));

    res.json({ event, outcomes });
  }),
);

/**
 * Where a row's `causedByOutreach` comes from: a PERSON (their statement on the outcome, or their
 * override of a CRM-evidenced step) or the owner's date RULE, with the reason the rule gave
 * (outcome-cause.ts). Both null when neither has answered yet.
 */
function causeProvenance(r: {
  source: string | null;
  stated_caused_by_outreach: boolean | null;
  cause_rule: { reason?: string } | string | null;
  crm_override: boolean;
}): { causeBasis: "person" | "rule" | null; causeReason: string | null } {
  const person =
    (r.source === "crm" && r.crm_override === true) ||
    (r.source !== "crm" && typeof r.stated_caused_by_outreach === "boolean");
  if (person) return { causeBasis: "person", causeReason: null };
  const rule =
    typeof r.cause_rule === "string"
      ? (JSON.parse(r.cause_rule) as { reason?: string })
      : r.cause_rule;
  if (rule && typeof rule.reason === "string") return { causeBasis: "rule", causeReason: rule.reason };
  return { causeBasis: null, causeReason: null };
}

export default router;
