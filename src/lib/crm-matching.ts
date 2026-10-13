/**
 * Pairing THEIR contacts with OUR leads, by human-service's humanId: shared by the pairings view and
 * the CRM evidence sync, so a contact is paired the same way whichever of them reaches it first.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import type { FrozenMatch } from "./crm-pairing-store.js";
import type { CrmContact } from "./crm-client.js";

/** Run `fn` over `items` with at most `limit` in flight, preserving input order in the output. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The pairing for every contact on this page: who human-service says each contact IS (owner
 * 2026-10-13, LEAD-REFONTE-1013: "same human?" is decided ONLY there). The contact's humanId is the one
 * crm-service states on its facts (crm-service#125, read off the bronze copy `crm_facts`), and the
 * pair is the brand's lead holding that human (crm-evidence-sync.ts `pairByHuman` rule: merge
 * aliases followed, newest lead when the human changed company). Deterministic or nothing: this
 * service no longer runs its own matcher nor buys a "same person?" judgment (retired when the count
 * of pairings needing it measured 0 in prod, 2026-10-13). A contact whose human holds no lead of the
 * brand (or with no humanId yet) is `unmatched`.
 */
export async function matchesForContacts(
  orgId: string,
  brandId: string,
  contacts: CrmContact[],
): Promise<Map<string, FrozenMatch>> {
  const out = new Map<string, FrozenMatch>();
  if (contacts.length === 0) return out;
  const ids = contacts.map((c) => c.id);
  const rows = (await db.execute(sql`
    WITH ch AS (
      SELECT DISTINCT ON (f.crm_contact_id) f.crm_contact_id, (f.raw->>'humanId')::uuid AS hid
      FROM crm_facts f
      WHERE f.org_id = ${orgId} AND f.brand_id = ${brandId}
        AND f.crm_contact_id = ANY(${sql.param(ids)}::text[]) AND f.raw->>'humanId' IS NOT NULL
      ORDER BY f.crm_contact_id, f.seq DESC
    )
    SELECT DISTINCT ON (ch.crm_contact_id) ch.crm_contact_id, l.id::text AS lead_id
    FROM ch
    LEFT JOIN human_aliases a ON a.atomic_human_id = ch.hid
    JOIN leads l ON l.human_id = COALESCE(a.human_id, ch.hid)
    WHERE EXISTS (SELECT 1 FROM leads_campaigns lc WHERE lc.lead_id = l.id AND lc.org_id = ${orgId} AND ${brandId} = ANY(lc.brand_ids))
    ORDER BY ch.crm_contact_id, l.created_at DESC, l.id
  `)) as unknown as Array<{ crm_contact_id: string; lead_id: string }>;
  const leadOf = new Map(rows.map((r) => [r.crm_contact_id, r.lead_id]));
  for (const id of ids) {
    const leadId = leadOf.get(id) ?? null;
    out.set(id, {
      crmContactId: id,
      matchedLeadId: leadId,
      matchMethod: leadId ? "human" : null,
      matchConfidence: leadId ? "deterministic" : "unmatched",
      candidateCount: leadId ? 1 : 0,
      matchedAt: null,
    });
  }
  return out;
}
