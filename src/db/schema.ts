import {
  pgTable,
  uuid,
  text,
  timestamp,
  date,
  integer,
  numeric,
  boolean,
  uniqueIndex,
  index,
  jsonb,
  doublePrecision,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// --- Leads — global identity registry ---
export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apolloPersonId: text("apollo_person_id"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    name: text("name"),
    linkedinUrl: text("linkedin_url"),
    photoUrl: text("photo_url"),
    headline: text("headline"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    seniority: text("seniority"),
    // Recipient's IANA timezone (e.g. "America/New_York"), sourced from upstream
    // (human-service / apollo-service) off the person's location. Forwarded on the
    // canonical lead so downstream send paths (email-gateway → instantly-service)
    // can schedule cold email in the recipient's local business hours. Null when
    // upstream provides none — downstream falls back to a safe default.
    timezone: text("timezone"),
    // Language(s) this person plausibly conducts business in, ISO 639-1 lowercase
    // codes, ORDERED most-plausible-first. Derived and owned by human-service (see
    // its `businessLanguages`); lead-service only carries it. A Postgres array is
    // used precisely because it preserves order — the consumer selects by position,
    // so a set or a re-sorted list would silently break it. Empty array means the
    // producer had no usable signal; that is distinct from ["en"] (= known English),
    // and NULL means the lead predates this being carried. Never derived here.
    businessLanguages: text("business_languages").array(),
    departments: text("departments").array(),
    subdepartments: text("subdepartments").array(),
    functions: text("functions").array(),
    twitterUrl: text("twitter_url"),
    githubUrl: text("github_url"),
    facebookUrl: text("facebook_url"),
    metadata: jsonb("metadata"),
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_leads_apollo_person_id").on(table.apolloPersonId)],
);

// --- Lead contact methods — polymorphic (email, phone, twitter, etc.) ---
export const leadContactMethods = pgTable(
  "lead_contact_methods",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    value: text("value").notNull(),
    status: text("status"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lcm_lead_channel_value").on(table.leadId, table.channel, table.value),
    uniqueIndex("idx_lcm_channel_value").on(table.channel, table.value),
    index("idx_lcm_value").on(table.value),
  ],
);

// --- Organizations — global org registry ---
export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    apolloOrganizationId: text("apollo_organization_id"),
    name: text("name"),
    primaryDomain: text("primary_domain"),
    websiteUrl: text("website_url"),
    industry: text("industry"),
    estimatedNumEmployees: integer("estimated_num_employees"),
    annualRevenue: numeric("annual_revenue"),
    logoUrl: text("logo_url"),
    shortDescription: text("short_description"),
    linkedinUrl: text("linkedin_url"),
    twitterUrl: text("twitter_url"),
    facebookUrl: text("facebook_url"),
    blogUrl: text("blog_url"),
    crunchbaseUrl: text("crunchbase_url"),
    foundedYear: integer("founded_year"),
    city: text("city"),
    state: text("state"),
    country: text("country"),
    streetAddress: text("street_address"),
    postalCode: text("postal_code"),
    technologyNames: text("technology_names").array(),
    industries: text("industries").array(),
    secondaryIndustries: text("secondary_industries").array(),
    latestFundingStage: text("latest_funding_stage"),
    latestFundingRoundDate: date("latest_funding_round_date"),
    totalFunding: numeric("total_funding"),
    totalFundingPrinted: text("total_funding_printed"),
    fundingEvents: jsonb("funding_events"),
    retailLocationCount: integer("retail_location_count"),
    publiclyTradedSymbol: text("publicly_traded_symbol"),
    publiclyTradedExchange: text("publicly_traded_exchange"),
    primaryPhone: text("primary_phone"),
    seoDescription: text("seo_description"),
    angellistUrl: text("angellist_url"),
    numSuborganizations: integer("num_suborganizations"),
    alexaRanking: integer("alexa_ranking"),
    keywords: text("keywords").array(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_organizations_apollo_organization_id").on(table.apolloOrganizationId),
  ],
);

// --- Lead employment history (M:N leads <-> organizations) ---
export const leadsOrganizations = pgTable(
  "leads_organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    title: text("title"),
    startDate: date("start_date"),
    endDate: date("end_date"),
    current: boolean("current").notNull().default(false),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lo_lead_org_start").on(table.leadId, table.organizationId, table.startDate),
    index("idx_lo_lead_current").on(table.leadId, table.current),
  ],
);

// --- Leads ↔ campaigns: per-campaign lifecycle ---
export const leadsCampaigns = pgTable(
  "leads_campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id),
    campaignId: text("campaign_id").notNull(),
    orgId: text("org_id").notNull(),
    brandIds: text("brand_ids").array().notNull(),
    status: text("status").notNull().default("buffered"),
    statusReason: text("status_reason"),
    statusDetails: text("status_details"),
    pushRunId: text("push_run_id"),
    parentRunId: text("parent_run_id"),
    runId: text("run_id"),
    userId: text("user_id"),
    workflowSlug: text("workflow_slug"),
    featureSlug: text("feature_slug"),
    goal: text("goal"),
    activeGoalId: text("active_goal_id"),
    brandProfileId: text("brand_profile_id"),
    audienceId: text("audience_id"),
    // Audit trail for the one-time served-lead email repair
    // (scripts/repair-served-lead-emails.ts). Rows served before the
    // email-owner-first identity fix were attributed to a lead that could never
    // carry the person's email (another lead already owned it), so their
    // delivery status was unresolvable forever. The repair re-points lead_id to
    // the owning lead and records the PREVIOUS lead_id here. NULL on every row
    // the repair never touched; the serve path never writes it.
    repointedFromLeadId: uuid("repointed_from_lead_id"),
    // --- Paid-pool retry (src/lib/retry-pool.ts) ---
    // A serve is paid for and suppressed for three months the moment it happens, so a
    // downstream failure after it strands a prospect the brand can no longer reach. The
    // pool re-serves those people before buying new ones; these three columns are its
    // state, and none of them changes what `status` means (a served row stays 'served',
    // so the delivery overlay and the read paths' winner ordering are untouched).
    //
    // sent_at          — terminal. An email went out; this row leaves the pool for good
    //                    and is never re-queried against email-gateway.
    // retry_claimed_at — the claim lease. Written by the conditional UPDATE that makes
    //                    two concurrent pulls unable to take the same person, and read
    //                    back as the queue position so a repeatedly-failing person moves
    //                    to the back instead of blocking the head.
    // retry_count      — how many times this paid serve has been handed out again.
    sentAt: timestamp("sent_at", { withTimezone: true }),
    retryClaimedAt: timestamp("retry_claimed_at", { withTimezone: true }),
    retryCount: integer("retry_count").notNull().default(0),
    // sender_closed_at — terminal WITHOUT a send. The sender stated it is finished with this
    //                    person in this campaign and will answer any further hand-off as a
    //                    duplicate that sends nothing; the row leaves the pool for good. Kept
    //                    apart from sent_at, which means an email went out.
    senderClosedAt: timestamp("sender_closed_at", { withTimezone: true }),
    // --- Follow-up queue (src/lib/followup-queue.ts) ---
    // What we owe this person NEXT, and when. Once somebody shows a sales interest we owe them an
    // answer now and, if they go quiet, further answers at growing intervals, indefinitely, until
    // they book, opt out, or answer again. The debt belongs to the (lead, campaign) pair, which is
    // this row. None of it changes what `status` means.
    //
    // followup_due_at         — when we next owe an action. NULL = nothing owed right now. The
    //                           queue's ordering key: oldest due first, so a backlog cannot starve
    //                           the people who have waited longest.
    // followup_claimed_at     — the claim lease. The conditional UPDATE that writes it is what
    //                           stops two concurrent workers answering the same prospect twice. It
    //                           expires, so a worker that dies mid-answer strands nobody.
    // followup_count          — how many follow-ups we have taken. Recorded, never a cap: there is
    //                           no ceiling on follow-ups, the growing intervals are the limit, and
    //                           the interval is the worker's per-lead choice, not a ladder here.
    // followup_last_action_at — when we last acted.
    // followup_stopped_reason — why the schedule is empty, when it is. Stated by the caller.
    followupDueAt: timestamp("followup_due_at", { withTimezone: true }),
    followupClaimedAt: timestamp("followup_claimed_at", { withTimezone: true }),
    followupCount: integer("followup_count").notNull().default(0),
    followupLastActionAt: timestamp("followup_last_action_at", { withTimezone: true }),
    followupStoppedReason: text("followup_stopped_reason"),
    servedAt: timestamp("served_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lc_lead_campaign").on(table.leadId, table.campaignId),
    index("idx_lc_org_campaign_status").on(table.orgId, table.campaignId, table.status),
    index("idx_lc_brand_ids").using("gin", table.brandIds),
    index("idx_lc_org").on(table.orgId),
    index("idx_lc_campaign").on(table.campaignId),
    index("idx_lc_user").on(table.userId),
    // The retry pool's only read: this campaign's non-terminal serves, oldest first.
    index("idx_lc_retry_pool").on(table.orgId, table.campaignId, table.retryClaimedAt),
    // The follow-up queue's only read: this campaign's due rows, oldest due first.
    index("idx_lc_followup_queue").on(table.orgId, table.campaignId, table.followupDueAt),
    index("idx_lc_persona_attribution").on(
      table.orgId,
      table.featureSlug,
      table.goal,
      table.activeGoalId,
      table.brandProfileId,
      table.audienceId,
      table.status,
    ),
  ],
);

// --- Follow-up actions ledger (src/lib/followup-actions.ts, migration 0045) ---
// WHO acted on a follow-up row. The queue's own columns on leads_campaigns say what is owed and
// when; they never said which campaign's worker claimed or answered the person, and a campaign
// performing an internal leg (ai-meeting-booking) claims rows HELD by another campaign (its
// predecessor), so it owns no lifecycle row of its own. Append-only, written in the same statement
// as the claim / the 'acted' write. No foreign key: the paid-pool requeue deletes lifecycle rows,
// and a record of what happened must survive that.
//
// held_by_campaign_id — the campaign of the lifecycle row (the one that holds the person).
// acting_campaign_id  — the campaign the worker was dispatched for (x-campaign-id). NULL when the
//                       caller named none: never guessed from the held campaign.
// action              — 'claimed' (handed to a worker) | 'acted' (the worker answered them).
// source / source_ref — 'live', or 'windmill_backfill' with the windmill job id it was read from.
export const followupActions = pgTable(
  "followup_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandIds: text("brand_ids").array().notNull(),
    leadCampaignId: uuid("lead_campaign_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    heldByCampaignId: text("held_by_campaign_id").notNull(),
    actingCampaignId: text("acting_campaign_id"),
    runId: text("run_id"),
    action: text("action").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    source: text("source").notNull().default("live"),
    sourceRef: text("source_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_fa_acting_campaign").on(table.actingCampaignId, table.action),
    index("idx_fa_brand_ids").using("gin", table.brandIds),
    uniqueIndex("idx_fa_source_ref")
      .on(table.sourceRef)
      .where(sql`source_ref IS NOT NULL`),
  ],
);

// --- Apollo strategies per campaign (multi-strategy cursor) ---
export const campaignsApolloStrategies = pgTable(
  "campaigns_apollo_strategies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    strategies: jsonb("strategies").notNull().default(sql`'[]'::jsonb`),
    currentIndex: integer("current_index").notNull().default(0),
    // apify pagination is client-managed; persist the offset for the current
    // strategy so it survives across buffer/next calls. apollo ignores this
    // (its cursor is server-managed by the gateway, keyed on org + campaign).
    apifyOffset: integer("apify_offset").notNull().default(0),
    exhausted: boolean("exhausted").notNull().default(false),
    exhaustionReason: text("exhaustion_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cas_org_campaign").on(table.orgId, table.campaignId),
  ],
);

// --- Idempotency cache (kept) ---
export const idempotencyCache = pgTable(
  "idempotency_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    idempotencyKey: text("idempotency_key").notNull(),
    orgId: text("org_id").notNull(),
    response: jsonb("response").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("idx_idempotency_key").on(table.idempotencyKey)],
);

// --- Conversion tracking (beta) ---
// One publishable write-key per brand. The token is embedded in a client-side
// JS pixel on the brand's own website, so it is NOT a secret — stored plaintext,
// returned in full. It can only write conversion events for its one brand; it can
// never read anything. Rotation is the abuse remedy (old token → 401).
export const brandConversionTokens = pgTable(
  "brand_conversion_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: text("brand_id").notNull(),
    orgId: text("org_id").notNull(),
    token: text("token").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    // Liveness heartbeat: last time the client's on-page tag fired a { event: "ping" }.
    // Derives the "tracker is alive" signal BEFORE any real conversion arrives. A ping
    // is NOT a conversion — it never lands in conversion_events, never runs attribution.
    lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("idx_bct_brand_id").on(table.brandId),
    uniqueIndex("idx_bct_token").on(table.token),
  ],
);

// A conversion event reported by a client's website, plus the attribution result.
// Every row is fail-loud provenance: it stores every identity field received and the
// full match decision (method, confidence, status, candidateCount) so a reviewer can
// audit exactly why a conversion was (or was not) credited to a lead.
export const conversionEvents = pgTable(
  "conversion_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    brandId: text("brand_id").notNull(),
    orgId: text("org_id").notNull(),
    event: text("event").notNull(), // canonical: "signup" | "meeting_booked" | "form_submission" | "sale" (legacy "purchase" normalized to "sale" at write)
    email: text("email"),
    phone: text("phone"),
    firstName: text("first_name"),
    lastName: text("last_name"),
    companyUrl: text("company_url"),
    dedupeKey: text("dedupe_key"), // client-provided key, verbatim (provenance)
    // Effective uniqueness signature. Null when there is no dedupe basis
    // (no dedupeKey and no email/phone) — such rows always insert. The unique
    // index is partial (WHERE dedupe_signature IS NOT NULL).
    dedupeSignature: text("dedupe_signature"),
    valueCents: integer("value_cents"),
    // What the CUSTOMER spent getting the lead through this step — their money, never ours. The
    // platform automates the first leg of a sales funnel and the customer performs the rest (they
    // run the meeting, they close the deal), so they are the only one who can state what that leg
    // cost. Stating it is mandatory at the API, so a hand-stated outcome always carries one.
    // NULL means nobody was ever asked (every row written before this shipped, and every
    // tracker-reported event, which observes a page load and knows nothing about spend); 0 means
    // somebody answered zero. The two are deliberately distinguishable. This NEVER enters the
    // platform's cost ledger: no runs-service cost is declared for it and nothing is billed.
    costCents: integer("cost_cents"),
    // WHOSE win was it. A brand contacts people through us AND through everything else it already
    // does — referrals, conferences, an existing pipeline, another agency — so some of the people
    // we email go on to buy for reasons that have nothing to do with us. true = the customer says
    // our outreach caused this outcome; false = they say something else of theirs did (still a
    // REAL outcome: recorded, counted among the brand's own, never a refusal); NULL = nobody was
    // ever asked (every row written before this shipped, and every tracker-reported event — a
    // page-load tag cannot know WHY somebody bought). Defaulting the historical rows either way
    // would fabricate an answer nobody gave, so the column is nullable and stays that way.
    //
    // Deliberately NOT `attributionStatus` (attributed / needs_review / unmatched): that answers
    // "did we manage to identify who this was", this answers "did our outreach cause this deal".
    //
    // Since 0044 this is the EFFECTIVE answer on every row: a person's statement when there is one,
    // else the owner's date rule (src/lib/outcome-cause.ts) — "after our first delivered email to
    // that person -> ours, before -> not ours, undated / unmatched / never delivered -> null". NULL
    // is still never defaulted to either answer; the rule only answers where its inputs exist.
    causedByOutreach: boolean("caused_by_outreach"),
    // What a PERSON stated, kept apart from the effective answer above so a restatement without a
    // cause returns the row to the rule rather than keeping an answer nobody repeated. NULL = no
    // person answered. Never written on a CRM row, whose override lives in
    // lead_step_cause_statements.
    statedCausedByOutreach: boolean("stated_caused_by_outreach"),
    // On a non-CRM row: the rule's own answer, the REASON it gave and the inputs it was computed
    // from ({causedByOutreach, reason, firstDeliveredAt, leadId, occurredAt}). A CRM row keeps the
    // same thing in crm_evidence.rule.
    causeRule: jsonb("cause_rule"),
    matchedLeadId: uuid("matched_lead_id").references(() => leads.id, {
      onDelete: "set null",
    }),
    // "email" | "phone" | "domain_name" | "full_name" | "last_name" | null
    matchMethod: text("match_method"),
    // "deterministic" | "strong" | "probabilistic" | "unmatched"
    matchConfidence: text("match_confidence").notNull(),
    // "attributed" | "needs_review" | "unmatched"
    attributionStatus: text("attribution_status").notNull(),
    candidateCount: integer("candidate_count").notNull().default(0),
    // WHEN the outcome happened. The tracker stamps the moment it received the event; a human
    // stating a past fact supplies the date, so the by-day series places it on the right day.
    // NULLABLE since 0040: an outcome the customer's CRM evidences with no date is UNDATED, and every
    // read answers it in its `undated` bucket rather than on a fabricated day. Every other writer
    // still gets the default.
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow(),
    // "tracker" (reported by the client's website) | "manual" (stated by a human about a lead we
    // already know by id). Frozen at write; what makes the two distinguishable after the fact
    // WITHOUT changing what either counts toward — every count reads both.
    source: text("source").notNull().default("tracker"),
    // The campaign a hand-stated outcome was stated on. NULL for a tracker event: a website pixel
    // knows the brand and nothing about which campaign reached the person.
    campaignId: text("campaign_id"),
    // The leads_campaigns row a human named (the id a list row already carries).
    leadCampaignId: uuid("lead_campaign_id"),
    statedByUserId: text("stated_by_user_id"),
    note: text("note"),
    /**
     * A hand-stated outcome somebody TOOK BACK — wrong lead, wrong step, a misread reply. Not a
     * third kind of statement: it is the absence of one, so every read filters `withdrawn_at IS
     * NULL` and the step falls back to whatever the remaining statements imply. The row survives
     * because what somebody stated, and the fact they later withdrew it, are both part of the
     * record. Distinct from `lead_step_disqualifications.retracted_at`, which means an outcome
     * SUPERSEDED a "never"; this means the author says it should never have been stated at all.
     * Restating the same step clears it (the existing upsert is the same statement, made again).
     */
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnByUserId: text("withdrawn_by_user_id"),
    /**
     * On a `source = 'crm'` row only: what the customer's CRM evidence IS (the CRM contact, its
     * source and id, which date `received_at` is) and the whose-win RULE's own answer with its
     * input. `caused_by_outreach` holds the EFFECTIVE answer (a person's override, else the rule);
     * this keeps the rule's so a withdrawn override restores it exactly. See crm-evidence.ts.
     */
    crmEvidence: jsonb("crm_evidence"),
  },
  (table) => [
    uniqueIndex("idx_ce_brand_dedupe_signature")
      .on(table.brandId, table.dedupeSignature)
      .where(sql`dedupe_signature IS NOT NULL`),
    index("idx_ce_brand_event").on(table.brandId, table.event),
    index("idx_ce_matched_lead").on(table.matchedLeadId),
    index("idx_ce_brand_source").on(table.brandId, table.source),
    index("idx_ce_lead_campaign").on(table.leadCampaignId),
  ],
);

// --- "This will never happen": a step a lead is DEAD at ---
//
// The negative twin of a conversion event, and deliberately NOT one: a "won't book" / "won't
// attend" / "won't buy" is not an outcome and nothing counts it, which is enforced by it living
// outside conversion_events entirely rather than by a filter every consumer must remember. Its
// only job is to let a reader tell a lead that is dead at a step from one still pending — the
// difference between a cost-per-acquisition denominator that is still waiting and one that never
// will be. One row per (person, campaign, step): restating corrects, never accumulates.
export const leadStepDisqualifications = pgTable(
  "lead_step_disqualifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** id of the leads_campaigns row the statement was made on */
    leadCampaignId: uuid("lead_campaign_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    brandId: text("brand_id").notNull(),
    orgId: text("org_id").notNull(),
    /** one of LEAD_STEP_OUTCOMES — the step this person will never reach */
    step: text("step").notNull(),
    /**
     * What the CUSTOMER spent on this leg before concluding it will never complete. A dead leg
     * still costs — the meeting was run, the call was taken — and a cost of acquisition that
     * ignores it is too good. Same three states as on a conversion event: NULL = nobody was ever
     * asked (rows written before this shipped), 0 = somebody answered zero. Never billed, never
     * declared to the platform's cost ledger.
     */
    costCents: integer("cost_cents"),
    note: text("note"),
    statedByUserId: text("stated_by_user_id"),
    /**
     * A "never" contradicted by an outcome is RETRACTED, never deleted: the record of what a
     * person stated is what makes this auditable, so every read filters `retracted_at IS NULL`
     * and the row survives. `retracted_by_step` is the outcome that retracted it — the same step
     * for the same-step rule, a step only reachable through it for the leg-graph rule.
     */
    retractedAt: timestamp("retracted_at", { withTimezone: true }),
    retractedByStep: text("retracted_by_step"),
    retractedByUserId: text("retracted_by_user_id"),
    /**
     * The author TOOK THE STATEMENT BACK. A different fact from `retracted_at`: retraction is the
     * leg graph resolving a contradiction (an outcome proved the "never" wrong), withdrawal is the
     * person saying they should never have stated it. Every read filters both, the row survives,
     * and restating clears the mark.
     */
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnByUserId: text("withdrawn_by_user_id"),
    /**
     * `manual` — a person stated it. `crm` — the customer's own CRM evidences it (a meeting their
     * CRM says was not held, a deal it says was lost) for a lead PAIRED with that CRM contact.
     * Only a `manual` row is a person's statement, so only a `manual` row can be withdrawn here.
     */
    source: text("source").notNull().default("manual"),
    /** On a `crm` row: when their CRM says it happened. NULL when it gave no date. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    /** On a `crm` row: what the evidence is. See crm-evidence.ts. */
    crmEvidence: jsonb("crm_evidence"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lsd_lead_campaign_step").on(table.leadId, table.campaignId, table.step),
    index("idx_lsd_brand_step").on(table.brandId, table.step),
    index("idx_lsd_brand_source").on(table.brandId, table.source),
  ],
);

/**
 * A PERSON saying whose win a step the customer's CRM evidences was — overriding the date rule
 * (crm-evidence.ts). Keyed on the PERSON and the step within a brand, because the CRM evidence is
 * about the person, not about one campaign row. Retractable, never deleted: withdrawing marks the
 * row and the rule's answer stands again; restating clears the mark through the same upsert.
 */
export const leadStepCauseStatements = pgTable(
  "lead_step_cause_statements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    step: text("step").notNull(),
    causedByOutreach: boolean("caused_by_outreach").notNull(),
    note: text("note"),
    statedByUserId: text("stated_by_user_id"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnByUserId: text("withdrawn_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_lscs_brand_lead_step").on(table.brandId, table.leadId, table.step),
  ],
);

// --- Requeued serves: audit + undo ledger for the one-time uncontacted-serve recovery ---
//
// A serve that was paid for and then never reached the vendor leaves a
// status='served' lifecycle row that idx_lc_lead_campaign makes permanent: the
// serve path's ON CONFLICT DO NOTHING would keep the stale row (old run ids, old
// served_at) if the person were re-served to the campaign that lost them. The
// recovery (scripts/requeue-uncontacted-serves.ts) archives the whole
// leads_campaigns row here verbatim and deletes it, so the person is un-served
// for that campaign and a genuine re-serve records cleanly. The serve path never
// writes this table; it exists only so the repair is traceable and reversible.
export const requeuedServes = pgTable(
  "requeued_serves",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** id of the leads_campaigns row that was deleted */
    leadCampaignId: uuid("lead_campaign_id").notNull(),
    leadId: uuid("lead_id").notNull(),
    campaignId: text("campaign_id").notNull(),
    orgId: text("org_id").notNull(),
    brandIds: text("brand_ids").array().notNull(),
    /** the registered email the no-contact decision was made on */
    email: text("email").notNull(),
    /** which recovery produced this row (see REQUEUE_REASON in the script) */
    reason: text("reason").notNull(),
    /** the deleted leads_campaigns row, verbatim — the undo source */
    rowSnapshot: jsonb("row_snapshot").notNull(),
    requeuedAt: timestamp("requeued_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_requeued_serves_lead_campaign_reason").on(
      table.leadId,
      table.campaignId,
      table.reason,
    ),
    index("idx_requeued_serves_reason").on(table.reason),
    index("idx_requeued_serves_brand_ids").using("gin", table.brandIds),
  ],
);

// --- CRM pairings: which people in the customer's own CRM are leads we emailed ---
//
// Three tables, one per kind of fact, because they have different lifetimes and different authors.
// Nothing here is derived on read — a pairing has to resolve the same way twice, or the customer's
// table changes under them between page loads.
//
// `crm_contact_id` is crm-service's own contacts uuid, held as text: it is a FOREIGN key in the
// plain sense (another service owns that row) and there is nothing here to reference.

/**
 * The identity waterfall's answer for one CRM contact, FROZEN.
 *
 * The matcher is `matchConversion` (src/lib/conversions.ts) — the same one that attributes an
 * inbound conversion event, reused rather than reimplemented. Its answer is written once and then
 * read; it is deliberately never recomputed on a read, which is what makes the view stable. What
 * the answer is WORTH is decided separately, on read, by src/lib/crm-pairing.ts.
 */
export const crmPairingMatches = pgTable(
  "crm_pairing_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    /** crm-service `contacts.id` for the mirrored contact. */
    crmContactId: text("crm_contact_id").notNull(),
    /** The winning candidate, or NULL when the waterfall found nobody. */
    matchedLeadId: uuid("matched_lead_id").references(() => leads.id, { onDelete: "set null" }),
    /** One of MatchMethod — email | phone | domain_name | full_name | last_name, NULL when unmatched. */
    matchMethod: text("match_method"),
    /** One of MatchConfidence — deterministic | strong | probabilistic | unmatched. */
    matchConfidence: text("match_confidence").notNull(),
    /** How many candidates the winning tier surfaced. >1 on a weak tier is the ambiguity itself. */
    candidateCount: integer("candidate_count").notNull().default(0),
    matchedAt: timestamp("matched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cpm_brand_contact").on(table.brandId, table.crmContactId),
    index("idx_cpm_brand_lead").on(table.brandId, table.matchedLeadId),
  ],
);

/**
 * A similarity judgment, FROZEN with the model release that produced it.
 *
 * Asked only where the deterministic signals could not decide, asked once, and never re-asked on
 * read. The release is stored rather than an alias because an alias moves to a new model without
 * notice, and a frozen answer nobody can attribute to a release is not auditable.
 */
export const crmPairingJudgments = pgTable(
  "crm_pairing_judgments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    crmContactId: text("crm_contact_id").notNull(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** The vendor's own yes-probability, 0..1, stored as it came. Never rounded to a verdict. */
    samePersonProbability: doublePrecision("same_person_probability").notNull(),
    /** e.g. `jev-1.13.0` — the release the vendor reported serving, never the alias asked for. */
    judgmentModel: text("judgment_model").notNull(),
    judgedAt: timestamp("judged_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cpj_brand_contact_lead_model").on(
      table.brandId,
      table.crmContactId,
      table.leadId,
      table.judgmentModel,
    ),
    index("idx_cpj_brand_contact").on(table.brandId, table.crmContactId),
  ],
);

/**
 * A HUMAN's statement about one pairing. Outranks the signal and the judgment alike.
 *
 * Same posture as every other statement in this service: NOTHING IS DELETED. Withdrawing marks the
 * row and every read filters `withdrawn_at IS NULL`; restating clears the mark through the same
 * upsert. That is what makes a re-run of the matcher unable to resurrect something a person
 * already rejected — the ruling is keyed on the PAIR, not on a matcher run.
 */
export const crmPairingRulings = pgTable(
  "crm_pairing_rulings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id").notNull(),
    brandId: text("brand_id").notNull(),
    crmContactId: text("crm_contact_id").notNull(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    /** `accepted` | `rejected` — the person's own words about whether these are one human. */
    ruling: text("ruling").notNull(),
    note: text("note"),
    statedByUserId: text("stated_by_user_id"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnByUserId: text("withdrawn_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("idx_cpr_brand_contact_lead").on(table.brandId, table.crmContactId, table.leadId),
    index("idx_cpr_brand_live").on(table.brandId),
  ],
);

// --- Type exports ---
export type Lead = typeof leads.$inferSelect;
export type NewLead = typeof leads.$inferInsert;
export type LeadContactMethod = typeof leadContactMethods.$inferSelect;
export type NewLeadContactMethod = typeof leadContactMethods.$inferInsert;
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type LeadOrganization = typeof leadsOrganizations.$inferSelect;
export type NewLeadOrganization = typeof leadsOrganizations.$inferInsert;
export type LeadCampaign = typeof leadsCampaigns.$inferSelect;
export type NewLeadCampaign = typeof leadsCampaigns.$inferInsert;
export type CampaignApolloStrategies = typeof campaignsApolloStrategies.$inferSelect;
export type NewCampaignApolloStrategies = typeof campaignsApolloStrategies.$inferInsert;
export type IdempotencyCacheRow = typeof idempotencyCache.$inferSelect;
export type NewIdempotencyCacheRow = typeof idempotencyCache.$inferInsert;
export type BrandConversionToken = typeof brandConversionTokens.$inferSelect;
export type NewBrandConversionToken = typeof brandConversionTokens.$inferInsert;
export type ConversionEvent = typeof conversionEvents.$inferSelect;
export type NewConversionEvent = typeof conversionEvents.$inferInsert;
export type RequeuedServe = typeof requeuedServes.$inferSelect;
export type NewRequeuedServe = typeof requeuedServes.$inferInsert;
export type LeadStepDisqualification = typeof leadStepDisqualifications.$inferSelect;
export type NewLeadStepDisqualification = typeof leadStepDisqualifications.$inferInsert;
export type CrmPairingMatch = typeof crmPairingMatches.$inferSelect;
export type NewCrmPairingMatch = typeof crmPairingMatches.$inferInsert;
export type CrmPairingJudgmentRow = typeof crmPairingJudgments.$inferSelect;
export type NewCrmPairingJudgmentRow = typeof crmPairingJudgments.$inferInsert;
export type CrmPairingRulingRow = typeof crmPairingRulings.$inferSelect;
export type NewCrmPairingRulingRow = typeof crmPairingRulings.$inferInsert;
