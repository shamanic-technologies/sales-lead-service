/**
 * Jev reads a person's WHOLE merged thread and says, tag by tag, how likely each relationship is
 * (RELATIONSHIP-TAGS-1014). One call per lead of the brand, nine yes/no questions, frozen in
 * `relationship_judgments` with the thread position it read (`thread_seq`): a lead is judged again only
 * when its thread MOVED (a new message, a signup, a payment, a merge that brought another thread in).
 *
 * Billed to the PLATFORM (no org request starts the sweep: chat-service `/internal/platform-judgments`). The
 * questions explain the relationship the owner means; no tag is decided by a rule on words here.
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { getCompanies } from "./company-client.js";
import { judgeYesNo, MAX_STATE_CHARS, type YesNoQuestion } from "./qualification-judge.js";
import { readThread, toSubject, type Scope, type Subject, type ThreadLine } from "./relationship-subjects.js";
import { RELATIONSHIP_TAGS, type RelationshipTag } from "./relationship-tags.js";

const CONTEXT =
  "You read everything a brand knows about ONE person: every message between the person and the brand's own " +
  "people (email, WhatsApp, LinkedIn, group chats they share), signups, payments, forms, meetings, and what the " +
  "brand's cold outreach sent them. Messages with direction `out` were written by the brand's own people (often " +
  "the founder, who also uses the same phone and mailbox for private life); `in` were written by the person. " +
  "A group fact means they are both members of that group chat. Say how likely each relationship is. Several " +
  "can be true at once (a friend who is also a customer). Judge from what the thread shows; a thread that shows " +
  "nothing about a relationship means it is unlikely, not impossible.";

export const TAG_QUESTIONS: Record<RelationshipTag, YesNoQuestion> = {
  personal: {
    instructions:
      "Does someone on the brand's side know this person PERSONALLY, outside of selling to them: a friend, family, " +
      "partner, flatmate, someone they socialize or travel with, or a fellow member of a private, social or community " +
      "group chat (a workshop, retreat, club or friends' group)?",
    whenTrue: "They know each other as people: private talk, social plans, shared private or community groups, family or friendship.",
    whenFalse: "The only contact is commercial or cold: outreach, a signup, support, purchases, with no personal tie shown.",
  },
  customer: {
    instructions: "Is this person, or the company they act for, a paying customer of the brand, now or in the past?",
    whenTrue: "They paid the brand, hold a subscription, or the thread says they bought.",
    whenFalse: "No payment, purchase or client relationship with the brand is shown.",
  },
  prospect: {
    instructions:
      "Is this person a prospect of the brand: someone who might buy what the brand sells (signed up, asked about the " +
      "offer, was offered it, or was contacted to sell it to them)? A paying customer can also still be a prospect for more.",
    whenTrue: "They are someone the brand sells to or could sell to.",
    whenFalse: "Nothing ties them to buying from the brand (pure friend, supplier, team, investor...).",
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
      "supplier or partner (for example a peer founder, a journalist, a recruiter, an event organizer, an ex-colleague)?",
    whenTrue: "A work relationship of another kind.",
    whenFalse: "No other professional relationship is shown.",
  },
};

/** The newest part of the thread that fits Jev's state, oldest first. */
export function fitThread(lines: readonly ThreadLine[], budget = MAX_STATE_CHARS - 8_000): ThreadLine[] {
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

const brandCards = new Map<string, { name: string | null; domain: string | null; at: number }>();

export async function brandCard(brandId: string): Promise<{ name: string | null; domain: string | null }> {
  const hit = brandCards.get(brandId);
  if (hit && Date.now() - hit.at < 3_600_000) return hit;
  const [c] = await getCompanies([brandId]);
  const card = { name: c?.name ?? null, domain: c?.domain ?? null, at: Date.now() };
  brandCards.set(brandId, card);
  return card;
}

export async function subjectsToJudge(scope: Scope, limit: number): Promise<Subject[]> {
  const rows = (await db.execute(sql`
    SELECT s.* FROM relationship_subjects s
    LEFT JOIN relationship_judgments j ON j.org_id = s.org_id AND j.brand_id = s.brand_id AND j.human_id = s.human_id AND j.company_key = s.company_key
    WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId} AND (j.human_id IS NULL OR j.thread_seq < s.thread_seq)
      AND s.has_direct
    ORDER BY s.has_messages DESC, (j.human_id IS NULL) DESC, s.thread_seq DESC
    LIMIT ${limit}
  `)) as unknown as Array<Record<string, unknown>>;
  return rows.map(toSubject);
}

/** Judge one lead and freeze the answer. Throws on any failure (nothing written). */
export async function judgeSubject(s: Subject, runId: string): Promise<Record<RelationshipTag, number>> {
  const brand = await brandCard(s.brandId);
  const company = s.companyKey
    ? (await db.execute(sql`SELECT name, domain FROM relationship_companies WHERE org_id = ${s.orgId} AND human_id = ${s.humanId}::uuid`)) as unknown as Array<{ name: string | null; domain: string | null }>
    : [];
  const thread = fitThread(await readThread(s));
  const state = {
    context: CONTEXT,
    brand,
    person: { name: s.name, emails: s.emails, phones: s.phones, channels: s.channels, company: company[0] ?? null },
    thread,
  };
  // A background sweep: no org request started it, so the platform pays (chat-service platform judgments).
  const { probabilities, model } = await judgeYesNo(state, TAG_QUESTIONS, "platform");
  await db.execute(sql`
    INSERT INTO relationship_judgments (org_id, brand_id, human_id, company_key, probabilities, thread_seq, model, run_id, judged_at)
    VALUES (${s.orgId}, ${s.brandId}, ${s.humanId}::uuid, ${s.companyKey}, ${JSON.stringify(probabilities)}::jsonb,
      ${s.threadSeq}::bigint, ${model}, ${runId}, now())
    ON CONFLICT (org_id, brand_id, human_id, company_key) DO UPDATE SET
      probabilities = excluded.probabilities, thread_seq = excluded.thread_seq, model = excluded.model,
      run_id = excluded.run_id, judged_at = excluded.judged_at
  `);
  return probabilities;
}

/** Evidence the sources stated: signup -> prospect, payment / sale -> customer. Rewritten whole per brand. */
export async function writeEvidence(scope: Scope): Promise<number> {
  const rows = (await db.execute(sql`
    WITH facts AS (
      SELECT s.human_id, s.company_key, f.type, min(f.occurred_at) AS at
      FROM relationship_subjects s
      JOIN crm_facts f ON f.org_id = s.org_id AND f.brand_id = s.brand_id AND f.person_key = ANY(s.person_keys)
      WHERE s.org_id = ${scope.orgId} AND s.brand_id = ${scope.brandId}
        AND f.type IN ('signup', 'payment', 'sale', 'form_submitted', 'meeting_booked')
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
      JOIN leads l ON l.human_id = s.human_id
      JOIN conversion_events c ON c.matched_lead_id = l.id AND c.org_id = s.org_id AND c.brand_id = s.brand_id
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
