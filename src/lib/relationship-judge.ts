/**
 * Jev reads a person's WHOLE merged thread and says, tag by tag, how likely each relationship is
 * (RELATIONSHIP-TAGS-1014). One call per lead of the brand, ten yes/no questions, frozen in
 * `relationship_judgments` with the thread position it read (`thread_seq`): a lead is judged again only
 * when its thread MOVED (a new message, a signup, a payment, a merge that brought another thread in).
 *
 * Billed to the PLATFORM (no org request starts the sweep: chat-service `/internal/platform-judgments`). The
 * questions explain the relationship the owner means; no tag is decided by a rule on words here.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { createHash } from "node:crypto";
import { getActiveOffers, getOfferText, type OfferText } from "./brand-client.js";
import { getCompanies } from "./company-client.js";
import { judgeYesNo, type YesNoQuestion } from "./qualification-judge.js";
import { readThread, toSubject, type Scope, type Subject, type ThreadLine } from "./relationship-subjects.js";
import { JUDGED_NO, RELATIONSHIP_TAGS, type RelationshipTag } from "./relationship-tags.js";

const CONTEXT =
  "You read everything a brand knows about ONE person: every message between the person and the brand's own " +
  "people (email, WhatsApp, LinkedIn, group chats they share), signups, payments, forms, meetings, and what the " +
  "brand's cold outreach sent them. Messages with direction `out` were written by the brand's own people (often " +
  "the founder, who also uses the same phone and mailbox for private life); `in` were written by the person. " +
  "A group fact means they are both members of that group chat. Say how likely each relationship is. Several " +
  "can be true at once (a friend who is also a customer). Judge from what the thread shows. A `visited the brand's " +
  "website` line is the person's own visit (entry page, first URL whose `utm_source` names the brand email or " +
  "campaign that brought them, pages seen); `added_to_crm` is the brand's own CRM filing them (`contactType` is how " +
  "the brand classes them). `brand.offers` lists what the brand sells, as the brand itself stated each offer (its " +
  "name and what it offers).";

/** Tags Jev judges. `personal` is crm-service's connection tag, read as evidence, never judged here (PROFESSIONAL-LEADS-1017). */
export type JudgedTag = Exclude<RelationshipTag, "personal">;

export const TAG_QUESTIONS: Record<JudgedTag, YesNoQuestion> = {
  customer: {
    instructions: "Is this person, or the company they act for, a paying customer of the brand, now or in the past?",
    whenTrue: "They paid the brand, hold a subscription, or the thread says they bought.",
    whenFalse: "No payment, purchase or client relationship with the brand is shown.",
  },
  // JEV-WEAK-EVIDENCE-1025 (owner: a person who acts toward the brand is a lead unless proven otherwise): coming
  // toward the brand IS the prospect signal; only a thread showing another relationship, or offers that cannot be for
  // them, says no. A thin thread is never read as a no.
  prospect: {
    instructions:
      "Is this person a prospect of the brand: someone who might buy one of the brand's offers (`brand.offers`)? A " +
      "business's prospects are the people who come toward it: they visited its website, read its content, clicked its " +
      "emails, signed up or started to, filled a form, booked, asked about an offer, or the brand's own CRM files them " +
      "as a lead. People the brand offered one of its offers to, or contacted to sell one, are prospects too. What is " +
      "traded must be what the brand sells (a talk about another company's offer is not). A paying customer can also " +
      "still be a prospect for more.",
    whenTrue: "They came toward the brand, or the brand sells or could sell them one of its offers, and the thread shows nothing that rules it out.",
    whenFalse:
      "The thread shows they are something else to the brand and nothing more (pure friend, supplier, team, investor, a journalist pitched for press...), or that the brand's offers cannot be for them.",
  },
  team: {
    instructions: "Does this person work on the brand: employee, co-founder, contractor, freelancer or intern working for the brand?",
    whenTrue: "They work for or on the brand.",
    whenFalse: "They do not work on the brand.",
  },
  investor: {
    instructions: "Is this person an investor or potential investor in the brand (angel, fund, fundraising contact)?",
    whenTrue: "They invested, were pitched to invest, or discuss investing in the brand.",
    whenFalse: "No investment relationship is shown.",
  },
  advisor: {
    instructions: "Is this person an advisor, mentor or coach to the brand or to its founder?",
    whenTrue: "They advise, mentor or coach the brand or the founder.",
    whenFalse: "No advisory relationship is shown.",
  },
  supplier: {
    instructions:
      "Does the brand buy from this person or their company: a vendor, tool, agency, service provider or freelancer the brand pays or considers paying?",
    whenTrue: "The brand is (or would be) their client.",
    whenFalse: "The brand does not buy from them.",
  },
  partner: {
    instructions: "Is this person a business partner of the brand: referral, reseller, affiliate, integration, co-marketing or joint-venture partner?",
    whenTrue: "They partner with the brand to reach or serve customers together.",
    whenFalse: "No partnership is shown.",
  },
  other_professional: {
    instructions:
      "Is this a professional relationship of the brand that is none of customer, prospect, team, investor, advisor, " +
      "supplier, partner or journalist (for example a peer founder, a recruiter, an event organizer, an ex-colleague)?",
    whenTrue: "A work relationship of another kind.",
    whenFalse: "No other professional relationship is shown.",
  },
  // JOURNALISTS-NOT-LEADS-1016: the brand never sells to a journalist (src/lib/brand-journalists.ts).
  journalist: {
    instructions:
      "Is this person a journalist, editor, reporter, writer or podcast host the brand pitches for press coverage (a " +
      "story, an article, a quote, a feature), rather than someone the brand sells its offer to?",
    whenTrue: "The brand reaches them to get covered in the press: pitches, story ideas, interview or quote requests.",
    whenFalse: "Nothing shows the brand reaches them for press coverage.",
  },
};

/** The newest part of the thread that fits Jev's state, oldest first. */
/**
 * Jev bills every input token (platform money, shared with every judgment of the fleet): the newest ~6k tokens of a
 * thread say who someone is. Never the whole 100k-char window.
 */
export const THREAD_BUDGET_CHARS = 24_000;

export function fitThread(lines: readonly ThreadLine[], budget = THREAD_BUDGET_CHARS): ThreadLine[] {
  const out: ThreadLine[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const size = JSON.stringify(lines[i]).length + 1;
    if (used + size > budget) break;
    out.push(lines[i]);
    used += size;
  }
  return out.reverse();
}

/**
 * What Jev is told about the brand (LEADS-JUDGE-BRAND-1021, owner 2026-10-21: « il faut toujours que tu décrives la
 * marque dans Jev, notamment la liste des offres telles que créées sur notre plateforme »): its name, its domain, and
 * EVERY active offer as the brand stated it on the platform, the offer's name and what it offers (the offer's "Service
 * sold" field, else the offer's own text). Never its Q&A nor its documents. A brand's name and domain alone made
 * Regina (a prospect of a client's chiropractic dinners, emailed from our own mailbox) a 0.96 prospect of distribute.you.
 * `hash` moves when any of it changes, so a judgment read under another brand card is asked again.
 */
export interface BrandCard {
  name: string | null;
  domain: string | null;
  offers: Array<{ name: string; whatWeOffer: string | null }>;
}

const brandCards = new Map<string, { card: BrandCard; hash: string; at: number }>();

/** PURE: the offer's "what we offer" text, as stated (a list joined), else its own text, else null. */
export function whatWeOfferOf(offer: Pick<OfferText, "description" | "fields">): string | null {
  const v = offer.fields.services;
  const stated = Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).join("; ") : typeof v === "string" ? v.trim() : "";
  if (stated) return stated;
  return offer.description?.trim() || null;
}

/** PURE: the card's fingerprint (offers in a stable order). */
export function brandCardHash(card: BrandCard): string {
  const offers = [...card.offers].sort((a, b) => a.name.localeCompare(b.name) || String(a.whatWeOffer).localeCompare(String(b.whatWeOffer)));
  return createHash("sha256").update(JSON.stringify({ name: card.name, domain: card.domain, offers })).digest("hex").slice(0, 16);
}

/**
 * When the judge last changed what it is asked or shown so that a "not a lead" answer may move (JEV-WEAK-EVIDENCE-1025:
 * visits and CRM filings shown with what they say, prospect asked as "came toward the brand"). A judgment older than
 * this that left the person NOWHERE (prospect, customer and every other tag under the no edge) is asked again; one
 * that placed them as a lead or as something else is not (re-asking would spend the fleet's shared credit for nothing).
 */
export const JUDGE_CHANGED_AT = "2026-10-25T11:50:00Z";

/** The brand as Jev reads it, for the org owning its configuration. Fails loud (no judgment on half a card). */
export async function brandCardOf(orgId: string, brandId: string): Promise<{ card: BrandCard; hash: string }> {
  const key = `${orgId}|${brandId}`;
  const hit = brandCards.get(key);
  if (hit && Date.now() - hit.at < 3_600_000) return hit;
  const [[c], offers] = await Promise.all([getCompanies([brandId]), getActiveOffers(orgId, brandId)]);
  const texts = await Promise.all(offers.map((o) => getOfferText(orgId, brandId, o.offerId)));
  const card: BrandCard = {
    name: c?.name ?? null,
    domain: c?.domain ?? null,
    offers: texts.map((t) => ({ name: t.name, whatWeOffer: whatWeOfferOf(t) })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  const entry = { card, hash: brandCardHash(card), at: Date.now() };
  brandCards.set(key, entry);
  return entry;
}

export async function brandCard(orgId: string, brandId: string): Promise<BrandCard> {
  return (await brandCardOf(orgId, brandId)).card;
}

async function companyCard(key: string): Promise<Array<{ name: string | null; domain: string | null }>> {
  if (/^[0-9a-f-]{36}$/i.test(key)) {
    const local = (await db.execute(sql`SELECT name, primary_domain AS domain FROM organizations WHERE id = ${key}::uuid`)) as unknown as Array<{ name: string | null; domain: string | null }>;
    if (local.length > 0) return local;
  }
  const [c] = await getCompanies([key]);
  return c ? [{ name: c.name ?? null, domain: c.domain ?? null }] : [];
}

/**
 * Leads to judge: never judged, thread moved, read under another brand card while it made them a lead (prospect or
 * customer at the unsure edge or above: a card change can only take such a person OUT; re-asking everyone would spend
 * the fleet's shared judgment credit on people no offer text can move), or judged before JUDGE_CHANGED_AT while it
 * placed them nowhere (every tag under the no edge: the old judge read a thin thread as "nothing to the brand").
 */
export async function subjectsToJudge(scope: Scope, limit: number, cardHash: string, humans?: readonly string[]): Promise<Subject[]> {
  const onlyHumans = humans === undefined ? sql`` : sql`AND s.human_id = ANY(${sql.param([...humans])}::uuid[])`;
  const rows = (await db.execute(sql`
    SELECT s.* FROM relationship_subjects s
    LEFT JOIN relationship_judgments j ON j.org_id = s.org_id AND j.brand_id = s.brand_id AND j.human_id = s.human_id AND j.company_key = s.company_key
    WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId}
      -- A judgment that read the whole human's thread is not this relation's when the human holds another (PERSON-RELATIONS-1017).
      AND (j.human_id IS NULL OR j.thread_seq < s.thread_seq OR (s.shares_human AND j.thread_scope <> 'relation')
        OR (j.context_hash IS DISTINCT FROM ${cardHash}
          AND ((j.probabilities->>'prospect')::float8 >= ${JUDGED_NO} OR (j.probabilities->>'customer')::float8 >= ${JUDGED_NO}))
        OR (j.judged_at < ${JUDGE_CHANGED_AT}::timestamptz
          AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(j.probabilities) e(k, v) WHERE e.k <> 'personal' AND e.v::float8 >= ${JUDGED_NO})))
      AND s.has_direct ${onlyHumans}
    -- People a source states as prospect / customer (the ones campaigns write to) and people we talk with, first.
    ORDER BY (s.has_messages OR EXISTS (SELECT 1 FROM relationship_evidence e WHERE e.org_id = s.org_id AND e.brand_id = s.brand_id
               AND e.human_id = s.human_id)) DESC,
             (j.human_id IS NULL) DESC, s.thread_seq DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(toSubject);
}

/** PURE: what Jev reads about one lead. The brand card is always in it (LEADS-JUDGE-BRAND-1021). */
export function judgmentState(s: Pick<Subject, "name" | "emails" | "phones" | "channels">, brand: BrandCard, company: { name: string | null; domain: string | null } | null, thread: ThreadLine[]) {
  return {
    context: CONTEXT,
    brand,
    person: { name: s.name, emails: s.emails, phones: s.phones, channels: s.channels, company },
    thread,
  };
}

/** Jev's answers for one lead, nothing written (the sweep's judgment and the read-only replay share it). */
export async function askSubject(s: Subject, runId: string): Promise<{ probabilities: Record<JudgedTag, number>; model: string; cardHash: string }> {
  const { card, hash } = await brandCardOf(s.orgId, s.brandId);
  // The company crm-service (or the lead's employer) names: a brand-service id or a local organization row.
  const company = s.companyKey ? await companyCard(s.companyKey) : [];
  const thread = fitThread(await readThread(s));
  // No org request started it, so the platform pays (chat-service platform judgments), on behalf of OUR run doing the
  // work (the sweep's `relationship-sweep` run, or a follow-up claim's own judgment run): never a support mark.
  const { probabilities, model } = await judgeYesNo(judgmentState(s, card, company[0] ?? null, thread), TAG_QUESTIONS, { platform: { runId } });
  return { probabilities, model, cardHash: hash };
}

/** Judge one lead and freeze the answer with the brand card it read. Throws on any failure (nothing written). */
export async function judgeSubject(s: Subject, runId: string): Promise<Record<JudgedTag, number>> {
  const { probabilities, model, cardHash } = await askSubject(s, runId);
  await db.execute(sql`
    INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, thread_scope, model, run_id, judged_at, context_hash)
    VALUES (${s.orgId}, ${s.brandId}, ${s.humanId}::uuid, ${s.companyKey}, ${JSON.stringify(probabilities)}::jsonb,
      ${s.threadSeq}::bigint, 'relation', ${model}, ${runId}, now(), ${cardHash})
    ON CONFLICT (org_id, brand_id, human_id, company_key) DO UPDATE SET
      probabilities = excluded.probabilities, thread_seq = excluded.thread_seq, thread_scope = excluded.thread_scope, model = excluded.model,
      run_id = excluded.run_id, judged_at = excluded.judged_at, context_hash = excluded.context_hash
  `);
  return probabilities;
}

/** Evidence the sources stated: signup -> prospect, payment / sale -> customer. Rewritten whole per brand. */
export async function writeEvidence(scope: Scope): Promise<number> {
  const rows = (await db.execute(sql`
    WITH facts AS (
      SELECT s.human_id, s.company_key, f.type, min(f.occurred_at) AS at
      FROM relationship_subjects s
      JOIN crm_facts f ON f.org_id = s.org_id AND f.brand_id = s.brand_id AND f.contact_point = ANY(s.contact_points)
      WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId}
        AND f.type IN ('signup', 'payment', 'sale', 'form_submitted', 'meeting_booked')
        -- A payment makes a customer only when it STANDS (succeeded, not wholly refunded: crm-evidence paymentStands);
        -- a failed or refunded charge is no customer (4 people were tagged customer off one, 2026-10-17).
        AND (f.type <> 'payment' OR (f.payload->>'status' = 'succeeded' AND CASE
              WHEN f.payload->>'amountMinor' ~ '^-?[0-9]+$'
                THEN (f.payload->>'amountMinor')::bigint - COALESCE(NULLIF(f.payload->>'amountRefunded', '')::bigint, 0) > 0
              ELSE COALESCE(f.payload->>'refunded', 'false') <> 'true' END))
        AND NOT EXISTS (SELECT 1 FROM crm_facts w WHERE w.withdrawn_of = f.fact_id)
      GROUP BY s.human_id, s.company_key, f.type
    ), stated AS (
      SELECT human_id, company_key,
        CASE WHEN type IN ('payment', 'sale') THEN 'customer' ELSE 'prospect' END AS tag,
        type AS evidence, at
      FROM facts
      UNION ALL
      SELECT s.human_id, s.company_key, 'customer', 'won_sale', min(c.received_at)
      FROM relationship_subjects s
      JOIN lead_contact_methods m ON m.channel = 'email' AND lower(m.value) = ANY(s.emails)
      JOIN conversion_events c ON c.matched_lead_id = m.lead_id AND c.org_id = s.org_id AND c.brand_id = s.brand_id
      WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId}
        AND c.event IN ('sale', 'purchase') AND c.withdrawn_at IS NULL AND c.attribution_status = 'attributed'
      GROUP BY s.human_id, s.company_key
    ), best AS (
      SELECT DISTINCT ON (human_id, company_key, tag) human_id, company_key, tag, evidence, at
      FROM stated ORDER BY human_id, company_key, tag, at NULLS LAST, evidence
    ), del AS (
      DELETE FROM relationship_evidence e
      WHERE e.org_id = ${scope.orgId} AND e.brand_id = ${scope.brandId}
        AND NOT EXISTS (SELECT 1 FROM best b WHERE b.human_id = e.human_id AND b.company_key = e.company_key AND b.tag = e.tag)
    )
    INSERT INTO relationship_evidence (org_id, brand_id, human_id, company_key, tag, evidence, at, updated_at)
    SELECT ${scope.orgId}, ${scope.brandId}, human_id, company_key, tag, evidence, COALESCE(at, now()), now() FROM best
    ON CONFLICT (org_id, brand_id, human_id, company_key, tag) DO UPDATE
      SET evidence = excluded.evidence, at = excluded.at, updated_at = now()
      WHERE (relationship_evidence.evidence, relationship_evidence.at) IS DISTINCT FROM (excluded.evidence, excluded.at)
    RETURNING 1
  `)) as unknown as unknown[];
  return rows.length;
}

export const ALL_TAGS = RELATIONSHIP_TAGS;
