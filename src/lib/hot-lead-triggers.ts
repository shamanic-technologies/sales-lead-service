/**
 * "Hot lead" trigger — the IO (HOT-LEAD-PROPOSAL-1019; rules in `hot-lead-rules.ts`).
 *
 * A brand running a reactive campaign on `hot_lead`: "each time someone who wrote to us becomes a lead who wants to
 * do business, start my campaign for them" (on Distribute.you: the assistant proposes to the team what to set up).
 * campaign-service owns the one door that records a trigger event and fires the live campaigns on it
 * (`POST /internal/trigger-events`); this service rings it once per NEW fact.
 *
 * One pass per (org, brand), run by the relationship sweep right after it refreshed the answers (relationship-sweep.ts):
 *   1. every relation that wrote to the brand, plus every relation stored hot, is read with this service's own answers
 *      (`loadRelationshipsAt`: the same blocks the Unibox and features-service's Hot family read);
 *   2. a brand's FIRST pass stores who is hot and fires nothing (`hot_lead_brands.armed_at`: no back-fill);
 *   3. a relation that BECAME hot gets a new episode and, in the SAME transaction, its fire rows: one `pending` row per
 *      ACTIVE offer of the brand (campaign-service runs campaigns per (brand, offer) and the door names one offer; a
 *      hot lead is a fact about the brand, so every offer's campaigns on it run, each once), or one `skipped` row
 *      naming why nothing is sent (own_team, staff, offer_unknown). A relation that is no longer hot is stored cold;
 *   4. pending rows are delivered: the trigger must be in features-service's catalogue (else kept pending, retried:
 *      campaign-service would refuse an unknown trigger for good), 2xx = delivered, 400 = refused (kept), anything else
 *      stays pending with backoff, logged loud. The idempotency key names the relation and its episode, so our own
 *      retry answers the first event.
 * Nothing is read before it is needed (members and offers only when somebody became hot); a read that fails stops the
 * pass before anything is written, so the transition is seen again on the next pass.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { CAMPAIGN_SERVICE_API_KEY, CAMPAIGN_SERVICE_URL, FEATURES_SERVICE_URL } from "../config.js";
import type { RawTimestamp } from "./basic-leads.js";
import { fetchWithRetry } from "./fetch-retry.js";
import { loadOrgMemberKeys } from "./org-members.js";
import { canonicalEmails, eventPerson } from "./outcome-trigger-rules.js";
import { fetchActiveBrandOffers, leadOwningEmails } from "./outcome-triggers.js";
import { loadRelationshipsAt } from "./relationship-read.js";
import { subjectKey, type Scope } from "./relationship-subjects.js";
import {
  HOT_LEAD_ITEM_KIND,
  HOT_LEAD_TRIGGER,
  hotFireVerdict,
  hotLeadIdempotencyKey,
  hotTransition,
  isHot,
  type HotLeadItem,
} from "./hot-lead-rules.js";

const CALL_TIMEOUT_MS = 15_000;
const CATALOGUE_TTL_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const DELIVER_BATCH = 100;
const BLOCK_CHUNK = 1000;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** One relation's answers as the pass needs them (a slice of the relationship block). */
export interface HotAnswers {
  lead: { state: string | null; basis: string | null };
  wantsBusiness: { state: string | null; basis: string | null; confidence: number | null; at: string | null };
  lastInboundAt: string | null;
}

/** What the pass reads and calls; tests replace the siblings. */
export interface HotLeadDeps {
  answers(scope: Scope, keys: ReadonlyArray<{ humanId: string; companyKey: string }>): Promise<Map<string, HotAnswers>>;
  members(orgId: string): Promise<ReadonlySet<string>>;
  activeOffers(orgId: string, brandId: string): Promise<string[]>;
  leadOf(orgId: string, brandId: string, emails: string[]): Promise<string | null>;
  catalogueServesTrigger(): Promise<boolean>;
  post(orgId: string, body: Record<string, unknown>): Promise<{ status: number; text: string }>;
}

let catalogueCache: { at: number; served: boolean } | null = null;

/** Test hook: forget the cached catalogue answer. */
export function resetHotLeadCatalogue(): void {
  catalogueCache = null;
}

async function catalogueServesTrigger(): Promise<boolean> {
  if (catalogueCache && Date.now() - catalogueCache.at < CATALOGUE_TTL_MS) return catalogueCache.served;
  const response = await fetchWithRetry(`${FEATURES_SERVICE_URL}/public/channels`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`features-service /public/channels failed: ${response.status} ${(await response.text()).slice(0, 300)}`);
  const triggers = ((await response.json()) as { triggers?: unknown }).triggers;
  if (!Array.isArray(triggers)) throw new Error("features-service /public/channels answered without a triggers array");
  const served = triggers.some((t) => (t as { id?: unknown } | null)?.id === HOT_LEAD_TRIGGER);
  catalogueCache = { at: Date.now(), served };
  return served;
}

export const defaultHotLeadDeps: HotLeadDeps = {
  async answers(scope, keys) {
    const out = new Map<string, HotAnswers>();
    for (let i = 0; i < keys.length; i += BLOCK_CHUNK) {
      const blocks = await loadRelationshipsAt(scope.orgId, scope.brandId, keys.slice(i, i + BLOCK_CHUNK));
      for (const [k, b] of blocks) {
        out.set(k, {
          lead: { state: b.lead.state, basis: b.lead.basis },
          wantsBusiness: { state: b.wantsBusiness.state, basis: b.wantsBusiness.basis, confidence: b.wantsBusiness.confidence, at: b.wantsBusiness.at },
          lastInboundAt: b.lastInboundAt,
        });
      }
    }
    return out;
  },
  members: loadOrgMemberKeys,
  activeOffers: fetchActiveBrandOffers,
  leadOf: leadOwningEmails,
  catalogueServesTrigger,
  async post(orgId, body) {
    const response = await fetchWithRetry(`${CAMPAIGN_SERVICE_URL}/internal/trigger-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": CAMPAIGN_SERVICE_API_KEY, "x-org-id": orgId },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
  },
};

interface RelationRow {
  human: string;
  company_key: string;
  name: string | null;
  emails: string[] | null;
  phones: string[] | null;
  relation_keys: string[] | null;
  prior_hot: boolean | null;
  episode: number | null;
}

export interface HotLeadPass {
  armed: boolean;
  relations: number;
  becameHot: number;
  cooled: number;
  fires: number;
  skipped: number;
  delivery: Record<HotDeliveryResult, number>;
}

/** One pass for one brand: detect new facts, write them, deliver what is pending. THROWS on a failed read or write. */
export async function detectHotLeads(scope: Scope, deps: HotLeadDeps = defaultHotLeadDeps, now: Date = new Date()): Promise<HotLeadPass> {
  const pass: HotLeadPass = { armed: false, relations: 0, becameHot: 0, cooled: 0, fires: 0, skipped: 0, delivery: { delivered: 0, refused: 0, retry: 0 } };
  // Every relation that wrote to the brand, plus every relation stored hot (gone from the subjects = no longer hot).
  const rows = (await db.execute(sql`
    SELECT COALESCE(s.human_id, h.human_id)::text AS human, COALESCE(s.company_key, h.company_key) AS company_key,
           s.name, s.emails, s.phones, s.relation_keys, h.hot AS prior_hot, h.episode
    FROM (SELECT * FROM relationship_subjects WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND wrote_to_us) s
    FULL OUTER JOIN (SELECT * FROM hot_lead_states WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId}) h
      ON h.human_id = s.human_id AND h.company_key = s.company_key
    WHERE s.human_id IS NOT NULL OR h.hot
    ORDER BY 1, 2
  `)) as unknown as RelationRow[];
  pass.relations = rows.length;
  const present = rows.filter((r) => r.emails !== null);
  const answers = present.length > 0 ? await deps.answers(scope, present.map((r) => ({ humanId: r.human, companyKey: r.company_key }))) : new Map<string, HotAnswers>();
  const hotNow = (r: RelationRow): HotAnswers | null => {
    if (r.emails === null) return null;
    const a = answers.get(subjectKey(r.human, r.company_key));
    if (!a) throw new Error(`[lead-service] hot lead pass: answers missing for relation ${r.human}@${r.company_key} of brand ${scope.brandId}`);
    return isHot(a) ? a : null;
  };

  const armedNow = (await db.execute(sql`
    INSERT INTO hot_lead_brands (org_id, brand_id) VALUES (${scope.orgId}, ${scope.brandId})
    ON CONFLICT DO NOTHING RETURNING armed_at
  `)) as unknown as Array<{ armed_at: RawTimestamp }>;
  if (armedNow.length > 0) {
    // First pass: who is hot already is history. Stored, never fired.
    pass.armed = true;
    for (const r of rows) {
      if (!hotNow(r)) continue;
      await db.execute(sql`
        INSERT INTO hot_lead_states (org_id, brand_id, human_id, company_key, hot, episode, hot_since)
        VALUES (${scope.orgId}, ${scope.brandId}, ${r.human}::uuid, ${r.company_key}, true, 0, NULL)
        ON CONFLICT DO NOTHING
      `);
    }
    console.log(`[lead-service] hot lead trigger armed for org=${scope.orgId} brand=${scope.brandId} (${rows.length} relations read, nothing fired)`);
    return pass;
  }

  type Became = { row: RelationRow; answers: HotAnswers };
  const became: Became[] = [];
  const cooled: RelationRow[] = [];
  for (const r of rows) {
    const a = hotNow(r);
    const t = hotTransition(r.prior_hot, a !== null);
    if (t === "became_hot") became.push({ row: r, answers: a! });
    else if (t === "cooled") cooled.push(r);
  }

  // Everything a new fact needs is read BEFORE anything is written: a failed read leaves the transition to the next pass.
  let members: ReadonlySet<string> = new Set();
  let offers: string[] = [];
  const leads = new Map<string, string | null>();
  if (became.length > 0) {
    members = await deps.members(scope.orgId);
    offers = await deps.activeOffers(scope.orgId, scope.brandId);
    for (const b of became) {
      leads.set(subjectKey(b.row.human, b.row.company_key), await deps.leadOf(scope.orgId, scope.brandId, canonicalEmails(b.row.emails ?? [])));
    }
  }

  for (const r of cooled) {
    await db.execute(sql`
      UPDATE hot_lead_states SET hot = false, updated_at = now()
      WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND human_id = ${r.human}::uuid AND company_key = ${r.company_key} AND hot
    `);
    pass.cooled++;
  }

  const becameAt = now.toISOString();
  for (const { row: r, answers: a } of became) {
    const emails = canonicalEmails(r.emails ?? []);
    const phones = r.phones ?? [];
    const leadId = leads.get(subjectKey(r.human, r.company_key)) ?? null;
    const verdict = hotFireVerdict(emails, members);
    await db.transaction(async (tx) => {
      const [state] = (await tx.execute(sql`
        INSERT INTO hot_lead_states (org_id, brand_id, human_id, company_key, hot, episode, hot_since)
        VALUES (${scope.orgId}, ${scope.brandId}, ${r.human}::uuid, ${r.company_key}, true, 1, ${becameAt}::timestamptz)
        ON CONFLICT (org_id, brand_id, human_id, company_key) DO UPDATE SET
          hot = true, episode = hot_lead_states.episode + 1, hot_since = excluded.hot_since, updated_at = now()
        WHERE NOT hot_lead_states.hot
        RETURNING episode
      `)) as unknown as Array<{ episode: number }>;
      if (!state) return; // another pass recorded it first
      const episode = Number(state.episode);
      const relationKeys = [...(r.relation_keys ?? [])].sort();
      const item: HotLeadItem = {
        kind: HOT_LEAD_ITEM_KIND,
        humanId: r.human,
        companyKey: r.company_key,
        relationKey: relationKeys[0] ?? null,
        relationKeys,
        leadId,
        name: r.name,
        emails,
        phones,
        lead: a.lead,
        wantsBusiness: a.wantsBusiness,
        lastInboundAt: a.lastInboundAt,
        becameHotAt: becameAt,
        episode,
      };
      const person = eventPerson(emails[0] ?? null, r.name, phones[0] ?? null);
      const payload = { item, person, leadId, occurredAt: becameAt };
      const skip = async (reason: string, detail: string) => {
        await tx.execute(sql`
          INSERT INTO hot_lead_fires (org_id, brand_id, human_id, company_key, episode, offer_id, status, skip_reason, payload, last_error)
          VALUES (${scope.orgId}, ${scope.brandId}, ${r.human}::uuid, ${r.company_key}, ${episode}, '', 'skipped', ${reason}, ${JSON.stringify(payload)}::jsonb, ${detail})
          ON CONFLICT DO NOTHING
        `);
        pass.skipped++;
        console.log(`[lead-service] hot lead NOT fired (${reason}): org=${scope.orgId} brand=${scope.brandId} human=${r.human} episode=${episode}: ${detail}`);
      };
      if (!verdict.fire) return skip(verdict.reason, verdict.reason === "staff" ? "a staff address" : "a member of the brand's own team");
      if (offers.length === 0) return skip("offer_unknown", "the brand has no active offer");
      for (const offerId of offers) {
        const key = hotLeadIdempotencyKey({ brandId: scope.brandId, offerId, humanId: r.human, companyKey: r.company_key, episode, hash: sha256 });
        await tx.execute(sql`
          INSERT INTO hot_lead_fires (org_id, brand_id, human_id, company_key, episode, offer_id, status, idempotency_key, payload)
          VALUES (${scope.orgId}, ${scope.brandId}, ${r.human}::uuid, ${r.company_key}, ${episode}, ${offerId}, 'pending', ${key}, ${JSON.stringify(payload)}::jsonb)
          ON CONFLICT DO NOTHING
        `);
        pass.fires++;
      }
    });
    pass.becameHot++;
  }

  pass.delivery = await deliverHotLeadFires(scope, deps);
  return pass;
}

// ── delivery ─────────────────────────────────────────────────────────────────────────────────

export type HotDeliveryResult = "delivered" | "refused" | "retry";

interface FireRow {
  id: string;
  org_id: string;
  brand_id: string;
  offer_id: string;
  idempotency_key: string;
  payload: { item: HotLeadItem; person: Record<string, string> | null; leadId: string | null; occurredAt: string };
  attempts: number;
}

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.max(0, attempts - 1));
}

async function keepForRetry(row: FireRow, error: string): Promise<HotDeliveryResult> {
  const attempts = row.attempts + 1;
  console.error(`[lead-service] hot lead trigger NOT delivered (attempt ${attempts}), retried: org=${row.org_id} brand=${row.brand_id} offer=${row.offer_id} human=${row.payload.item.humanId}: ${error}`);
  await db.execute(sql`
    UPDATE hot_lead_fires SET attempts = ${attempts}, last_error = ${error.slice(0, 500)},
      next_attempt_at = now() + ${`${backoffMs(attempts)} milliseconds`}::interval
    WHERE id = ${row.id}::uuid AND status = 'pending'
  `);
  return "retry";
}

/** The door's body for one fire row (campaign-service `RecordTriggerEventBody`, strict: absent values omitted). */
export function hotLeadEventBody(row: Pick<FireRow, "brand_id" | "offer_id" | "idempotency_key" | "payload">): Record<string, unknown> {
  return {
    triggerId: HOT_LEAD_TRIGGER,
    brandId: row.brand_id,
    offerId: row.offer_id,
    idempotencyKey: row.idempotency_key,
    occurredAt: row.payload.occurredAt,
    ...(row.payload.leadId ? { leadId: row.payload.leadId } : {}),
    ...(row.payload.person ? { person: row.payload.person } : {}),
    item: row.payload.item,
  };
}

async function deliverOne(row: FireRow, deps: HotLeadDeps): Promise<HotDeliveryResult> {
  try {
    if (!(await deps.catalogueServesTrigger())) return await keepForRetry(row, `features-service does not serve the ${HOT_LEAD_TRIGGER} trigger yet`);
    let response: { status: number; text: string };
    try {
      response = await deps.post(row.org_id, hotLeadEventBody(row));
    } catch (err) {
      return await keepForRetry(row, err instanceof Error ? err.message : String(err));
    }
    if (response.status >= 200 && response.status < 300) {
      let eventId: string | null = null;
      try {
        const parsed = JSON.parse(response.text) as { event?: { id?: unknown } };
        eventId = typeof parsed.event?.id === "string" ? parsed.event.id : null;
      } catch {
        // Recorded (2xx); the id is only kept for the reader.
      }
      await db.execute(sql`
        UPDATE hot_lead_fires SET status = 'delivered', trigger_id = ${HOT_LEAD_TRIGGER}, campaign_event_id = ${eventId},
          delivered_at = now(), attempts = ${row.attempts + 1}, last_error = NULL
        WHERE id = ${row.id}::uuid AND status = 'pending'
      `);
      console.log(`[lead-service] hot lead trigger recorded at campaign-service (event ${eventId}): org=${row.org_id} brand=${row.brand_id} offer=${row.offer_id} human=${row.payload.item.humanId}`);
      return "delivered";
    }
    if (response.status === 400) {
      console.error(`[lead-service] hot lead trigger REFUSED by campaign-service, kept: org=${row.org_id} brand=${row.brand_id} offer=${row.offer_id}: ${response.text.slice(0, 300)}`);
      await db.execute(sql`
        UPDATE hot_lead_fires SET status = 'refused', trigger_id = ${HOT_LEAD_TRIGGER}, attempts = ${row.attempts + 1},
          last_error = ${`400 ${response.text}`.slice(0, 500)}
        WHERE id = ${row.id}::uuid AND status = 'pending'
      `);
      return "refused";
    }
    return await keepForRetry(row, `${response.status} ${response.text.slice(0, 300)}`);
  } catch (err) {
    console.error(`[lead-service] hot lead trigger delivery failed (row stays pending): org=${row.org_id} brand=${row.brand_id} offer=${row.offer_id}:`, err);
    return "retry";
  }
}

/** Deliver the brand's due pending rows once. Never throws for one row; THROWS only when the rows cannot be read. */
export async function deliverHotLeadFires(scope: Scope, deps: HotLeadDeps = defaultHotLeadDeps): Promise<Record<HotDeliveryResult, number>> {
  const counts: Record<HotDeliveryResult, number> = { delivered: 0, refused: 0, retry: 0 };
  const due = (await db.execute(sql`
    SELECT id::text AS id, org_id, brand_id, offer_id, idempotency_key, payload, attempts FROM hot_lead_fires
    WHERE org_id = ${scope.orgId} AND brand_id = ${scope.brandId} AND status = 'pending' AND next_attempt_at <= now()
    ORDER BY next_attempt_at
    LIMIT ${DELIVER_BATCH}
  `)) as unknown as FireRow[];
  for (const row of due) counts[await deliverOne(row, deps)]++;
  return counts;
}
