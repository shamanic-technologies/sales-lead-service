/**
 * ONE campaign-service `/campaigns` read per org, shared by the dashboard's one-lead reads
 * (MON-PAGE-SPEED-FLOOR-1120).
 *
 * A Relationships / Person page fires several `GET /orgs/leads/{id}` at once. Each one used to read
 * the org's WHOLE campaign list two or three times (the offer card, the standing's legs, the
 * standing's offers): 540 KB and 259 campaigns for the largest org, parsed on the interactive
 * thread every time (~30 ms of CPU each). Eight reads in parallel = ~20 downloads queued behind each
 * other on one thread, 1.5-6 s per panel on a loaded box.
 *
 * What is shared, and why it never changes an answer:
 *   - keyed on (org, brand header): never crosses an org, and a read never receives another brand's
 *     scoping; the per-org entries are few and expired ones are dropped on every insert;
 *   - only what a campaign IS is read off it (its id, leg, offer, brands, channel): a campaign's
 *     identity (org, brand, offer, leg, channel) is fixed for its life, so a row read 30 s ago
 *     answers exactly what a fresh read would;
 *   - a campaign created since the stored read is a MISS, never "names no leg / no offer": a caller
 *     names the campaign ids it needs, and any id absent from the stored read re-asks campaign-service
 *     (once, shared by every caller waiting on it);
 *   - in flight reads are shared (eight panels opened together = one download);
 *   - a failure is never stored: the next caller asks again, and each caller fails exactly as its
 *     own read did before (CampaignLegsUnavailableError).
 */
import { fetchOrgCampaignRows, type CampaignLegContext, type OrgCampaignRow } from "./campaign-leg-client.js";

/** How long a read answers for the campaigns it holds. */
export const SHARED_ORG_CAMPAIGNS_TTL_MS = 30_000;

interface Entry {
  startedAt: number;
  rows: Promise<OrgCampaignRow[]>;
  ids: Promise<Set<string>>;
}

const entries = new Map<string, Entry>();

function keyOf(ctx: CampaignLegContext): string {
  return `${ctx.orgId}|${ctx.brandId ?? ""}`;
}

function start(key: string, ctx: CampaignLegContext, now: number): Entry {
  for (const [k, e] of entries) if (now - e.startedAt >= SHARED_ORG_CAMPAIGNS_TTL_MS) entries.delete(k);
  const rows = fetchOrgCampaignRows(ctx);
  const entry: Entry = {
    startedAt: now,
    rows,
    ids: rows.then((r) => new Set(r.map((row) => row?.id).filter((id): id is string => typeof id === "string"))),
  };
  entries.set(key, entry);
  // A failed read is never served to the next caller.
  rows.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  return entry;
}

/**
 * The org's campaign rows, from a read at most `SHARED_ORG_CAMPAIGNS_TTL_MS` old that holds every
 * one of `campaignIds` (else a fresh read). Throws what `fetchOrgCampaignRows` throws.
 */
export async function readSharedOrgCampaignRows(
  ctx: CampaignLegContext,
  campaignIds: readonly string[],
): Promise<OrgCampaignRow[]> {
  const key = keyOf(ctx);
  const now = Date.now();
  let entry = entries.get(key);
  if (!entry || now - entry.startedAt >= SHARED_ORG_CAMPAIGNS_TTL_MS) entry = start(key, ctx, now);
  const ids = await entry.ids;
  if (campaignIds.every((id) => ids.has(id))) return entry.rows;
  // A campaign the stored read does not hold: ask again, unless a read started after ours already did.
  const current = entries.get(key);
  const fresh = current && current !== entry && current.startedAt >= entry.startedAt ? current : start(key, ctx, Date.now());
  return fresh.rows;
}

/** A provider bound to one request's context, for resolvers that take one. */
export function sharedOrgCampaignRows(ctx: CampaignLegContext): (campaignIds: readonly string[]) => Promise<OrgCampaignRow[]> {
  return (campaignIds) => readSharedOrgCampaignRows(ctx, campaignIds);
}

/** Tests only: forget every stored read. */
export function resetSharedOrgCampaignRows(): void {
  entries.clear();
}
