/**
 * "Disqualified" is its OWN mark on a person, beside the step tags (owner 2026-10-13).
 *
 * It used to be one rung of the standing ladder, so disqualifying a lead erased what had happened
 * with them: a lead had ONE standing, and `disqualified` replaced "positive reply". The owner's rule:
 * the mark is ORTHOGONAL to every step tag (contacted, delivered, positive reply, website visit...).
 * Américo Vargas reads "Positive reply" AND "Disqualified", both at once. So:
 *
 *   - It is a yes/no mark + an OPTIONAL free note, who and when. NO closed list of reasons.
 *   - It never moves a step standing, a step count or a bucket: nothing that reads standings or
 *     counts reads this table.
 *   - Its grain is the conversation's, lead x offer x brand. `offer_key = ''` is a mark on the person
 *     at the brand, true on every offer page of it (a timeline fact with no offer reads the same way).
 *     For one offer, the offer's own mark answers first, then the brand-wide one.
 *   - Two writers, ONE notion. A person (staff, customer, agent through the API) sets or removes it
 *     (`source = 'manual'`); the timeline sync sets it from a reply the outreach provider judged "not
 *     the right contact" or "left the role" and fills the note itself (`source = 'reply'`). The sync
 *     only ever touches rows still `source = 'reply'`, so a person's word (setting it OR removing it)
 *     outranks the reply for good. "Sale: never" is NOT a disqualification: it is a step statement
 *     ("will not buy"), read as `not_interested`, exactly as a plain "no" in a reply.
 *   - Removing is `withdrawn_at`, never a DELETE: the row is the record of what was stated.
 */
import { sql } from "../db/index.js";
import { toIsoTimestamp } from "./basic-leads.js";

export const DISQUALIFICATION_SOURCES = ["manual", "reply"] as const;
export type DisqualificationSource = (typeof DISQUALIFICATION_SOURCES)[number];

/** A free note is free, not unbounded. */
export const DISQUALIFICATION_NOTE_MAX = 2000;

/** The mark as every surface serves it. Null wherever the person is not disqualified. */
export interface LeadDisqualification {
  /** The offer it is about, or null = every offer of the brand. */
  offerId: string | null;
  note: string | null;
  source: DisqualificationSource;
  /** Who set it; null when the reply sync did. */
  statedByUserId: string | null;
  statedAt: string;
}

interface MarkRow {
  lead_id: string;
  brand_id: string;
  offer_key: string;
  source: string;
  note: string | null;
  stated_by_user_id: string | null;
  stated_at: Date | string;
}

function toMark(r: MarkRow): LeadDisqualification {
  if (r.source !== "manual" && r.source !== "reply") {
    throw new Error(`lead_disqualification_marks.source '${r.source}' is not a known source`);
  }
  return {
    offerId: r.offer_key === "" ? null : r.offer_key,
    note: r.note,
    source: r.source,
    statedByUserId: r.stated_by_user_id,
    statedAt: toIsoTimestamp(r.stated_at)!,
  };
}

/** A note as stated: trimmed, empty = none. Throws past the bound (the route answers 400). */
export function normalizeDisqualificationNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") throw new Error("note must be a string");
  const note = raw.trim();
  if (note.length === 0) return null;
  if (note.length > DISQUALIFICATION_NOTE_MAX) {
    throw new Error(`note must be at most ${DISQUALIFICATION_NOTE_MAX} characters`);
  }
  return note;
}

/**
 * The live marks of these people at these brands, keyed `leadId|brandId`, every offer key held.
 * One indexed read per call; nothing when nobody is marked.
 */
export async function loadLiveMarks(input: {
  orgId: string;
  brandIds: readonly string[];
  leadIds: readonly string[];
}): Promise<Map<string, Map<string, LeadDisqualification>>> {
  const out = new Map<string, Map<string, LeadDisqualification>>();
  if (input.brandIds.length === 0 || input.leadIds.length === 0) return out;
  const rows = (await sql`
    SELECT lead_id::text AS lead_id, brand_id, offer_key, source, note, stated_by_user_id, stated_at
    FROM lead_disqualification_marks
    WHERE org_id = ${input.orgId}
      AND brand_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.brandIds)}::jsonb))
      AND lead_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(input.leadIds)}::jsonb)::uuid)
      AND withdrawn_at IS NULL
  `) as unknown as MarkRow[];
  for (const r of rows) {
    const key = `${r.lead_id}|${r.brand_id}`;
    let byOffer = out.get(key);
    if (!byOffer) out.set(key, (byOffer = new Map()));
    byOffer.set(r.offer_key, toMark(r));
  }
  return out;
}

/**
 * The mark that answers for ONE conversation: the offer's own, else the brand-wide one. With no
 * offer (a brand-level read, or a row whose campaign names none) only the brand-wide mark answers.
 */
export function effectiveMark(
  byOffer: ReadonlyMap<string, LeadDisqualification> | undefined,
  offerId: string | null,
): LeadDisqualification | null {
  if (!byOffer) return null;
  if (offerId !== null) {
    const own = byOffer.get(offerId);
    if (own) return own;
  }
  return byOffer.get("") ?? null;
}

/** A person sets the mark (or restates it with a new note). Clears any earlier withdrawal. */
export async function setDisqualification(input: {
  orgId: string;
  brandId: string;
  leadId: string;
  offerId: string | null;
  note: string | null;
  statedByUserId: string;
  leadCampaignId: string | null;
}): Promise<LeadDisqualification> {
  const rows = (await sql`
    INSERT INTO lead_disqualification_marks
      (org_id, brand_id, lead_id, offer_key, source, source_ref, note, lead_campaign_id, stated_by_user_id)
    VALUES (${input.orgId}, ${input.brandId}, ${input.leadId}::uuid, ${input.offerId ?? ""}, 'manual', NULL,
      ${input.note}, ${input.leadCampaignId}::uuid, ${input.statedByUserId})
    ON CONFLICT (org_id, brand_id, lead_id, offer_key) DO UPDATE SET
      source = 'manual', source_ref = NULL, note = EXCLUDED.note, lead_campaign_id = EXCLUDED.lead_campaign_id,
      stated_by_user_id = EXCLUDED.stated_by_user_id, stated_at = now(),
      withdrawn_at = NULL, withdrawn_by_user_id = NULL, updated_at = now()
    RETURNING lead_id::text AS lead_id, brand_id, offer_key, source, note, stated_by_user_id, stated_at
  `) as unknown as MarkRow[];
  return toMark(rows[0]);
}

/**
 * A person removes the mark. With an offer: that offer's mark. Without: every mark of the person at
 * the brand (brand-wide and per offer). The withdrawn rows become the PERSON's word
 * (`source = 'manual'`), so the reply sync never puts a mark back over it. Idempotent: returns how
 * many live marks it withdrew (0 = nothing was set).
 */
export async function withdrawDisqualification(input: {
  orgId: string;
  brandId: string;
  leadId: string;
  offerId: string | null;
  withdrawnByUserId: string;
}): Promise<number> {
  const offerKey = input.offerId ?? "";
  // A reply could mark the person later on a key nobody marked yet: the person's "not disqualified"
  // is recorded on the key they named, so it holds against that.
  await sql`
    INSERT INTO lead_disqualification_marks
      (org_id, brand_id, lead_id, offer_key, source, stated_by_user_id, withdrawn_at, withdrawn_by_user_id)
    VALUES (${input.orgId}, ${input.brandId}, ${input.leadId}::uuid, ${offerKey}, 'manual',
      ${input.withdrawnByUserId}, now(), ${input.withdrawnByUserId})
    ON CONFLICT (org_id, brand_id, lead_id, offer_key) DO NOTHING
  `;
  const result = await sql`
    UPDATE lead_disqualification_marks
    SET source = 'manual', withdrawn_at = COALESCE(withdrawn_at, now()),
        withdrawn_by_user_id = COALESCE(withdrawn_by_user_id, ${input.withdrawnByUserId}), updated_at = now()
    WHERE org_id = ${input.orgId} AND brand_id = ${input.brandId} AND lead_id = ${input.leadId}::uuid
      AND (${input.offerId}::text IS NULL OR offer_key = ${offerKey})
      AND (withdrawn_at IS NULL OR source = 'reply')
    RETURNING (withdrawn_at = now()) AS was_live
  `;
  return (result as unknown as Array<{ was_live: boolean }>).filter((r) => r.was_live).length;
}

/** One live mark of the brand, with who the person is and one list row id to open them by. */
export interface BrandDisqualifiedLead {
  /** A lead row id of the person under the brand (`leads_campaigns.id`, newest), as the list carries. */
  id: string | null;
  leadId: string;
  name: string | null;
  email: string | null;
  disqualification: LeadDisqualification;
}

/**
 * Every disqualified person of a brand, newest mark first. With an offer: the people disqualified
 * for it (its own mark, or a brand-wide one). `total` is the length of the same list.
 */
export async function listBrandDisqualifications(input: {
  orgId: string;
  brandId: string;
  offerId: string | null;
}): Promise<BrandDisqualifiedLead[]> {
  const rows = (await sql`
    SELECT DISTINCT ON (m.lead_id)
      m.lead_id::text AS lead_id, m.brand_id, m.offer_key, m.source, m.note, m.stated_by_user_id, m.stated_at,
      l.name, l.first_name, l.last_name,
      (SELECT lower(cm.value) FROM lead_contact_methods cm
        WHERE cm.lead_id = m.lead_id AND cm.channel = 'email' ORDER BY cm.created_at ASC LIMIT 1) AS email,
      (SELECT lc.id::text FROM leads_campaigns lc
        WHERE lc.lead_id = m.lead_id AND lc.org_id = m.org_id AND m.brand_id = ANY(lc.brand_ids)
        ORDER BY lc.created_at DESC, lc.id DESC LIMIT 1) AS row_id
    FROM lead_disqualification_marks m
    JOIN leads l ON l.id = m.lead_id
    WHERE m.org_id = ${input.orgId} AND m.brand_id = ${input.brandId} AND m.withdrawn_at IS NULL
      AND (${input.offerId}::text IS NULL OR m.offer_key IN ('', ${input.offerId ?? ""}))
    -- one row per person: their offer's own mark before the brand-wide one
    ORDER BY m.lead_id, (m.offer_key = '') ASC, m.stated_at DESC
  `) as unknown as Array<
    MarkRow & { name: string | null; first_name: string | null; last_name: string | null; email: string | null; row_id: string | null }
  >;
  return rows
    .map((r) => ({
      id: r.row_id,
      leadId: r.lead_id,
      name: r.name ?? ([r.first_name, r.last_name].filter(Boolean).join(" ") || null),
      email: r.email,
      disqualification: toMark(r),
    }))
    .sort((a, b) => Date.parse(b.disqualification.statedAt) - Date.parse(a.disqualification.statedAt) || a.leadId.localeCompare(b.leadId));
}

/** A reply that judged the person not our target, placed on its conversation. */
export interface ReplyDisqualification {
  leadId: string;
  offerId: string | null;
  replyRef: string;
  note: string;
}

/**
 * The reply half, written by the timeline sync from the brand's CURRENT replies (re-read whole).
 * Marks every (person, offer) a reply judged not our target, keeps the earliest such reply as the
 * reason, and withdraws a reply mark no current reply backs any more (a verdict changed). Rows a
 * person wrote (`source = 'manual'`, set or removed) are never touched.
 */
export async function syncReplyDisqualifications(
  orgId: string,
  brandId: string,
  marks: readonly ReplyDisqualification[],
): Promise<number> {
  const byKey = new Map<string, ReplyDisqualification>();
  for (const m of marks) {
    const key = `${m.leadId}|${m.offerId ?? ""}`;
    if (!byKey.has(key)) byKey.set(key, m);
  }
  const payload = [...byKey.values()].map((m) => ({
    lead_id: m.leadId,
    offer_key: m.offerId ?? "",
    source_ref: m.replyRef,
    note: m.note,
  }));
  let written = 0;
  if (payload.length > 0) {
    const upserted = await sql`
      INSERT INTO lead_disqualification_marks AS t (org_id, brand_id, lead_id, offer_key, source, source_ref, note)
      SELECT ${orgId}, ${brandId}, x.lead_id::uuid, x.offer_key, 'reply', x.source_ref, x.note
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(lead_id text, offer_key text, source_ref text, note text)
      ON CONFLICT (org_id, brand_id, lead_id, offer_key) DO UPDATE SET
        source_ref = EXCLUDED.source_ref, note = EXCLUDED.note, withdrawn_at = NULL, updated_at = now()
      WHERE t.source = 'reply'
        AND (t.source_ref, t.note, t.withdrawn_at) IS DISTINCT FROM (EXCLUDED.source_ref, EXCLUDED.note, NULL::timestamptz)
    `;
    written += upserted.count;
  }
  const withdrawn = await sql`
    UPDATE lead_disqualification_marks SET withdrawn_at = now(), updated_at = now()
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = 'reply' AND withdrawn_at IS NULL
      AND (lead_id::text || '|' || offer_key) NOT IN (SELECT jsonb_array_elements_text(${JSON.stringify([...byKey.keys()])}::jsonb))
  `;
  return written + withdrawn.count;
}
