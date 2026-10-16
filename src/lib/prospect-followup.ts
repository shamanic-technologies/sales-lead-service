import { sql as dsql } from "drizzle-orm";
import type { RecentlyEmailedScope } from "./recently-emailed-sql.js";
import { db } from "../db/index.js";
import { checkDeliveryStatus } from "./email-gateway-client.js";
import { toIsoTimestamp } from "./basic-leads.js";
import { loadHumanFacts, type LeadHumanBlock } from "./human-opt-out-read.js";
import { loadLeadAndCompanyMarks } from "./lead-disqualification.js";
import { loadRelationships, type RelationshipBlock } from "./relationship-read.js";
import { PURE_PROSPECT_EXCLUDED, type RelationshipTag } from "./relationship-tags.js";
import { reachClauses } from "./reach-sql.js";
import { journalistScopeOf } from "./brand-journalists.js";
import type { ReachMethod } from "./people-client.js";
import type { PoolEmailPolicy } from "./email-policy.js";

/**
 * NEVER WITHOUT A NEXT FOLLOW-UP (NEVER-NO-FOLLOWUP-1014, owner 2026-10-14, quoted verbatim in the PR that added this file): a
 * follow-up for PURE prospects ("qui n'ont pas de tag autre, c.-à-d. pas personal, pas client, pas investors"), whose
 * campaign always states the date of the next one when it sends, so nobody is ever left without one, "sauf évidemment
 * si unsubscribe, unqualified, opt-out, ou si on a une réponse positive d'ici là".
 *
 * Two answers, ONE derivation (`decideProspectFollowup`):
 *   - the VERDICT a writer asks right before writing: is this person still owed a prospect follow-up by this brand?
 *     yes, or no + every reason, first one = the strongest. Cheap (local copies + ONE email-gateway call) and FAIL
 *     LOUD: any unreadable source throws (the route answers 502), never an empty yes.
 *   - the SERVE of the "contacted pure prospects" source pipe (`claimContactedProspect`): the brand's contacted people
 *     the verdict says are owed, each handed to that population AT MOST ONCE per brand, ever
 *     (`prospect_followup_handouts`): the reactive pipe carries them after the first follow-up.
 *
 * Facts and where they are read (nothing re-derived here):
 *   contacted        a live `initial_email` / `followup` timeline fact of the brand (`lead_timeline_facts`).
 *   opted out / DNC  the HUMAN's live facts (`human_fact_copies`), a live `opt_out` reply fact.
 *   unsubscribed     a live `unsubscribed` / `tagged_as_spam` fact, or the sender's brand/global status.
 *   bounced          a live `bounced` fact, or the sender's brand/global status.
 *   disqualified     any live disqualification mark of the lead or of its company at the brand, any offer.
 *   positive reply / meeting / customer   live outcomes (`conversion_events`) and the timeline's reply labels.
 *   in conversation  their latest question / referral / proposal / hand-over came AFTER our latest answer (an outreach
 *                    `reply_sent`, or a person's "answered outside" statement): waiting on the responder, not on us.
 *   sequence running the sender still holds a step to send this person for the brand (`queued`): never two emails
 *                    racing each other; owed once the sequence is done.
 *   relationship     `policies.pure_prospect` (relationship-tags.ts `pureProspectAllows`).
 * A plain "no thanks" (`not_interested`) is NOT a stop: the owner's list names unsubscribe, unqualified, opt-out and
 * a positive reply only.
 *
 * A "no" is either a STOP (the owner's list, plus never emailed / not a pure prospect: for good) or a NOT YET (the
 * person is owed, just not now: a sequence still sending, a conversation waiting on the responder, a relationship or
 * identity not settled yet), and a not-yet says WHEN to ask again (`retryAfter`). The reactive pipe's only state is
 * the next dated occurrence (campaign-service), so a not-yet read as a stop would drop the person for good: the
 * opposite of the owner's rule. The serve likewise never consumes a person on a not-yet (no handout written; a stocked
 * find found not-yet at handover is RELEASED, its handout removed, so the source can find them again).
 */

export const PROSPECT_FOLLOWUP_STOP_REASONS = [
  "opted_out",
  "do_not_contact",
  "unsubscribed",
  "bounced",
  "disqualified",
  "customer",
  "meeting_attended",
  "meeting_booked",
  "positive_reply",
  "not_pure_prospect",
  "not_contacted",
  // Not yet (NOT_YET_REASONS): owed, just not now.
  "in_conversation",
  "sequence_running",
  "relationship_not_judged",
  "same_person_question_open",
  "identity_unresolved",
] as const;
export type ProspectFollowupStop = (typeof PROSPECT_FOLLOWUP_STOP_REASONS)[number];

/** The temporary reasons, and how long until the fact they wait on is worth reading again. */
export const NOT_YET_RETRY_HOURS: Readonly<Partial<Record<ProspectFollowupStop, number>>> = {
  // The responder answers within the day; give the conversation two days to settle.
  in_conversation: 48,
  // A cold sequence spaces its steps by days: look again after a typical step gap.
  sequence_running: 72,
  // The relationship sweep (5 min) and human-service identity resolution catch up within hours.
  relationship_not_judged: 24,
  same_person_question_open: 24,
  identity_unresolved: 24,
};

export type ProspectFollowupKind = "owed" | "stop" | "not_yet";

export interface ProspectFollowupVerdict {
  owed: boolean;
  /** owed; stop = never owed again (record no next date); not_yet = owed later, ask again at `retryAfter`. */
  kind: ProspectFollowupKind;
  /** When a not-yet is worth asking again (ISO), null otherwise: the LATEST of its reasons' waits. */
  retryAfter: string | null;
  /** The strongest stop (first of `reasons`), null when owed. */
  reason: ProspectFollowupStop | null;
  reasons: ProspectFollowupStop[];
  /** The tags (yes or unsure) that make the person more than a prospect, when that is a reason. */
  relationshipTags: RelationshipTag[];
}

/** What we sent: the brand's outreach reached them. */
export const SENT_LABELS = ["initial_email", "followup"] as const;
/** Timeline labels that stop the follow-up for good; read in SQL by the serve's narrowing too (a subset of the verdict). */
const LABEL_STOPS: ReadonlyArray<[string, ProspectFollowupStop]> = [
  ["opt_out", "opted_out"],
  ["unsubscribed", "unsubscribed"],
  ["tagged_as_spam", "unsubscribed"],
  ["bounced", "bounced"],
  ["paid_client", "customer"],
  ["meeting_attended", "meeting_attended"],
  ["meeting_booked", "meeting_booked"],
  ["interested", "positive_reply"],
];
/** A reply that waits on an ANSWER of ours: not yet while it is newer than our latest answer. */
export const CONVERSATION_LABELS = ["question_answerable", "question_to_escalate", "question", "referral", "other_proposal", "hand_over"] as const;
export const STOP_LABELS: readonly string[] = LABEL_STOPS.map(([l]) => l);
/** Live outcomes (conversion_events.event) that stop it. */
const OUTCOME_STOPS: ReadonlyArray<[string, ProspectFollowupStop]> = [
  ["sale", "customer"],
  ["purchase", "customer"],
  ["meeting_attended", "meeting_attended"],
  ["meeting_booked", "meeting_booked"],
  ["positive_reply", "positive_reply"],
];

export interface ProspectFollowupFacts {
  /** Live timeline labels of the person at the brand (any offer). */
  labels: ReadonlySet<string>;
  /** Live, attributed outcomes of the person at the brand. */
  outcomes: ReadonlySet<string>;
  human: LeadHumanBlock | null;
  disqualified: boolean;
  /** The sender's brand + global status of the person's addresses (one email-gateway read). */
  sender: { queued: boolean; unsubscribed: boolean; bounced: boolean };
  /** Who the person is to the brand; null = the lead has no human yet (identity not resolved). */
  relationship: RelationshipBlock | null;
  /** Their latest word waiting on an answer is newer than our latest answer. */
  waitingOnAnswer: boolean;
}

/** Pure: is the person still owed a prospect follow-up, and if not, every reason (strongest first). */
export function decideProspectFollowup(f: ProspectFollowupFacts, now: Date = new Date()): ProspectFollowupVerdict {
  const stops = new Set<ProspectFollowupStop>();
  if (f.human?.optedOut) stops.add("opted_out");
  if (f.human?.doNotContact) stops.add("do_not_contact");
  if (f.sender.unsubscribed) stops.add("unsubscribed");
  if (f.sender.bounced) stops.add("bounced");
  for (const [label, stop] of LABEL_STOPS) if (f.labels.has(label)) stops.add(stop);
  for (const [event, stop] of OUTCOME_STOPS) if (f.outcomes.has(event)) stops.add(stop);
  if (f.disqualified) stops.add("disqualified");
  let relationshipTags: RelationshipTag[] = [];
  if (!f.relationship) stops.add("identity_unresolved");
  else if (!f.relationship.policies.pure_prospect) {
    relationshipTags = PURE_PROSPECT_EXCLUDED.filter((t) => f.relationship!.tags.includes(t) || f.relationship!.unsureTags.includes(t));
    if (relationshipTags.length > 0) stops.add("not_pure_prospect");
    else if (f.relationship.subject && f.relationship.judgedAt === null) stops.add("relationship_not_judged");
    else stops.add("same_person_question_open");
  }
  if (!SENT_LABELS.some((l) => f.labels.has(l))) stops.add("not_contacted");
  if (f.sender.queued) stops.add("sequence_running");
  if (f.waitingOnAnswer) stops.add("in_conversation");
  const reasons = PROSPECT_FOLLOWUP_STOP_REASONS.filter((r) => stops.has(r));
  if (reasons.length === 0) return { owed: true, kind: "owed", retryAfter: null, reason: null, reasons, relationshipTags };
  const waits = reasons.map((r) => NOT_YET_RETRY_HOURS[r]);
  if (waits.some((h) => h === undefined)) return { owed: false, kind: "stop", retryAfter: null, reason: reasons[0], reasons, relationshipTags };
  const hours = Math.max(...(waits as number[]));
  return { owed: false, kind: "not_yet", retryAfter: new Date(now.getTime() + hours * 3_600_000).toISOString(), reason: reasons[0], reasons, relationshipTags };
}

/**
 * The verdict for each lead at the brand. Every source is read; any failure THROWS (never a yes on a read error).
 * `context` carries the caller's identity onto the email-gateway read.
 */
export async function loadProspectFollowupVerdicts(input: {
  orgId: string;
  brandId: string;
  leadIds: readonly string[];
  context?: { userId?: string | null; runId?: string | null };
}): Promise<Map<string, ProspectFollowupVerdict>> {
  const out = new Map<string, ProspectFollowupVerdict>();
  const leadIds = [...new Set(input.leadIds)];
  if (leadIds.length === 0) return out;
  const { orgId, brandId } = input;
  const ids = dsql.param(leadIds);

  const [labelRows, outcomeRows, emailRows, humanRows, humans, marks] = await Promise.all([
    db.execute(dsql`
      SELECT lead_id::text AS lead_id, array_agg(DISTINCT label) AS labels FROM lead_timeline_facts
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ANY(${ids}::uuid[]) AND withdrawn_at IS NULL
      GROUP BY lead_id
    `) as unknown as Promise<Array<{ lead_id: string; labels: string[] }>>,
    db.execute(dsql`
      SELECT matched_lead_id::text AS lead_id, array_agg(DISTINCT event) AS events FROM conversion_events
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND matched_lead_id = ANY(${ids}::uuid[])
        AND attribution_status = 'attributed' AND withdrawn_at IS NULL
        AND event = ANY(${dsql.param(OUTCOME_STOPS.map(([e]) => e))}::text[])
      GROUP BY matched_lead_id
    `) as unknown as Promise<Array<{ lead_id: string; events: string[] }>>,
    db.execute(dsql`
      SELECT lead_id::text AS lead_id, lower(trim(value)) AS email FROM lead_contact_methods
      WHERE lead_id = ANY(${ids}::uuid[]) AND channel = 'email'
    `) as unknown as Promise<Array<{ lead_id: string; email: string }>>,
    db.execute(dsql`
      SELECT id::text AS lead_id, human_id::text AS human_id FROM leads WHERE id = ANY(${ids}::uuid[])
    `) as unknown as Promise<Array<{ lead_id: string; human_id: string | null }>>,
    loadHumanFacts(leadIds),
    loadLeadAndCompanyMarks({ orgId, brandIds: [brandId], leadIds }),
  ]);

  // Is their latest word waiting on an answer newer than our latest answer (outreach `reply_sent`, or a person's
  // "answered outside" statement)? Undated facts cannot be ordered and are left out (awaiting-reply.ts does the same).
  const addresses = [...new Set(emailRows.flatMap((r) => [r.email]))];
  const [conversationRows, answerRows, outsideRows] = await Promise.all([
    db.execute(dsql`
      SELECT lead_id::text AS lead_id, max(occurred_at) AS at FROM lead_timeline_facts
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ANY(${ids}::uuid[]) AND withdrawn_at IS NULL
        AND occurred_at IS NOT NULL AND label = ANY(${dsql.param([...CONVERSATION_LABELS])}::text[])
      GROUP BY lead_id
    `) as unknown as Promise<Array<{ lead_id: string; at: Date | string }>>,
    addresses.length === 0
      ? Promise.resolve([] as Array<{ email: string; at: Date | string }>)
      : (db.execute(dsql`
          SELECT lower(lead_email) AS email, max(occurred_at) AS at FROM outreach_facts
          WHERE org_id = ${orgId} AND type = 'reply_sent' AND ${brandId} = ANY(brand_ids) AND occurred_at IS NOT NULL
            AND lower(lead_email) = ANY(${dsql.param(addresses)}::text[])
          GROUP BY lower(lead_email)
        `) as unknown as Promise<Array<{ email: string; at: Date | string }>>),
    db.execute(dsql`
      SELECT lead_id::text AS lead_id, max(stated_at) AS at FROM answered_outside_statements
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ANY(${ids}::uuid[])
      GROUP BY lead_id
    `) as unknown as Promise<Array<{ lead_id: string; at: Date | string }>>,
  ]);
  const ms = (v: Date | string) => new Date(toIsoTimestamp(v)!).getTime();
  const answeredAt = new Map<string, number>();
  for (const r of outsideRows) answeredAt.set(r.lead_id, ms(r.at));
  const answerByEmail = new Map(answerRows.map((r) => [r.email, ms(r.at)]));
  for (const e of emailRows) {
    const at = answerByEmail.get(e.email);
    if (at !== undefined) answeredAt.set(e.lead_id, Math.max(answeredAt.get(e.lead_id) ?? 0, at));
  }
  const waitingOnAnswer = new Set(conversationRows.filter((r) => ms(r.at) > (answeredAt.get(r.lead_id) ?? 0)).map((r) => r.lead_id));

  const humanOf = new Map(humanRows.map((r) => [r.lead_id, r.human_id]));
  const humanIds = [...new Set(humanRows.map((r) => r.human_id).filter((h): h is string => !!h))];
  const relationships = await loadRelationships(orgId, brandId, humanIds);

  // ONE sender read for every address (brand scope + global): fail loud.
  const emails = [...new Set(emailRows.map((r) => r.email))];
  const senderByEmail = new Map<string, { queued: boolean; unsubscribed: boolean; bounced: boolean }>();
  if (emails.length > 0) {
    const status = await checkDeliveryStatus(
      brandId,
      undefined,
      emails.map((email) => ({ email })),
      { orgId, ...(input.context?.userId ? { userId: input.context.userId } : {}), ...(input.context?.runId ? { runId: input.context.runId } : {}) },
    );
    for (const r of status.results) {
      const b = r.broadcast;
      senderByEmail.set(r.email.trim().toLowerCase(), {
        queued: b?.brand?.queued === true,
        unsubscribed: b?.brand?.unsubscribed === true || b?.global?.email.unsubscribed === true,
        bounced: b?.brand?.bounced === true || b?.global?.email.bounced === true,
      });
    }
  }

  const labelsOf = new Map(labelRows.map((r) => [r.lead_id, new Set(r.labels)]));
  const outcomesOf = new Map(outcomeRows.map((r) => [r.lead_id, new Set(r.events)]));
  for (const leadId of leadIds) {
    const sender = { queued: false, unsubscribed: false, bounced: false };
    for (const e of emailRows) {
      if (e.lead_id !== leadId) continue;
      const s = senderByEmail.get(e.email);
      if (!s) throw new Error(`[prospect-followup] email-gateway answered nothing for ${e.email} (lead ${leadId}, brand ${brandId})`);
      sender.queued ||= s.queued;
      sender.unsubscribed ||= s.unsubscribed;
      sender.bounced ||= s.bounced;
    }
    const markKey = `${leadId}|${brandId}`;
    const companyKey = marks.companyKeyOf.get(leadId);
    const disqualified =
      (marks.lead.get(markKey)?.size ?? 0) > 0 || (companyKey !== undefined && (marks.company.get(`${companyKey}|${brandId}`)?.size ?? 0) > 0);
    const human = humanOf.get(leadId) ?? null;
    out.set(
      leadId,
      decideProspectFollowup({
        labels: labelsOf.get(leadId) ?? new Set(),
        outcomes: outcomesOf.get(leadId) ?? new Set(),
        human: humans.get(leadId) ?? null,
        disqualified,
        sender,
        relationship: human ? (relationships.get(human) ?? null) : null,
        waitingOnAnswer: waitingOnAnswer.has(leadId),
      }),
    );
  }
  return out;
}

/** How many contacted people one serve looks at per pass before asking the verdict. */
const CANDIDATE_BATCH = 100;

export interface ContactedProspectFind {
  leadId: string;
  leadCampaignId: string;
  email: string;
}

/**
 * The serve of the "contacted pure prospects" source pipe: the brand's contacted person waiting longest since our
 * last email whom the verdict says is owed and who was never handed to this population, filed under the SOURCE
 * campaign (`status_reason = 'source_found'`, no audience: the population is the brand's own) with its handout row,
 * in ONE transaction. null = nobody owed right now (refills as the brand contacts more people). The SQL only narrows
 * (contacted, never handed, no stopping label, reachable); the verdict decides.
 */
export async function claimContactedProspect(p: {
  orgId: string;
  brandId: string;
  brandIds: readonly string[];
  sourceCampaignId: string;
  featureSlug: string;
  runId: string | null;
  parentRunId: string | null;
  userId: string | null;
  workflowSlug: string | null;
  goal: string | null;
  activeGoalId: string | null;
  brandProfileId: string | null;
  reachableBy?: readonly ReachMethod[] | null;
  acceptedEmails: PoolEmailPolicy;
  /** Tactic "Fresh contacts only" (src/lib/recently-emailed.ts): absent = nothing asked. */
  recentlyEmailed?: RecentlyEmailedScope | null;
  signal?: AbortSignal;
}): Promise<ContactedProspectFind | null> {
  for (let offset = 0; ; offset += CANDIDATE_BATCH) {
    if (p.signal?.aborted) return null;
    const candidates = (await db.execute(dsql`
      SELECT t.lead_id::text AS lead_id
      FROM lead_timeline_facts t
      WHERE t.org_id = ${p.orgId} AND t.brand_id = ${p.brandId}
        AND t.label = ANY(${dsql.param([...SENT_LABELS])}::text[]) AND t.withdrawn_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM prospect_followup_handouts h WHERE h.org_id = t.org_id AND h.brand_id = t.brand_id AND h.lead_id = t.lead_id)
        AND NOT EXISTS (
          SELECT 1 FROM lead_timeline_facts x
          WHERE x.org_id = t.org_id AND x.brand_id = t.brand_id AND x.lead_id = t.lead_id AND x.withdrawn_at IS NULL
            AND x.label = ANY(${dsql.param([...STOP_LABELS])}::text[]))
        ${reachClauses(dsql`t.lead_id`, p.reachableBy, p.acceptedEmails, null, p.recentlyEmailed, journalistScopeOf(p.orgId, [p.brandId]))}
      GROUP BY t.lead_id
      ORDER BY max(t.occurred_at) ASC NULLS FIRST, t.lead_id ASC
      LIMIT ${CANDIDATE_BATCH} OFFSET ${offset}
    `)) as unknown as Array<{ lead_id: string }>;
    if (candidates.length === 0) return null;
    const verdicts = await loadProspectFollowupVerdicts({
      orgId: p.orgId,
      brandId: p.brandId,
      leadIds: candidates.map((c) => c.lead_id),
      context: { userId: p.userId, runId: p.runId },
    });
    for (const c of candidates) {
      if (!verdicts.get(c.lead_id)?.owed) continue;
      const found = await fileFind(p, c.lead_id);
      if (found) return found;
    }
    if (candidates.length < CANDIDATE_BATCH) return null;
  }
}

/** Handout + source row in one transaction; null = another run took this person first. */
async function fileFind(p: Parameters<typeof claimContactedProspect>[0], leadId: string): Promise<ContactedProspectFind | null> {
  return db.transaction(async (tx) => {
    const [email] = (await tx.execute(dsql`
      SELECT value FROM lead_contact_methods WHERE lead_id = ${leadId} AND channel = 'email'
      ORDER BY created_at ASC NULLS LAST, value ASC LIMIT 1
    `)) as unknown as Array<{ value: string }>;
    if (!email) throw new Error(`[prospect-followup] contacted lead ${leadId} has no registered email`);
    const brandIds = dsql.join(p.brandIds.map((b) => dsql`${b}`), dsql`, `);
    const [row] = (await tx.execute(dsql`
      INSERT INTO leads_campaigns (
        lead_id, campaign_id, org_id, brand_ids, status, status_reason, status_details, served_at,
        parent_run_id, run_id, push_run_id, user_id, workflow_slug, feature_slug, goal, active_goal_id, brand_profile_id
      ) VALUES (
        ${leadId}, ${p.sourceCampaignId}, ${p.orgId}, ARRAY[${brandIds}]::text[], 'served', 'source_found',
        ${`Found among the brand's contacted pure prospects (NEVER-NO-FOLLOWUP-1014), email=${email.value}, leadId=${leadId}, campaign=${p.sourceCampaignId}`},
        now(), ${p.parentRunId}, ${p.runId}, ${p.runId}, ${p.userId}, ${p.workflowSlug}, ${p.featureSlug},
        ${p.goal}, ${p.activeGoalId}, ${p.brandProfileId}
      )
      ON CONFLICT (lead_id, campaign_id) DO NOTHING
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    if (!row) throw new Error(`[prospect-followup] source campaign ${p.sourceCampaignId} already holds lead ${leadId} outside the handout ledger`);
    const handed = (await tx.execute(dsql`
      INSERT INTO prospect_followup_handouts (org_id, brand_id, lead_id, source_campaign_id, lead_campaign_id)
      VALUES (${p.orgId}, ${p.brandId}, ${leadId}::uuid, ${p.sourceCampaignId}, ${row.id}::uuid)
      ON CONFLICT (org_id, brand_id, lead_id) DO NOTHING
      RETURNING 1
    `)) as unknown as unknown[];
    if (handed.length === 0) {
      // Another run handed this person first: undo our source row inside this transaction.
      await tx.execute(dsql`DELETE FROM leads_campaigns WHERE id = ${row.id}::uuid`);
      return null;
    }
    return { leadId, leadCampaignId: row.id, email: email.value };
  });
}

/** The handout a stocked source row came from (a contacted-prospect find carries no audience). */
export async function handoutOfSourceRow(sourceRowId: string): Promise<{ orgId: string; brandId: string; leadId: string } | null> {
  const rows = (await db.execute(dsql`
    SELECT org_id, brand_id, lead_id::text AS lead_id FROM prospect_followup_handouts WHERE lead_campaign_id = ${sourceRowId}::uuid
  `)) as unknown as Array<{ org_id: string; brand_id: string; lead_id: string }>;
  const r = rows[0];
  return r ? { orgId: r.org_id, brandId: r.brand_id, leadId: r.lead_id } : null;
}
