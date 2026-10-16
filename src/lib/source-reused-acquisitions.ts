import { sql } from "drizzle-orm";
import { APOLLO_SERVICE_API_KEY, APOLLO_SERVICE_URL } from "../config.js";
import { db } from "../db/index.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { OWN_RUNS_RECORDED_SINCE } from "./source-leads-found.js";
import { SOURCE_FOUND_STATUS_REASON } from "./source-stock.js";

/**
 * WHAT AN EARLIER RUN PAID TO FIND THE LEADS A SOURCE FOUND (REUSED-ACQUISITION-COST-1017, owner 2026-10-17:
 * « a lead keeps the price paid to find it »). `GET /internal/source-campaigns/reused-acquisitions`, the sibling of
 * `GET /internal/source-campaigns/leads-found`: features-service prices a sourcing pipe on both.
 *
 * A source's own run can hand out a person an earlier run (another campaign, or none) already paid to reveal, find or
 * verify: its own runs then carry no acquisition cost for that lead (prod 2026-10-14: 367 finds of a41c4e52 cost
 * $1.31 of Jev, while the same org had paid ~$33 in Apollo reveals for them two weeks earlier). Who was found is OURS
 * (the `source_found` rows, the very rows leads-found counts as `ownRuns`); what was paid for whom is apollo-service's
 * (`POST /internal/acquisition-costs`, one call per org, ≤5000 people). Nothing is re-priced here.
 *
 * Scope: OWN-RUN finds only. An on-demand find is filed under the OUTREACH campaign's row (its source is known only to
 * runs-service), and its purchase runs inside the source's serve run: `onDemand` on leads-found is not listed here.
 *
 * FAIL LOUD per org: an org apollo-service did not answer for serves its campaigns with every figure `null` +
 * `unavailableReason`, never 0. Read-only: nothing billed, served or moved.
 */

export const ACQUISITION_COSTS_MAX_PER_CALL = 5000;
const CALL_TIMEOUT_MS = 120_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OwnRunFind {
  rowId: string;
  orgId: string;
  campaignId: string;
  servedAt: string;
  apolloPersonId: string | null;
  email: string | null;
}

export interface SourceReusedAcquisitionRow {
  campaignId: string;
  orgId: string;
  /** Every own-run find of the campaign (= leads-found `ownRuns`). */
  ownRuns: number;
  /** Of them, finds asked of apollo-service (an Apollo person id or an email to ask with). */
  checkedLeads: number;
  /** Of them, finds with neither: never asked, never counted as reused. */
  uncheckedLeads: number;
  reusedLeads: number | null;
  earlierAcquisitionCostInUsdCents: string | null;
  paidByOtherOrgsCostInUsdCents: string | null;
  unavailableReason: string | null;
}

export interface SourceReusedAcquisitions {
  basis: "own_runs";
  recordedSince: string;
  counts: SourceReusedAcquisitionRow[];
  unpricedRunIds: string[];
}

interface ApolloCampaignTotals {
  campaignId: string;
  servedLeads: number;
  reusedLeads: number;
  earlierAcquisitionCostInUsdCents: string;
  paidByOtherOrgsCostInUsdCents: string;
}

export interface OrgAcquisitionAnswer {
  campaigns: ApolloCampaignTotals[];
  unpricedRunIds: string[];
}

export type AskAcquisitionCosts = (orgId: string, finds: OwnRunFind[]) => Promise<OrgAcquisitionAnswer>;

export async function loadOwnRunFindsForAcquisition(): Promise<OwnRunFind[]> {
  const rows = (await db.execute(sql`
    SELECT lc.id, lc.org_id, lc.campaign_id, COALESCE(lc.served_at, lc.created_at) AS served_at, l.apollo_person_id,
           (SELECT m.value FROM lead_contact_methods m
             WHERE m.lead_id = lc.lead_id AND m.channel = 'email'
             ORDER BY m.created_at, m.value LIMIT 1) AS email
      FROM leads_campaigns lc
      JOIN leads l ON l.id = lc.lead_id
     WHERE lc.status_reason = ${SOURCE_FOUND_STATUS_REASON}
  `)) as unknown as Array<{
    id: string;
    org_id: string;
    campaign_id: string;
    served_at: Date | string;
    apollo_person_id: string | null;
    email: string | null;
  }>;
  return rows.map((r) => ({
    rowId: r.id,
    orgId: r.org_id,
    campaignId: r.campaign_id,
    servedAt: new Date(r.served_at).toISOString(),
    apolloPersonId: r.apollo_person_id || null,
    email: r.email || null,
  }));
}

// Cents carry up to 10 decimals (apollo-service passes runs-service numeric(16,10)): summed as scaled integers.
const SCALE = 10n;
function toScaled(cents: string): bigint {
  const neg = cents.startsWith("-");
  const [int, frac = ""] = (neg ? cents.slice(1) : cents).split(".");
  const v = BigInt(int || "0") * 10n ** SCALE + BigInt((frac + "0".repeat(Number(SCALE))).slice(0, Number(SCALE)));
  return neg ? -v : v;
}
function fromScaled(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** SCALE;
  return `${neg ? "-" : ""}${abs / base}.${(abs % base).toString().padStart(Number(SCALE), "0")}`;
}

const askable = (f: OwnRunFind) => !!f.apolloPersonId || !!f.email;

/** apollo-service `POST /internal/acquisition-costs` for one org, chunked at 5000; totals summed across chunks. */
export const askApolloAcquisitionCosts: AskAcquisitionCosts = async (orgId, finds) => {
  const totals = new Map<string, { served: number; reused: number; cost: bigint; other: bigint }>();
  const unpriced = new Set<string>();
  for (let i = 0; i < finds.length; i += ACQUISITION_COSTS_MAX_PER_CALL) {
    const chunk = finds.slice(i, i + ACQUISITION_COSTS_MAX_PER_CALL);
    const servedLeads = chunk.map((f) => ({
      ref: f.rowId,
      servedCampaignId: f.campaignId,
      servedAt: f.servedAt,
      ...(f.apolloPersonId ? { apolloPersonId: f.apolloPersonId } : {}),
      ...(f.email ? { email: f.email } : {}),
    }));
    const response = await fetchWithRetry(`${APOLLO_SERVICE_URL}/internal/acquisition-costs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": APOLLO_SERVICE_API_KEY },
      body: JSON.stringify({ orgId, servedLeads }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`apollo-service acquisition-costs failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
    }
    const body = (await response.json()) as { campaigns?: unknown; unpricedRunIds?: unknown };
    if (!Array.isArray(body.campaigns)) throw new Error("apollo-service acquisition-costs unreadable: no campaigns");
    for (const c of body.campaigns as Array<Record<string, unknown>>) {
      if (
        typeof c?.campaignId !== "string" ||
        typeof c.servedLeads !== "number" ||
        typeof c.reusedLeads !== "number" ||
        typeof c.earlierAcquisitionCostInUsdCents !== "string" ||
        typeof c.paidByOtherOrgsCostInUsdCents !== "string"
      ) {
        throw new Error(`apollo-service acquisition-costs entry unreadable: ${JSON.stringify(c).slice(0, 200)}`);
      }
      const t = totals.get(c.campaignId) ?? { served: 0, reused: 0, cost: 0n, other: 0n };
      t.served += c.servedLeads;
      t.reused += c.reusedLeads;
      t.cost += toScaled(c.earlierAcquisitionCostInUsdCents);
      t.other += toScaled(c.paidByOtherOrgsCostInUsdCents);
      totals.set(c.campaignId, t);
    }
    if (Array.isArray(body.unpricedRunIds)) for (const id of body.unpricedRunIds) if (typeof id === "string") unpriced.add(id);
  }
  return {
    campaigns: [...totals.entries()].map(([campaignId, t]) => ({
      campaignId,
      servedLeads: t.served,
      reusedLeads: t.reused,
      earlierAcquisitionCostInUsdCents: fromScaled(t.cost),
      paidByOtherOrgsCostInUsdCents: fromScaled(t.other),
    })),
    unpricedRunIds: [...unpriced],
  };
};

/** Pure-ish: group finds per org, ask each org once (two at a time), one row per source campaign. */
export async function computeSourceReusedAcquisitions(finds: OwnRunFind[], ask: AskAcquisitionCosts): Promise<SourceReusedAcquisitions> {
  const rows = new Map<string, SourceReusedAcquisitionRow>();
  const byOrg = new Map<string, OwnRunFind[]>();
  for (const f of finds) {
    const r = rows.get(f.campaignId) ?? {
      campaignId: f.campaignId,
      orgId: f.orgId,
      ownRuns: 0,
      checkedLeads: 0,
      uncheckedLeads: 0,
      reusedLeads: 0,
      earlierAcquisitionCostInUsdCents: fromScaled(0n),
      paidByOtherOrgsCostInUsdCents: fromScaled(0n),
      unavailableReason: null,
    };
    r.ownRuns += 1;
    if (askable(f)) {
      r.checkedLeads += 1;
      const list = byOrg.get(f.orgId) ?? [];
      list.push(f);
      byOrg.set(f.orgId, list);
    } else {
      r.uncheckedLeads += 1;
    }
    rows.set(f.campaignId, r);
  }

  const unavailable = (orgId: string, reason: string) => {
    for (const r of rows.values()) {
      if (r.orgId !== orgId) continue;
      r.reusedLeads = null;
      r.earlierAcquisitionCostInUsdCents = null;
      r.paidByOtherOrgsCostInUsdCents = null;
      r.unavailableReason = reason;
    }
  };

  const unpriced = new Set<string>();
  const orgs = [...byOrg.entries()];
  let next = 0;
  const worker = async () => {
    while (next < orgs.length) {
      const [orgId, orgFinds] = orgs[next++];
      if (!UUID_RE.test(orgId)) {
        unavailable(orgId, "org_id_not_uuid");
        continue;
      }
      try {
        const answer = await ask(orgId, orgFinds);
        const asked = new Map<string, number>();
        for (const f of orgFinds) asked.set(f.campaignId, (asked.get(f.campaignId) ?? 0) + 1);
        const byCampaign = new Map(answer.campaigns.map((c) => [c.campaignId, c]));
        for (const [campaignId, n] of asked) {
          const c = byCampaign.get(campaignId);
          const r = rows.get(campaignId)!;
          if (!c || c.servedLeads !== n) {
            console.error(`[lead-service] acquisition-costs answered ${c?.servedLeads ?? "nothing"} of ${n} finds for campaign ${campaignId}`);
            r.reusedLeads = null;
            r.earlierAcquisitionCostInUsdCents = null;
            r.paidByOtherOrgsCostInUsdCents = null;
            r.unavailableReason = "apollo_answer_incomplete";
            continue;
          }
          r.reusedLeads = c.reusedLeads;
          r.earlierAcquisitionCostInUsdCents = c.earlierAcquisitionCostInUsdCents;
          r.paidByOtherOrgsCostInUsdCents = c.paidByOtherOrgsCostInUsdCents;
        }
        for (const id of answer.unpricedRunIds) unpriced.add(id);
      } catch (error) {
        console.error(`[lead-service] acquisition-costs unavailable for org ${orgId}: ${error instanceof Error ? error.message : String(error)}`);
        unavailable(orgId, "apollo_service_unavailable");
      }
    }
  };
  await Promise.all([worker(), worker()]);

  return {
    basis: "own_runs",
    recordedSince: OWN_RUNS_RECORDED_SINCE,
    counts: [...rows.values()].sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0)),
    unpricedRunIds: [...unpriced].sort(),
  };
}

export async function readSourceReusedAcquisitions(ask: AskAcquisitionCosts = askApolloAcquisitionCosts): Promise<SourceReusedAcquisitions> {
  return computeSourceReusedAcquisitions(await loadOwnRunFindsForAcquisition(), ask);
}
