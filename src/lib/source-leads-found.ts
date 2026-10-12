import { sql } from "drizzle-orm";
import { CAMPAIGN_SERVICE_API_KEY, CAMPAIGN_SERVICE_URL } from "../config.js";
import { db } from "../db/index.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { SOURCE_FOUND_STATUS_REASON } from "./source-stock.js";

/**
 * LEADS FOUND PER SOURCE CAMPAIGN, FLEET-WIDE, BOTH MODES (LEADS-ONLY-FUNNEL-CAMPAIGN, 2026-10-12).
 * `GET /internal/source-campaigns/leads-found`: features-service measures a sourcing pipe on it.
 *
 * A source finds a lead in one of two ways, and each is counted where it is RECORDED, never twice:
 *   on demand — an outreach run asked (buffer/next) and the serve was filed under the source. Every such find is
 *               a `ran` trigger event at campaign-service (`on_demand` since 2026-10-11, `lead_requested` before,
 *               src/lib/lead-requested-events.ts), read through `GET /internal/trigger-events/ran-counts`, history
 *               included. The lead row of such a find is the OUTREACH campaign's, so it is not countable here.
 *   own run   — the source's own run found the lead and stored it under itself (`leads_campaigns.status_reason =
 *               'source_found'`). Never recorded as a trigger event; counted off our rows, every one since the code
 *               shipped (no own run existed before: OWN_RUNS_RECORDED_SINCE).
 * Per campaign: `found = onDemand + ownRuns`, `firstAt`/`lastAt` over both. A `ran` event of an offer whose sources
 * were not campaigns yet names the OUTREACH campaign (as campaign-service's read does): served verbatim, the caller
 * keeps the source campaigns it knows. Unreadable campaign-service = throw (the route answers 502, never a partial count).
 */

export const ON_DEMAND_TRIGGER_IDS = ["on_demand", "lead_requested"] as const;

/** The day the own-run find shipped: no source found a lead in its own run before it. */
export const OWN_RUNS_RECORDED_SINCE = "2026-10-12T00:00:00.000Z";

const CALL_TIMEOUT_MS = 30_000;

export class LeadsFoundUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeadsFoundUnavailableError";
  }
}

export interface SourceLeadsFoundRow {
  campaignId: string;
  found: number;
  onDemand: number;
  ownRuns: number;
  firstAt: string;
  lastAt: string;
}

export interface SourceLeadsFound {
  recordedSince: string;
  modes: {
    onDemand: { triggerIds: string[]; recordedSince: string | null };
    ownRuns: { recordedSince: string };
  };
  counts: SourceLeadsFoundRow[];
}

interface Tally {
  count: number;
  firstAt: string;
  lastAt: string;
}

async function fetchRanCounts(triggerId: string): Promise<{ recordedSince: string | null; counts: Map<string, Tally> }> {
  const url = `${CAMPAIGN_SERVICE_URL}/internal/trigger-events/ran-counts?${new URLSearchParams({ triggerId })}`;
  const response = await fetchWithRetry(url, {
    headers: { "x-api-key": CAMPAIGN_SERVICE_API_KEY },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new LeadsFoundUnavailableError(`campaign-service ran-counts (${triggerId}) failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  }
  const body = (await response.json()) as { recordedSince?: unknown; counts?: unknown };
  if (!Array.isArray(body.counts)) throw new LeadsFoundUnavailableError(`campaign-service ran-counts (${triggerId}) unreadable: no counts`);
  const counts = new Map<string, Tally>();
  for (const c of body.counts as Array<Record<string, unknown>>) {
    if (typeof c?.campaignId !== "string" || typeof c.ran !== "number" || typeof c.firstAt !== "string" || typeof c.lastAt !== "string") {
      throw new LeadsFoundUnavailableError(`campaign-service ran-counts (${triggerId}) entry unreadable: ${JSON.stringify(c).slice(0, 200)}`);
    }
    counts.set(c.campaignId, { count: c.ran, firstAt: c.firstAt, lastAt: c.lastAt });
  }
  return { recordedSince: typeof body.recordedSince === "string" ? body.recordedSince : null, counts };
}

async function loadOwnRunFinds(): Promise<Map<string, Tally>> {
  const rows = (await db.execute(sql`
    SELECT campaign_id, count(*) AS found,
           min(COALESCE(served_at, created_at)) AS first_at, max(COALESCE(served_at, created_at)) AS last_at
      FROM leads_campaigns
     WHERE status_reason = ${SOURCE_FOUND_STATUS_REASON}
     GROUP BY campaign_id
  `)) as unknown as Array<{ campaign_id: string; found: string | number; first_at: Date | string; last_at: Date | string }>;
  const out = new Map<string, Tally>();
  for (const r of rows) {
    out.set(r.campaign_id, { count: Number(r.found), firstAt: new Date(r.first_at).toISOString(), lastAt: new Date(r.last_at).toISOString() });
  }
  return out;
}

const earliest = (a: string, b: string) => (new Date(a).getTime() <= new Date(b).getTime() ? a : b);
const latest = (a: string, b: string) => (new Date(a).getTime() >= new Date(b).getTime() ? a : b);

/** Pure: merge the per-trigger on-demand tallies and our own-run tallies into one row per campaign. */
export function mergeLeadsFound(onDemandReads: Array<Map<string, Tally>>, ownRuns: Map<string, Tally>): SourceLeadsFoundRow[] {
  const rows = new Map<string, SourceLeadsFoundRow>();
  const add = (campaignId: string, t: Tally, mode: "onDemand" | "ownRuns") => {
    const r = rows.get(campaignId) ?? { campaignId, found: 0, onDemand: 0, ownRuns: 0, firstAt: t.firstAt, lastAt: t.lastAt };
    r[mode] += t.count;
    r.found += t.count;
    r.firstAt = earliest(r.firstAt, t.firstAt);
    r.lastAt = latest(r.lastAt, t.lastAt);
    rows.set(campaignId, r);
  };
  for (const read of onDemandReads) for (const [id, t] of read) add(id, t, "onDemand");
  for (const [id, t] of ownRuns) add(id, t, "ownRuns");
  return [...rows.values()].sort((a, b) => (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0));
}

export async function readSourceLeadsFound(): Promise<SourceLeadsFound> {
  const [onDemandReads, ownRuns] = await Promise.all([Promise.all(ON_DEMAND_TRIGGER_IDS.map((t) => fetchRanCounts(t))), loadOwnRunFinds()]);
  const onDemandSince = onDemandReads
    .map((r) => r.recordedSince)
    .filter((v): v is string => v !== null)
    .reduce<string | null>((acc, v) => (acc === null ? v : earliest(acc, v)), null);
  return {
    recordedSince: onDemandSince ? earliest(onDemandSince, OWN_RUNS_RECORDED_SINCE) : OWN_RUNS_RECORDED_SINCE,
    modes: {
      onDemand: { triggerIds: [...ON_DEMAND_TRIGGER_IDS], recordedSince: onDemandSince },
      ownRuns: { recordedSince: OWN_RUNS_RECORDED_SINCE },
    },
    counts: mergeLeadsFound(
      onDemandReads.map((r) => r.counts),
      ownRuns,
    ),
  };
}
