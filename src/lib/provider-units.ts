/**
 * Provider reads of our Units (ENGINE-GET-ASK-1123): the SQL half. Vocabulary, parsing and cursor: provider-units-query.ts.
 *
 * Every read is scoped to the CALLING org, reads our own tables only (no outbound call, no cost, nothing served,
 * claimed or written) and is paged newest first by a keyset on (at, unitId).
 *
 * WHAT A UNIT IS, per outcome, and where it is read:
 *   - `lead_found`: one FIND = the `leads_campaigns` row a serve wrote when it found the person (`recordServed`,
 *     buffer.ts: a fresh serve or a source's own find). Same rule as the ledger backfill (run-outcome-backfill.ts):
 *     `status_reason` `served` or `source_found` AND `status_details` = the serve's own text (`findDetailsSql`), the
 *     person not a journalist of the brand. Never a retry, stock hand-over, released, named or follow-up re-hand (they
 *     bought nobody and write another text). `at` = the row's `served_at`. Known limits of the stored rows, stated in
 *     the OpenAPI: a find row a later round re-opened under another text, or archived by the one-time requeue
 *     (`requeued_serves`), is not listed; a person marked Disqualified at the very moment of the find is listed.
 *   - a fact outcome (`FACT_UNIT_OUTCOMES`): one row of `outcome_fact_declarations` (one per org x brand x lead x
 *     outcome), reversed ones included and flagged. `at` = the instant it was declared at (`occurred_at`; a row from
 *     before migration 0141 = its conversion event's instant once re-dated, else the declaration time).
 *   - `company_researched`: one (run, company domain) whose run paid NEW research (the live `noteResearch` rule, read
 *     as the backfill reads it): a `qualification_checks` row of the org on a lead or a sample company whose verdict
 *     that run recorded, or whose observation that run was charged for. A must-pass check on a candidate is the find's
 *     gate cost (never a Unit), and research a FINDING serve run paid itself rode its `lead_found` (left out).
 *     `at` = the run's latest check on that company.
 */
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { notJournalistSql } from "./followup-queue.js";
import {
  CURSOR_AT,
  NOT_SERVED_TO_ANY,
  UNIT_SUBJECT_SERVICE,
  UnitsQueryError,
  encodeUnitCursor,
  type FactUnitOutcome,
  type UnitsFilters,
} from "./provider-units-query.js";
import { findDetailsSql } from "./run-outcome-backfill.js";
import { SOURCE_FOUND_STATUS_REASON } from "./source-stock.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `leads_campaigns.status_reason` values that are NOT a hand-out to a campaign working the person: another source's
 * find, and the brand's own intake filings (signup, Unibox conversation, stated conversion, link click, social
 * engagement). `notServedTo=any_campaign` ignores those rows.
 */
export const NOT_A_HAND_OUT_REASONS = [
  SOURCE_FOUND_STATUS_REASON,
  "crm_signup",
  "unibox_conversation",
  "tracker_conversion",
  "unit_click",
  "social_engagement",
] as const;

export interface UnitSubject {
  service: typeof UNIT_SUBJECT_SERVICE;
  id: string;
}

export interface LeadFoundUnit {
  unitId: string;
  outcome: "lead_found";
  subject: UnitSubject;
  at: string;
  email: string | null;
  brandId: string | null;
  brandIds: string[];
  campaignId: string;
  runId: string | null;
  madeBy: {
    kind: "source_find" | "serve";
    audienceId: string | null;
    workflowSlug: string | null;
    featureSlug: string | null;
    parentRunId: string | null;
    runRepointed: boolean;
  };
  served: {
    handedToCampaignId: string | null;
    handedAt: string | null;
    setAsideAt: string | null;
    setAsideReason: string | null;
  };
}

export interface FactUnit {
  unitId: string;
  outcome: FactUnitOutcome;
  subject: UnitSubject;
  at: string;
  email: string | null;
  brandId: string;
  campaignId: null;
  runId: string;
  madeBy: {
    performer: Record<string, unknown> | null;
    causedByOutreach: boolean;
    consumedOutcome: string | null;
    consumedBasis: string | null;
    conversionEventId: string | null;
    crmFactId: string | null;
  };
  reversed: boolean;
  reversedAt: string | null;
}

export interface CompanyResearchedUnit {
  unitId: string;
  outcome: "company_researched";
  subject: UnitSubject;
  at: string;
  brandId: string;
  campaignId: null;
  runId: string;
  madeBy: {
    kind: "qualification_check";
    offerIds: string[];
    criterionIds: string[];
    checkedSubjects: string[];
  };
}

export interface UnitsPage<U> {
  units: U[];
  /** Pass back as `cursor`. Null on the last page. */
  nextCursor: string | null;
}

type Row = Record<string, unknown>;

const textArray = (values: readonly string[]): SQL => sql`${sql.param([...values])}::text[]`;
const uuidArray = (values: readonly string[]): SQL => sql`${sql.param([...values])}::uuid[]`;
const atText = (col: string): SQL => sql.raw(`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')`);
const cursorInstant = (at: string): SQL => sql`(${at}::timestamp AT TIME ZONE 'UTC')`;

const str = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x) => x != null).map(String) : []);

function atIso(row: Row, textKey: string): string {
  const text = String(row[textKey] ?? "");
  if (!CURSOR_AT.test(text)) throw new Error(`[lead-service] provider-units: unit ${String(row.unitId)} has no readable instant (${text})`);
  return new Date(`${text}Z`).toISOString();
}
const optionalIso = (v: unknown): string | null => {
  const text = str(v);
  return text === null ? null : new Date(`${text}Z`).toISOString();
};

function pageOf<U>(rows: Row[], limit: number, map: (row: Row) => U): UnitsPage<U> {
  const kept = rows.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    units: kept.map(map),
    nextCursor: rows.length > limit && last !== undefined ? encodeUnitCursor({ at: String(last.atText), unitId: String(last.unitId) }) : null,
  };
}

/**
 * The leads the person filters name (OR'ed), as a CTE. Each branch rides its own index: `idx_lcm_email_lower_value`
 * (address), the primary key (lead id), `idx_lcm_email_domain` (domain of a registered address, post-boot) and
 * `idx_org_lower_primary_domain` + `idx_lo_org` (current employer's domain). Null when no person filter is named.
 */
function peopleCte(filters: UnitsFilters): SQL | null {
  const branches: SQL[] = [];
  if (filters.emails.length > 0) {
    branches.push(sql`SELECT cm.lead_id FROM lead_contact_methods cm WHERE cm.channel = 'email' AND lower(cm.value) = ANY(${textArray(filters.emails)})`);
  }
  if (filters.leadIds.length > 0) branches.push(sql`SELECT unnest(${uuidArray(filters.leadIds)}) AS lead_id`);
  if (filters.domains.length > 0) {
    branches.push(
      sql`SELECT cm.lead_id FROM lead_contact_methods cm WHERE cm.channel = 'email' AND split_part(lower(cm.value), '@', 2) = ANY(${textArray(filters.domains)})`,
    );
    branches.push(sql`
      SELECT lo.lead_id FROM organizations o
      JOIN leads_organizations lo ON lo.organization_id = o.id AND lo.current
      WHERE lower(o.primary_domain) = ANY(${textArray(filters.domains)})`);
  }
  if (branches.length === 0) return null;
  return sql`people AS MATERIALIZED (${sql.join(branches, sql` UNION `)})`;
}

const primaryEmailSql = (leadCol: string): SQL =>
  sql.raw(`(SELECT lower(cm.value) FROM lead_contact_methods cm WHERE cm.lead_id = ${leadCol} AND cm.channel = 'email'
            ORDER BY cm.created_at ASC NULLS LAST, cm.value ASC LIMIT 1)`);

// ─── lead_found ─────────────────────────────────────────────────────────────

function notServedToSql(notServedTo: string): SQL {
  if (notServedTo === NOT_SERVED_TO_ANY) {
    // A source's find nobody took: not handed from the source's stock, and no row of the person under another campaign
    // of a shared brand that works them, written at or after the find. A find made by a direct serve was served to its
    // own campaign at the find: never "not served".
    return sql`lc.status_reason = ${SOURCE_FOUND_STATUS_REASON} AND lc.source_handed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM leads_campaigns o
        WHERE o.lead_id = lc.lead_id AND o.org_id = lc.org_id AND o.campaign_id <> lc.campaign_id
          AND o.brand_ids && lc.brand_ids AND o.status = 'served'
          AND NOT (COALESCE(o.status_reason, '') = ANY(${textArray(NOT_A_HAND_OUT_REASONS)}))
          AND o.served_at >= lc.served_at
      )`;
  }
  // Never handed to THAT campaign: not found under it, not handed to it from stock, no row of the person under it.
  return sql`lc.campaign_id <> ${notServedTo} AND lc.source_handed_to_campaign_id IS DISTINCT FROM ${notServedTo}
    AND NOT EXISTS (
      SELECT 1 FROM leads_campaigns o
      WHERE o.lead_id = lc.lead_id AND o.org_id = lc.org_id AND o.campaign_id = ${notServedTo}
    )`;
}

function toLeadFoundUnit(row: Row): LeadFoundUnit {
  const brandIds = list(row.brandIds);
  const repointed = row.runRepointed === true;
  return {
    unitId: String(row.unitId),
    outcome: "lead_found",
    subject: { service: UNIT_SUBJECT_SERVICE, id: String(row.leadId) },
    at: atIso(row, "atText"),
    email: str(row.email),
    brandId: brandIds[0] ?? null,
    brandIds,
    campaignId: String(row.campaignId),
    runId: repointed ? null : str(row.runId),
    madeBy: {
      kind: row.statusReason === SOURCE_FOUND_STATUS_REASON ? "source_find" : "serve",
      audienceId: str(row.audienceId),
      workflowSlug: str(row.workflowSlug),
      featureSlug: str(row.featureSlug),
      parentRunId: repointed ? null : str(row.parentRunId),
      runRepointed: repointed,
    },
    served: {
      handedToCampaignId: str(row.handedToCampaignId),
      handedAt: optionalIso(row.handedAtText),
      setAsideAt: optionalIso(row.setAsideAtText),
      setAsideReason: str(row.setAsideReason),
    },
  };
}

/** Every find of the org matching the filters, newest first. */
export async function fetchLeadFoundUnits(filters: UnitsFilters): Promise<UnitsPage<LeadFoundUnit>> {
  const people = peopleCte(filters);
  const conditions: SQL[] = [
    sql`lc.org_id = ${filters.orgId}`,
    sql`lc.status_reason IN ('served', ${SOURCE_FOUND_STATUS_REASON})`,
    findDetailsSql("lc.status_details"),
    sql`lc.served_at IS NOT NULL`,
    notJournalistSql("lc"),
  ];
  if (filters.brandId !== undefined) conditions.push(sql`lc.brand_ids @> ARRAY[${filters.brandId}]::text[]`);
  if (filters.campaignId !== undefined) conditions.push(sql`lc.campaign_id = ${filters.campaignId}`);
  if (filters.since !== undefined) conditions.push(sql`lc.served_at >= ${filters.since}::timestamptz`);
  if (filters.until !== undefined) conditions.push(sql`lc.served_at < ${filters.until}::timestamptz`);
  if (filters.notServedTo !== undefined) conditions.push(notServedToSql(filters.notServedTo));
  if (filters.cursor !== undefined) {
    if (!UUID.test(filters.cursor.unitId)) throw new UnitsQueryError("invalid_cursor", "cursor: not a cursor this read issued");
    conditions.push(sql`(lc.served_at, lc.id) < (${cursorInstant(filters.cursor.at)}, ${filters.cursor.unitId}::uuid)`);
  }
  const rows = (await db.execute(sql`
    ${people ? sql`WITH ${people}` : sql``}
    SELECT lc.id::text AS "unitId",
           ${atText("lc.served_at")} AS "atText",
           lc.lead_id::text AS "leadId",
           ${primaryEmailSql("lc.lead_id")} AS "email",
           lc.brand_ids::text[] AS "brandIds",
           lc.campaign_id AS "campaignId",
           lc.run_id AS "runId",
           lc.parent_run_id AS "parentRunId",
           (lc.retry_claimed_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM lead_campaign_run_repoints rp WHERE rp.lead_campaign_id = lc.id)) AS "runRepointed",
           lc.status_reason AS "statusReason",
           lc.audience_id AS "audienceId",
           lc.workflow_slug AS "workflowSlug",
           lc.feature_slug AS "featureSlug",
           lc.source_handed_to_campaign_id AS "handedToCampaignId",
           ${atText("lc.source_handed_at")} AS "handedAtText",
           ${atText("lc.source_set_aside_at")} AS "setAsideAtText",
           lc.source_set_aside_reason AS "setAsideReason"
    FROM leads_campaigns lc
    ${people ? sql`JOIN people p ON p.lead_id = lc.lead_id` : sql``}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY lc.served_at DESC, lc.id DESC
    LIMIT ${filters.limit + 1}
  `)) as unknown as Row[];
  return pageOf(rows, filters.limit, toLeadFoundUnit);
}

// ─── fact outcomes ──────────────────────────────────────────────────────────

function keysetConditions(filters: UnitsFilters): SQL {
  const conditions: SQL[] = [sql`TRUE`];
  if (filters.since !== undefined) conditions.push(sql`u.at >= ${filters.since}::timestamptz`);
  if (filters.until !== undefined) conditions.push(sql`u.at < ${filters.until}::timestamptz`);
  if (filters.cursor !== undefined) {
    conditions.push(sql`(u.at, u.unit_key) < (${cursorInstant(filters.cursor.at)}, ${filters.cursor.unitId}::text)`);
  }
  return sql.join(conditions, sql` AND `);
}

function performerOf(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (JSON.parse(value) as unknown) : value;
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

function toFactUnit(outcome: FactUnitOutcome): (row: Row) => FactUnit {
  return (row) => ({
    unitId: String(row.unitId),
    outcome,
    subject: { service: UNIT_SUBJECT_SERVICE, id: String(row.leadId) },
    at: atIso(row, "atText"),
    email: str(row.email),
    brandId: String(row.brandId),
    campaignId: null,
    runId: String(row.runId),
    madeBy: {
      performer: performerOf(row.performer),
      causedByOutreach: row.causedByOutreach === true,
      consumedOutcome: str(row.consumedOutcome),
      consumedBasis: str(row.consumedBasis),
      conversionEventId: str(row.conversionEventId),
      crmFactId: str(row.crmFactId),
    },
    reversed: row.reversedAtText != null,
    reversedAt: optionalIso(row.reversedAtText),
  });
}

/** Every Unit of one fact outcome the org's leads hold, reversed ones included, newest first. */
export async function fetchFactUnits(outcome: FactUnitOutcome, filters: UnitsFilters): Promise<UnitsPage<FactUnit>> {
  const people = peopleCte(filters);
  const conditions: SQL[] = [sql`d.org_id = ${filters.orgId}`, sql`d.outcome_key = ${outcome}`];
  if (filters.brandId !== undefined) conditions.push(sql`d.brand_id = ${filters.brandId}`);
  const rows = (await db.execute(sql`
    ${people ? sql`WITH ${people}` : sql``}
    SELECT u.unit_key AS "unitId",
           ${atText("u.at")} AS "atText",
           u.lead_id::text AS "leadId",
           ${primaryEmailSql("u.lead_id")} AS "email",
           u.brand_id AS "brandId",
           u.run_id::text AS "runId",
           u.performer AS "performer",
           u.caused_by_outreach AS "causedByOutreach",
           u.consumed_outcome_key AS "consumedOutcome",
           u.consumed_basis AS "consumedBasis",
           u.conversion_event_id::text AS "conversionEventId",
           u.crm_fact_id AS "crmFactId",
           ${atText("u.reversed_at")} AS "reversedAtText"
    FROM (
      SELECT d.*,
             d.run_id::text || ':' || d.outcome_key || ':' || d.lead_id::text AS unit_key,
             COALESCE(d.occurred_at, CASE WHEN d.dated THEN ce.received_at END, d.created_at) AS at
      FROM outcome_fact_declarations d
      ${people ? sql`JOIN people p ON p.lead_id = d.lead_id` : sql``}
      LEFT JOIN conversion_events ce ON ce.id = d.conversion_event_id
      WHERE ${sql.join(conditions, sql` AND `)}
    ) u
    WHERE ${keysetConditions(filters)}
    ORDER BY u.at DESC, u.unit_key DESC
    LIMIT ${filters.limit + 1}
  `)) as unknown as Row[];
  return pageOf(rows, filters.limit, toFactUnit(outcome));
}

// ─── company_researched ─────────────────────────────────────────────────────

function toCompanyResearchedUnit(row: Row): CompanyResearchedUnit {
  return {
    unitId: String(row.unitId),
    outcome: "company_researched",
    subject: { service: UNIT_SUBJECT_SERVICE, id: String(row.domain) },
    at: atIso(row, "atText"),
    brandId: String(row.brandId),
    campaignId: null,
    runId: String(row.runId),
    madeBy: {
      kind: "qualification_check",
      offerIds: list(row.offerIds),
      criterionIds: list(row.criterionIds),
      checkedSubjects: list(row.checkedSubjects),
    },
  };
}

/** Every (run, company) the org paid new research for, newest first. */
export async function fetchCompanyResearchedUnits(filters: UnitsFilters): Promise<UnitsPage<CompanyResearchedUnit>> {
  const conditions: SQL[] = [
    sql`c.org_id = ${filters.orgId}`,
    sql`c.run_id IS NOT NULL`,
    sql`c.domain IS NOT NULL`,
    sql`(c.subject LIKE 'lead:%' OR c.subject LIKE 'company:%')`,
    // The run paid NEW research: it recorded the verdict, or was charged for the observation (noteResearch).
    sql`(lower(v.run_id) = lower(c.run_id) OR (lower(o.run_id) = lower(c.run_id) AND o.vendor_cost_micro > 0))`,
    // Research a FINDING serve run paid itself rode its lead_found (one outcome per run): not a Unit of this outcome.
    sql`NOT EXISTS (
      SELECT 1 FROM leads_campaigns f
      WHERE f.lead_id = CASE WHEN c.subject ~ '^lead:[0-9a-fA-F-]{36}$' THEN substr(c.subject, 6)::uuid END
        AND f.org_id = c.org_id AND lower(f.run_id) = lower(c.run_id)
        AND f.status_reason IN ('served', ${SOURCE_FOUND_STATUS_REASON}) AND ${findDetailsSql("f.status_details")}
    )`,
  ];
  if (filters.brandId !== undefined) conditions.push(sql`c.brand_id = ${filters.brandId}`);
  if (filters.domains.length > 0) conditions.push(sql`c.domain = ANY(${textArray(filters.domains)})`);
  const rows = (await db.execute(sql`
    SELECT u.unit_key AS "unitId",
           ${atText("u.at")} AS "atText",
           u.run_id AS "runId",
           u.domain AS "domain",
           u.brand_id AS "brandId",
           u.offer_ids AS "offerIds",
           u.criterion_ids AS "criterionIds",
           u.checked_subjects AS "checkedSubjects"
    FROM (
      SELECT lower(c.run_id) || ':' || c.domain AS unit_key,
             lower(c.run_id) AS run_id,
             c.domain,
             c.brand_id,
             max(c.checked_at) AS at,
             array_agg(DISTINCT c.offer_id) AS offer_ids,
             array_agg(DISTINCT c.criterion_id::text) AS criterion_ids,
             array_agg(DISTINCT c.subject) AS checked_subjects
      FROM qualification_checks c
      JOIN qualification_verdicts v ON v.id = c.verdict_id
      JOIN qualification_observations o ON o.id = v.observation_id
      WHERE ${sql.join(conditions, sql` AND `)}
      GROUP BY lower(c.run_id), c.domain, c.brand_id
    ) u
    WHERE ${keysetConditions(filters)}
    ORDER BY u.at DESC, u.unit_key DESC
    LIMIT ${filters.limit + 1}
  `)) as unknown as Row[];
  return pageOf(rows, filters.limit, toCompanyResearchedUnit);
}
