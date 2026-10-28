/**
 * The brand transfer, executed against a REAL database. Every table that ties a brand to an org
 * is seeded for the brand being moved AND for a sibling brand of the same org that must stay put;
 * after the transfer the source org holds nothing of the moved brand in ANY table, the sibling is
 * untouched, and a second call moves nothing. A mocked `sql` compiles none of these statements
 * (array equality, jsonb merge, the campaign UNION, the transaction), so this is where they run.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const schema = await import("../../src/db/schema.js");
const { transferBrand, SharedBrandRowsError } = await import("../../src/lib/brand-transfer.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

/** Every org-keyed table the transfer is responsible for, and how it names its brand. */
const BRAND_SCALAR_TABLES = [
  "brand_conversion_tokens",
  "conversion_events",
  "lead_step_disqualifications",
  "lead_step_cause_statements",
  "crm_pairing_matches",
  "crm_pairing_judgments",
  "crm_pairing_rulings",
  "qualification_criteria",
  "qualification_checks",
  "qualification_previews",
  "candidate_screenings",
  "crm_facts",
  "crm_registry_facts",
  "unibox_rows",
  "lead_delivery_evidence",
  "lead_timeline_facts",
  "answered_outside_statements",
  "outside_answer_judgments",
  "lead_disqualification_marks",
  "company_disqualification_marks",
  "relationship_person_humans",
  "relationship_subjects",
  "relationship_evidence",
  "relationship_judgments",
  "relationship_intent_judgments",
  "relationship_statements",
  "relationship_merge_questions",
  "prospect_followup_handouts",
  "outcome_trigger_fires",
  "named_lead_serves",
  "brand_journalists",
  "lead_followup_dates",
  "lead_followup_due_serves",
  "lead_crm_acts",
  "hot_lead_brands",
  "hot_lead_states",
  "hot_lead_fires",
  "outcome_fact_declarations",
  "post_touch_declarations",
  "post_touch_skips",
] as const;
const BRAND_ARRAY_TABLES = ["leads_campaigns", "followup_actions", "requeued_serves", "outreach_facts"] as const;

async function n(query: ReturnType<typeof sql>): Promise<number> {
  const rows = (await db.execute(query)) as unknown as Array<{ n: number }>;
  return Number(rows[0].n);
}

/** Rows of `brand` still held by `org`, per table (campaign-keyed + derived tables included). */
async function footprint(org: string, brand: string, campaignId: string) {
  const out: Record<string, number> = {};
  for (const t of BRAND_SCALAR_TABLES) {
    out[t] = await n(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${org} AND brand_id = ${brand}`,
    );
  }
  for (const t of BRAND_ARRAY_TABLES) {
    out[t] = await n(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${org} AND ${brand} = ANY(brand_ids)`,
    );
  }
  out.campaigns_apollo_strategies = await n(
    sql`SELECT count(*)::int AS n FROM campaigns_apollo_strategies WHERE org_id = ${org} AND campaign_id = ${campaignId}`,
  );
  for (const t of ["lead_read_models", "lead_change_feeds"]) {
    out[t] = await n(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(t)} WHERE org_id = ${org} AND scope->>'brandId' = ${brand}`,
    );
  }
  return out;
}

describe.skipIf(!hasRealDatabase)("brand transfer against a real database", () => {
  const tag = randomUUID().slice(0, 8);
  const created: { orgs: string[]; leads: string[] } = { orgs: [], leads: [] };

  async function newLead(): Promise<string> {
    const [lead] = await db
      .insert(schema.leads)
      .values({ name: `itest transfer ${tag}` })
      .returning({ id: schema.leads.id });
    created.leads.push(lead.id);
    return lead.id;
  }

  /** Seeds one row in EVERY table for (org, brand) on `campaignId`. */
  async function seedBrand(org: string, brand: string, campaignId: string) {
    const leadId = await newLead();
    const [lc] = await db
      .insert(schema.leadsCampaigns)
      .values({ leadId, campaignId, orgId: org, brandIds: [brand], status: "served", servedAt: new Date() })
      .returning({ id: schema.leadsCampaigns.id });
    await db.insert(schema.followupActions).values({
      orgId: org, brandIds: [brand], leadCampaignId: lc.id, leadId,
      heldByCampaignId: campaignId, action: "claimed", occurredAt: new Date(),
    });
    await db.insert(schema.requeuedServes).values({
      leadCampaignId: randomUUID(), leadId, campaignId, orgId: org, brandIds: [brand],
      email: `${randomUUID()}@example.test`, reason: `itest-${tag}`,
      rowSnapshot: { org_id: org, brand_ids: [brand], campaign_id: campaignId },
    });
    await db.insert(schema.campaignsApolloStrategies).values({ orgId: org, campaignId });
    await db.insert(schema.brandConversionTokens).values({ brandId: brand, orgId: org, token: `tok-${randomUUID()}` });
    await db.insert(schema.conversionEvents).values({
      brandId: brand, orgId: org, event: "sale", matchedLeadId: leadId,
      matchConfidence: "deterministic", attributionStatus: "attributed", source: "manual",
      leadCampaignId: lc.id, campaignId, dedupeSignature: `m:${lc.id}:sale`,
    });
    await db.insert(schema.leadStepDisqualifications).values({
      leadId, leadCampaignId: lc.id, campaignId, brandId: brand, orgId: org, step: "meeting_booked",
    });
    await db.insert(schema.leadStepCauseStatements).values({
      orgId: org, brandId: brand, leadId, step: "sale", causedByOutreach: true,
    });
    const contact = `crm-${randomUUID()}`;
    await db.insert(schema.crmPairingMatches).values({
      orgId: org, brandId: brand, crmContactId: contact, matchedLeadId: leadId, matchConfidence: "deterministic",
    });
    await db.insert(schema.crmPairingJudgments).values({
      orgId: org, brandId: brand, crmContactId: contact, leadId, samePersonProbability: 0.9, judgmentModel: "itest",
    });
    await db.insert(schema.crmPairingRulings).values({
      orgId: org, brandId: brand, crmContactId: contact, leadId, ruling: "paired",
    });
    const [criterion] = await db.insert(schema.qualificationCriteria).values({
      orgId: org, brandId: brand, offerId: randomUUID(), question: "Is the site slow on mobile?", probe: { kind: "company_data" }, mode: "mention", enabled: true,
    }).returning();
    await db.insert(schema.qualificationChecks).values({
      criterionId: criterion.id, orgId: org, brandId: brand, offerId: criterion.offerId as string, subject: `lead:${leadId}`, reason: "no_company_domain",
    });
    await db.insert(schema.qualificationPreviews).values({
      orgId: org, brandId: brand, offerId: criterion.offerId as string, companies: [{ domain: "acme.com", name: "Acme" }], criterionIds: [criterion.id], status: "completed",
    });
    await db.insert(schema.candidateScreenings).values({
      orgId: org, brandId: brand, audienceId: randomUUID(), providerPersonId: randomUUID(), candidateId: randomUUID(),
      targetHash: "h", promptVersion: "v1", verdict: "pass",
    });
    await db.insert(schema.crmFacts).values({
      factId: randomUUID(), seq: BigInt(Math.floor(Math.random() * 1e15)), orgId: org, brandId: brand,
      personKey: `p-${randomUUID()}`, sourceContactId: contact, fullName: null, emails: [], phones: [],
      type: "added_to_crm", occurredAt: null, dateBasis: "created_at", source: "gohighlevel",
      sourceRef: `ref-${randomUUID()}`, payload: { origin: "itest" }, raw: { itest: true },
    });
    await db.execute(sql`
      INSERT INTO unibox_rows (org_id, brand_id, human_id, interest, conversation, contactability, fit, last_activity_at)
      VALUES (${org}, ${brand}, ${randomUUID()}::uuid, 'not_asked', 'no_reply_yet', 'contactable', 'fit', now())`);
    await db.insert(schema.crmRegistryFacts).values({
      factId: randomUUID(), seq: BigInt(Math.floor(Math.random() * 1e15)), orgId: org, brandId: brand,
      personKey: `p-${randomUUID()}`, sourceContactId: null, fullName: null, emails: [], phones: [],
      type: "connection_tag", occurredAt: null, dateBasis: "none", source: "crm",
      sourceRef: `person-${randomUUID()}`, payload: { tag: "professional_to_brand" }, raw: { itest: true },
    });
    await db.execute(sql`
      INSERT INTO lead_delivery_evidence (org_id, brand_id, campaign_id, email, result, fetched_at)
      VALUES (${org}, ${brand}, '', ${`${randomUUID()}@example.test`}, NULL, now())`);
    await db.execute(sql`
      INSERT INTO outreach_facts (seq, subject_key, type, lead_email, org_id, brand_ids, raw)
      VALUES (${Math.floor(Math.random() * 1e15)}, ${`ievt:${randomUUID()}`}, 'email_sent', 'a@example.test', ${org}, ARRAY[${brand}]::text[], '{}'::jsonb)`);
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, label, source, source_ref)
      VALUES (${`reply:${randomUUID()}`}, ${org}, ${brand}, ${leadId}, 'not_interested', 'reply', ${randomUUID()})`);
    await db.execute(sql`
      INSERT INTO answered_outside_statements (org_id, brand_id, lead_id, stated_by_user_id)
      VALUES (${org}, ${brand}, ${leadId}::uuid, 'itest-user')`);
    await db.execute(sql`
      INSERT INTO outside_answer_judgments (org_id, brand_id, lead_id, gmail_message_id, mailbox, sent_at, answers, probability, model)
      VALUES (${org}, ${brand}, ${leadId}::uuid, ${`g-${randomUUID()}`}, 'staff', now(), true, 0.9, 'jev-test')`);
    await db.execute(sql`
      INSERT INTO prospect_followup_handouts (org_id, brand_id, lead_id, source_campaign_id, lead_campaign_id)
      VALUES (${org}, ${brand}, ${leadId}::uuid, 'itest-source', ${randomUUID()}::uuid)`);
    await db.execute(sql`
      INSERT INTO outcome_trigger_fires (source_ref, org_id, brand_id, offer_id, step, person_key, lead_id, source, status)
      VALUES (${`serve:${randomUUID()}:${leadId}`}, ${org}, ${brand}, ${randomUUID()}, 'lead_found', ${`lead:${leadId}`}, ${leadId}::uuid, 'serve', 'delivered')`);
    await db.execute(sql`
      INSERT INTO named_lead_serves (org_id, brand_id, campaign_id, lead_id, lead_campaign_id, trigger_event_id)
      VALUES (${org}, ${brand}, ${campaignId}, ${leadId}::uuid, ${randomUUID()}::uuid, ${`evt-${randomUUID()}`})`);
    await db.execute(sql`
      INSERT INTO lead_followup_dates (org_id, brand_id, lead_id, next_followup_at, basis)
      VALUES (${org}, ${brand}, ${leadId}::uuid, now(), 'default')`);
    await db.execute(sql`
      INSERT INTO lead_followup_due_serves (org_id, brand_id, lead_id, source_campaign_id, lead_campaign_id)
      VALUES (${org}, ${brand}, ${leadId}::uuid, 'itest-source', ${lc.id}::uuid)`);
    await db.execute(sql`
      INSERT INTO lead_crm_acts (org_id, brand_id, lead_id, fact_id, type, contact_point, at)
      VALUES (${org}, ${brand}, ${leadId}::uuid, ${`itest-${randomUUID()}`}, 'message_in', 'gmail:itest', now())`);
    await db.execute(sql`
      INSERT INTO brand_journalists (org_id, brand_id, lead_id, press_only, journalist, basis, pitch_campaign_ids)
      VALUES (${org}, ${brand}, ${leadId}::uuid, true, true, 'press_only', ${sql.param([campaignId])}::text[])`);
    await db.execute(sql`
      INSERT INTO lead_disqualification_marks (org_id, brand_id, lead_id, offer_key, source, note, stated_by_user_id)
      VALUES (${org}, ${brand}, ${leadId}::uuid, '', 'manual', 'itest note', 'itest-user')`);
    await db.execute(sql`
      INSERT INTO company_disqualification_marks (org_id, brand_id, company_key, offer_key, source, note, stated_from_lead_id, stated_by_user_id)
      VALUES (${org}, ${brand}, ${`org:${randomUUID()}`}, '', 'manual', 'not our target', ${leadId}::uuid, 'itest-user')`);
    const human = randomUUID();
    await db.execute(sql`
      INSERT INTO relationship_person_humans (org_id, brand_id, person_key, atomic_human_id) VALUES (${org}, ${brand}, ${`email:${randomUUID()}@x.io`}, ${human}::uuid)`);
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, name) VALUES (${org}, ${brand}, ${human}::uuid, 'Itest Person')`);
    await db.execute(sql`
      INSERT INTO relationship_evidence (org_id, brand_id, human_id, tag, evidence, at) VALUES (${org}, ${brand}, ${human}::uuid, 'prospect', 'signup', now())`);
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, probabilities, thread_seq, model, run_id)
      VALUES (${org}, ${brand}, ${human}::uuid, '{"personal":0.1}'::jsonb, 1, 'jev-test', 'run')`);
    await db.execute(sql`
      INSERT INTO hot_lead_brands (org_id, brand_id) VALUES (${org}, ${brand})`);
    await db.execute(sql`
      INSERT INTO hot_lead_states (org_id, brand_id, human_id, hot, episode) VALUES (${org}, ${brand}, ${human}::uuid, true, 1)`);
    await db.execute(sql`
      INSERT INTO hot_lead_fires (org_id, brand_id, human_id, episode, offer_id, status, payload)
      VALUES (${org}, ${brand}, ${human}::uuid, 1, ${randomUUID()}, 'delivered', '{}'::jsonb)`);
    await db.execute(sql`
      INSERT INTO outcome_fact_declarations (org_id, brand_id, lead_id, outcome_key, conversion_event_id, run_id, consumed_outcome_key, consumed_basis)
      VALUES (${org}, ${brand}, ${leadId}::uuid, 'paid_client', ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'conversation', 'no_evidence')`);
    await db.execute(sql`
      INSERT INTO post_touch_declarations (org_id, brand_id, lead_id, post_subject_service, post_subject_id, visit_fact_id, visited_at, run_id, status)
      VALUES (${org}, ${brand}, ${leadId}::uuid, 'meta-service', ${randomUUID()}, ${randomUUID()}, now(), ${randomUUID()}::uuid, 'delivered')`);
    await db.execute(sql`
      INSERT INTO post_touch_skips (visit_fact_id, org_id, brand_id, reason, lead_ids) VALUES (${randomUUID()}, ${org}, ${brand}, 'ambiguous_lead', '{}')`);
    await db.execute(sql`
      INSERT INTO relationship_intent_judgments (org_id, brand_id, human_id, p_wants_business, thread_seq, model, run_id)
      VALUES (${org}, ${brand}, ${human}::uuid, 0.9, 1, 'jev-test', 'run')`);
    await db.execute(sql`
      INSERT INTO relationship_statements (org_id, brand_id, human_id, tag, state, stated_by_user_id) VALUES (${org}, ${brand}, ${human}::uuid, 'customer', 'yes', 'itest-user')`);
    await db.execute(sql`
      INSERT INTO relationship_merge_questions (org_id, brand_id, human_a, human_b, probability, model, run_id, state)
      VALUES (${org}, ${brand}, ${"00000000-0000-4000-8000-000000000001"}::uuid, ${human}::uuid, 0.5, 'jev-test', 'run', 'open')`);
    await db.execute(sql`
      INSERT INTO lead_read_models (scope_key, org_id, scope, applied_xmin)
      VALUES (${`itest-${randomUUID()}`}, ${org}, ${JSON.stringify({ orgId: org, brandId: brand })}::jsonb, pg_current_xact_id())`);
    await db.execute(sql`
      INSERT INTO lead_change_feeds (scope_key, org_id, scope, applied_xmin)
      VALUES (${`itest-${randomUUID()}`}, ${org}, ${JSON.stringify({ orgId: org, brandId: brand })}::jsonb, pg_current_xact_id())`);
  }

  function org(): string {
    const id = randomUUID();
    created.orgs.push(id);
    return id;
  }

  afterAll(async () => {
    for (const o of created.orgs) {
      for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies",
        "lead_read_models", "lead_change_feeds"]) {
        await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${o}`);
      }
    }
    if (created.leads.length > 0) {
      await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(created.leads)}::uuid[])`);
    }
  });

  it("moves every table onto the target org and brand, leaves a sibling brand alone, and a re-run is a no-op", async () => {
    const source = org();
    const target = org();
    const brand = randomUUID();
    const targetBrand = randomUUID();
    const sibling = randomUUID();
    const campaign = `itest-camp-${randomUUID()}`;
    const siblingCampaign = `itest-camp-${randomUUID()}`;
    await seedBrand(source, brand, campaign);
    await seedBrand(source, sibling, siblingCampaign);

    const siblingBefore = await footprint(source, sibling, siblingCampaign);
    const sourceToken = (await db.execute(
      sql`SELECT token FROM brand_conversion_tokens WHERE brand_id = ${brand}`,
    )) as unknown as Array<{ token: string }>;
    // The target brand already carries a freshly minted token: the source one (on the client's
    // website) must win.
    await db.insert(schema.brandConversionTokens).values({ brandId: targetBrand, orgId: target, token: `fresh-${tag}` });

    const first = await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target, targetBrandId: targetBrand });
    const moved = Object.fromEntries(first.map((t) => [t.tableName, t.count]));
    for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies",
      "lead_read_models", "lead_change_feeds"]) {
      expect(moved[t], t).toBeGreaterThanOrEqual(1);
    }

    // Nothing of the brand remains under the source org — in any table.
    const left = await footprint(source, brand, campaign);
    expect(Object.values(left).every((v) => v === 0), JSON.stringify(left)).toBe(true);

    // Everything lives under the target org, on the target brand (derived tables are rebuilt on read).
    const arrived = await footprint(target, targetBrand, campaign);
    for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies"]) {
      expect(arrived[t], t).toBe(1);
    }
    const token = (await db.execute(
      sql`SELECT token, org_id FROM brand_conversion_tokens WHERE brand_id = ${targetBrand}`,
    )) as unknown as Array<{ token: string; org_id: string }>;
    expect(token).toEqual([{ token: sourceToken[0].token, org_id: target }]);
    const snapshot = (await db.execute(
      sql`SELECT row_snapshot FROM requeued_serves WHERE org_id = ${target}`,
    )) as unknown as Array<{ row_snapshot: Record<string, unknown> }>;
    expect(snapshot[0].row_snapshot).toMatchObject({ org_id: target, brand_ids: [targetBrand], campaign_id: campaign });

    // The sibling brand of the source org is untouched.
    expect(await footprint(source, sibling, siblingCampaign)).toEqual(siblingBefore);

    // Re-running moves nothing.
    const second = await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target, targetBrandId: targetBrand });
    expect(second.every((t) => t.count === 0), JSON.stringify(second)).toBe(true);
    expect(await footprint(target, targetBrand, campaign)).toEqual(arrived);
  });

  it("without targetBrandId keeps the brand id and only moves the org", async () => {
    const source = org();
    const target = org();
    const brand = randomUUID();
    const campaign = `itest-camp-${randomUUID()}`;
    await seedBrand(source, brand, campaign);

    await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target });
    const left = await footprint(source, brand, campaign);
    expect(Object.values(left).every((v) => v === 0), JSON.stringify(left)).toBe(true);
    const arrived = await footprint(target, brand, campaign);
    for (const t of [...BRAND_SCALAR_TABLES, ...BRAND_ARRAY_TABLES, "campaigns_apollo_strategies"]) {
      expect(arrived[t], t).toBe(1);
    }
    const again = await transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target });
    expect(again.every((t) => t.count === 0)).toBe(true);
  });

  it("refuses — and writes nothing — when a row is shared with another brand", async () => {
    const source = org();
    const target = org();
    const brand = randomUUID();
    const campaign = `itest-camp-${randomUUID()}`;
    await seedBrand(source, brand, campaign);
    const leadId = await newLead();
    await db.insert(schema.leadsCampaigns).values({
      leadId, campaignId: campaign, orgId: source, brandIds: [brand, randomUUID()], status: "served",
    });

    await expect(
      transferBrand({ sourceBrandId: brand, sourceOrgId: source, targetOrgId: target }),
    ).rejects.toBeInstanceOf(SharedBrandRowsError);
    const stayed = await footprint(source, brand, campaign);
    expect(stayed.leads_campaigns).toBe(2);
    expect(stayed.conversion_events).toBe(1);
  });
});
