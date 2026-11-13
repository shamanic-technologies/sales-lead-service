/**
 * WHICH lead each address is at a brand (MON-DB-HOT-1112-LEAD-BY-ADDRESS), for a batch of addresses.
 *
 * crm-service's people build used to learn it by walking the brand's WHOLE lead list
 * (`GET /orgs/leads?brandId=&view=basic&sort=activity&status=all`, 2,000-row pages) and keeping, per
 * address, the rows whose `email` equals it. That read goes through the brand's read model with
 * keep-warm, so a machine reading once an hour kept every such model on the worker's 3-minute
 * refresh forever: lead-service's read-model refresh was the box Postgres's largest consumer.
 *
 * This answers the SAME rows for the addresses asked, and nothing else:
 *   - rows = the list's own relation (`leadCampaignBaseRelation`: brand scope, `status=all`, one
 *     winning row per person, not-a-person excluded) narrowed to the leads holding one of the
 *     addresses, read LIVE (a lead served a second ago is in it);
 *   - a row belongs to an address when the row's `email` (the lead's FIRST registered email, the
 *     value the list emits) equals it case-insensitively, exactly the comparison crm made;
 *   - `disqualification` / `company` / `human` come from `levelBlocksOf`, the code the list's
 *     standing resolver builds them with;
 *   - order among one address's rows (only case variants of one address can give several) is the
 *     list's `sort=activity`: `activityAt` DESC, `id` DESC, `activityAt` from `enrichLeadIndex` over
 *     the stored delivery evidence (the page overlay's rule: any age, a missing address is asked).
 *
 * It never opens, builds, refreshes, catches up or marks read a read model or a change feed.
 * FAIL LOUD: any read failing throws; the route answers 502/500, never a partial answer.
 */
import { sql } from "../db/index.js";
import { enrichLeadIndex } from "./lead-engagement.js";
import { fetchLeadIndexRowsOf, type LeadIndexRow } from "./lead-index.js";
import { LEAD_LIFECYCLE_STATUSES, type LeadListScope } from "./lead-list-query.js";
import {
  engagementOf,
  evidenceRequests,
  readModelDelivery,
  readModelScopeFor,
} from "./lead-read-model.js";
import { resolveLevelBlocks, type LevelBlocks } from "./lead-standing-resolver.js";

/** Addresses one call may name. crm-service splits a bigger brand into several calls. */
export const MAX_ADDRESSES_PER_CALL = 5000;

/** One list row of an address, holding what crm-service reads off it. */
export interface AddressLeadRow {
  /** `leads_campaigns.id`: the list row's `id`. */
  id: string;
  leadId: string;
  campaignId: string;
  brandIds: string[];
  status: string;
  /** The row's email as the list emits it (the lead's first registered email, as stored). */
  email: string;
  servedAt: string | null;
  disqualification: LevelBlocks["disqualification"];
  company: LevelBlocks["company"];
  human: LevelBlocks["human"];
}

export interface AddressAnswer {
  /** The address as asked, lower-cased. */
  email: string;
  /** Every list row of the address, in the list's `sort=activity` order. Empty = no lead. */
  leads: AddressLeadRow[];
}

/** Lower-cased, trimmed, de-duplicated, in the order first asked. */
export function normalizeAddresses(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const email = value.trim().toLowerCase();
    if (email.length === 0 || seen.has(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return out;
}

/** The list's `sort=activity` order: newest activity first, then `id` descending (uuid byte order). */
export function byActivity(a: { activityAt: string; id: string }, b: { activityAt: string; id: string }): number {
  const at = Date.parse(b.activityAt) - Date.parse(a.activityAt);
  if (at !== 0) return at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export async function readLeadsByAddress(input: {
  orgId: string;
  brandId: string;
  addresses: readonly string[];
  userId?: string | null;
  runId?: string | null;
}): Promise<AddressAnswer[]> {
  const addresses = normalizeAddresses(input.addresses);
  if (addresses.length === 0) return [];

  // The leads holding one of the addresses (any of their registered emails; the primary is checked
  // below), over the lower(value) index. A lead that is not the brand's is dropped by the scope.
  const holders = await sql<Array<{ lead_id: string }>>`
    SELECT DISTINCT lead_id::text AS lead_id
    FROM lead_contact_methods
    WHERE channel = 'email' AND lower(value) = ANY(${addresses}::text[])
  `;
  const byAddress = new Map<string, LeadIndexRow[]>(addresses.map((a) => [a, []]));
  if (holders.length > 0) {
    const scope: LeadListScope = {
      orgId: input.orgId,
      brandId: input.brandId,
      statuses: LEAD_LIFECYCLE_STATUSES,
      leadIds: holders.map((h) => h.lead_id),
    };
    for (const row of await fetchLeadIndexRowsOf(scope)) {
      if (!row.email) continue;
      byAddress.get(row.email.toLowerCase())?.push(row);
    }
  }

  const rows = [...byAddress.values()].flat();
  const blocks = await resolveLevelBlocks(
    { orgId: input.orgId, userId: input.userId ?? null, runId: input.runId ?? null, brandId: input.brandId },
    rows,
  );

  // Only an address answered by several rows needs an order; its activity is derived exactly as
  // the brand read model derives it (same scope, same engagement context, stored evidence).
  const several = [...byAddress.values()].filter((r) => r.length > 1).flat();
  const activityOf = new Map<string, string>();
  if (several.length > 0) {
    const modelScope = readModelScopeFor(
      { orgId: input.orgId, brandId: input.brandId, statuses: LEAD_LIFECYCLE_STATUSES },
      input.brandId,
      true,
    );
    const delivery = await readModelDelivery(modelScope, evidenceRequests(several), new Date(0));
    for (const row of await enrichLeadIndex(several, engagementOf(modelScope), true, delivery)) {
      activityOf.set(row.id, row.activityAt);
    }
  }

  return addresses.map((email) => {
    const held = byAddress.get(email)!;
    const ordered =
      held.length > 1
        ? [...held].sort((a, b) =>
            byActivity({ activityAt: activityOf.get(a.id)!, id: a.id }, { activityAt: activityOf.get(b.id)!, id: b.id }),
          )
        : held;
    return {
      email,
      leads: ordered.map((row) => {
        const level = blocks.get(row)!;
        return {
          id: row.id,
          leadId: row.leadId,
          campaignId: row.campaignId,
          brandIds: row.brandIds,
          status: row.status,
          email: row.email!,
          servedAt: row.servedAt,
          disqualification: level.disqualification,
          company: level.company,
          human: level.human,
        };
      }),
    };
  });
}
