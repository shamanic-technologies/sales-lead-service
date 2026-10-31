/**
 * UNIBOX-REPLY-LAG-1031 against a REAL database: a prospect who answers our cold email positively shows in the Unibox
 * (left list AND lead card) with their last word, "waiting on us" and the interest verdict within ONE fast-lane pass,
 * while a full relationship-sweep round of a ~20k-relation brand is still running; the round never writes them back
 * to "no reply yet"; a parallel burst of fast-lane refreshes beside a running round never deadlocks; the lag check
 * reads red only past its line.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const catalogue = {
  object: "step",
  lifecycleLadder: [
    { key: "lead_found", rank: 1, label: "Lead found" },
    { key: "contacted", rank: 2, label: "Contacted" },
    { key: "engaged", rank: 3, label: "Engaged" },
  ],
  rows: [["lead_found", 1], ["email_sent", 2], ["conversation", 3]].map(([key, lifecycleRank]) => ({ key, lifecycleRank })),
};
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string, init?: { body?: string }) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const u = String(url);
    if (u.endsWith("/public/catalogue/steps")) return json(catalogue);
    if (u.endsWith("/internal/people/relations/latest-messages")) {
      const { relationKeys } = JSON.parse(String(init?.body)) as { relationKeys: string[] };
      return json({ relations: relationKeys.map((relationKey) => ({ relationKey, status: "no_message", reason: null, message: null, gaps: [] })) });
    }
    if (u.endsWith("/campaigns") || u.includes("/campaigns?")) return json({ campaigns: [{ id: "camp-cold", offerId: null, name: "Cold email" }] });
    if (u.includes("/sales-funnel-campaigns?")) return json({ salesFunnelCampaigns: [] });
    throw new Error(`unexpected fetch ${u}`);
  },
}));
// Jev: a prospect (the thread shows our pitch and their answer), who wants business.
vi.mock("../../src/lib/qualification-judge.js", () => ({
  judgeYesNo: async (_state: unknown, questions: Record<string, unknown>) => ({
    probabilities: Object.fromEntries(Object.keys(questions).map((k) => [k, k === "prospect" ? 0.9 : k === "wants_business" ? 0.93 : 0.05])),
    model: "jev-test",
  }),
  judgeChoice: async () => {
    throw new Error("not used");
  },
}));
vi.mock("../../src/lib/runs-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/runs-client.js")>()),
  createRun: async () => ({ id: randomUUID() }),
  updateRun: async () => undefined,
}));
vi.mock("../../src/lib/brand-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/brand-client.js")>()),
  getActiveOffers: async () => [],
}));
vi.mock("../../src/lib/company-client.js", () => ({
  MAX_COMPANIES_PER_REQUEST: 1000,
  getCompanies: async (ids: string[]) => ids.map((brandId) => ({ brandId, name: "Doc Dinners", domain: "docdinners.test" })),
  CompanyServiceError: class extends Error {},
}));
vi.mock("../../src/lib/campaign-leg-client.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/campaign-leg-client.js")>()),
  fetchOrgCampaignOffers: async () => new Map([["camp-cold", null]]),
}));

const { db } = await import("../../src/db/index.js");
const { connectionTag } = await import("../helpers/crm-registry.js");
const { refreshSubjects } = await import("../../src/lib/relationship-subjects.js");
const { sweepScope } = await import("../../src/lib/relationship-sweep.js");
const { refreshUniboxRows, readUniboxPage, readUniboxLead, resetLifecycleCatalogueCache } = await import("../../src/lib/unibox-model.js");
const { ingestOutreachFactsPage } = await import("../../src/lib/outreach-fact-feed.js");
const { fastLanePass, refreshPeopleNow, resetFastLaneCursors, measureUniboxReplyLag, lagCheckRun, LAG_RED_AFTER_MINUTES } = await import(
  "../../src/lib/unibox-fast-lane.js"
);
const { resetFastLaneState } = await import("../../src/lib/unibox-fast-lane-state.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

// Doc Dinners' size is 20,000 (`FAST_LANE_TEST_RELATIONS=20000`, ~30 s locally); CI seeds 2,000 so the round's long
// statements never hold the snapshots the parallel suites' CREATE INDEX CONCURRENTLY waits on (their 5 s timeout).
const RELATIONS = Number(process.env.FAST_LANE_TEST_RELATIONS ?? 2_000);

describe.skipIf(!hasRealDatabase)("unibox fast lane (UNIBOX-REPLY-LAG-1031)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const richard = randomUUID();
  const email = `drjones-${randomUUID()}@apexone.test`;
  const personKey = `email:${email}`;
  let leadId = "";
  let outreachSeq = Math.floor(Math.random() * 1e9) * 1000 + 9e14;
  let crmSeq = BigInt(Date.now()) * 1000n + 950_000_000n;

  async function maxSeqs(): Promise<{ crm: bigint; outreach: bigint }> {
    const [r] = (await db.execute(sql`
      SELECT (SELECT coalesce(max(seq), 0)::text FROM crm_facts) AS crm, (SELECT coalesce(max(seq), 0)::text FROM outreach_facts) AS outreach
    `)) as unknown as Array<{ crm: string; outreach: string }>;
    return { crm: BigInt(r.crm), outreach: BigInt(r.outreach) };
  }

  async function row(human: string) {
    const rows = (await db.execute(sql`
      SELECT interest, conversation, last_theirs_at FROM unibox_rows WHERE org_id = ${orgId} AND brand_id = ${brandId} AND human_id = ${human}::uuid
    `)) as unknown as Array<{ interest: string; conversation: string; last_theirs_at: Date | string | null }>;
    return rows[0] ?? null;
  }

  async function positiveReply(at: string): Promise<void> {
    const big = BigInt(Math.max(Number((await maxSeqs()).outreach), outreachSeq)) + 1n;
    outreachSeq = Number(big);
    const replyId = `r-${randomUUID()}`;
    await ingestOutreachFactsPage({
      facts: [{
        seq: String(big), type: "reply", subjectKey: `reply:${replyId}`, supersedesSeq: null, occurredAt: at, recordedAt: at,
        leadEmail: email, orgId, campaignId: "camp-cold", instantlyCampaignId: "ic", brandIds: [brandId], transport: "instantly",
        send: null, open: null, click: null, bounce: null, unsubscribe: null, withdrawal: null,
        reply: {
          replyId, subject: "Re: Doc Dinners", receivedAt: at,
          verdict: { kind: "k", classification: "positive", automatedAnswer: false, stopRequested: false, notOurTarget: false,
            handedToPerson: false, positiveSignal: "interest", declinedOffer: false, notOurTargetReason: null, handoffReason: null },
          judgments: { question: null, proposalType: null }, escalation: null,
        },
      }],
      nextCursor: String(big),
      hasMore: false,
    });
  }

  beforeAll(async () => {
    resetLifecycleCatalogueCache();
    resetFastLaneState();
    // ~20k professional relations, crm-service's registry, as on Doc Dinners.
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      SELECT gen_random_uuid()::text, ${crmSeq.toString()}::bigint + g, ${orgId}, ${brandId}, 'email:p' || g || '@big.test', 'Person ' || g,
        ARRAY['p' || g || '@big.test'], '{}'::text[], 'relation', NULL, 'none', 'crm', gen_random_uuid()::text,
        jsonb_build_object('relationKey', 'rel:' || h || ':pro', 'capacity', 'professional', 'companyId', NULL, 'domain', NULL,
          'tags', jsonb_build_array(jsonb_build_object('tag', 'professional_to_brand', 'userIds', '[]'::jsonb, 'brandId', ${brandId}::text, 'basis', '[]'::jsonb)),
          'contactPoints', jsonb_build_array(jsonb_build_object('id', 'email:p' || g || '@big.test', 'source', 'email', 'companyBasis', NULL)),
          'emails', jsonb_build_array('p' || g || '@big.test'), 'phones', '[]'::jsonb, 'keys', '[]'::jsonb),
        jsonb_build_object('humanId', h)
      FROM (SELECT g, gen_random_uuid()::text AS h FROM generate_series(1, ${RELATIONS}) g) s
    `);
    crmSeq += BigInt(RELATIONS) + 10n;
    // Each one wrote to the brand once (a thread to read), like a real inbox.
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw, received_at)
      SELECT gen_random_uuid()::text, ${crmSeq.toString()}::bigint + g, ${orgId}, ${brandId}, 'email:p' || g || '@big.test', 'email:p' || g || '@big.test', 'Person ' || g,
        ARRAY['p' || g || '@big.test'], '{}'::text[], 'message_in', '2026-10-01T10:00:00Z'::timestamptz, 'event', 'gmail', gen_random_uuid()::text,
        '{"text":"hello"}'::jsonb, '{}'::jsonb, now() - interval '2 days'
      FROM generate_series(1, ${RELATIONS}) g
    `);
    crmSeq += BigInt(RELATIONS) + 10n;
    // Richard Jones: a cold-emailed lead of the brand, a relation crm-service states professional to it.
    await connectionTag({ orgId, brandId, human: richard, personKey, name: "Richard Jones", emails: [email] });
    const [lead] = (await db.execute(sql`
      INSERT INTO leads (first_name, last_name, name, human_id) VALUES ('Richard', 'Jones', 'Richard Jones', ${richard}::uuid) RETURNING id::text`)) as unknown as Array<{ id: string }>;
    leadId = lead.id;
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${leadId}::uuid, 'email', ${email}, 'itest')`);
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
      VALUES (${leadId}::uuid, 'camp-cold', ${orgId}, ${sql.param([brandId])}::text[], 'served', '2026-10-28T09:00:00Z')`);
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, campaign_id, label, source, source_ref, occurred_at, attributable, attribution_basis)
      VALUES (${`send:${randomUUID()}`}, ${orgId}, ${brandId}, ${leadId}::uuid, 'camp-cold', 'initial_email', 'outreach', 'x', '2026-10-30T20:00:00Z', true, 'our_email')`);
    // Our cold email, mirrored by crm-service on his address (a direct conversation).
    crmSeq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${crmSeq.toString()}::bigint, ${orgId}, ${brandId}, ${personKey}, ${personKey}, 'Richard Jones', ${sql.param([email])}::text[], '{}'::text[],
        'message_out', '2026-10-30T20:00:00Z', 'event', 'gmail', ${randomUUID()}, '{"text":"Would Doc Dinners fit your clinic?"}'::jsonb,
        ${JSON.stringify({ humanId: richard })}::jsonb)`);
    // The brand as prod held it before the reply: every relation a subject and a row (planner statistics as prod's).
    await db.execute(sql`ANALYZE crm_facts`);
    await db.execute(sql`ANALYZE crm_registry_facts`);
    await refreshSubjects(scope);
    await db.execute(sql`ANALYZE relationship_subjects`);
    await refreshUniboxRows(scope);
    await db.execute(sql`ANALYZE unibox_rows`);
  }, 300_000);

  afterAll(async () => {
    for (const t of ["crm_registry_facts", "crm_facts", "relationship_subjects", "relationship_evidence", "relationship_judgments", "relationship_intent_judgments",
      "lead_timeline_facts", "unibox_rows", "leads_campaigns", "outreach_facts", "hot_lead_brands", "hot_lead_states", "hot_lead_fires"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
    if (leadId) await db.execute(sql`DELETE FROM leads WHERE id = ${leadId}::uuid`);
  }, 120_000);

  it("shows a positive reply on the list and the card within one pass while a full round of the brand runs", async () => {
    expect(await row(richard)).toMatchObject({ interest: "not_asked", conversation: "no_reply_yet", last_theirs_at: null });
    resetFastLaneCursors(await maxSeqs());

    // The full round starts, then Richard answers (21:57) and the copy receives it.
    let roundDone = false;
    const round = sweepScope(scope).then((t) => {
      roundDone = true;
      return t;
    });
    await positiveReply("2026-10-30T21:57:00.000Z");
    const started = Date.now();
    const results = await fastLanePass(new Date(), { onlyOrgId: orgId });
    const took = Date.now() - started;
    expect(roundDone).toBe(false);
    expect(results.find((r) => r.scope.brandId === brandId)).toMatchObject({ humans: 1, uniboxRows: 1, intentJudged: 1 });
    expect(took).toBeLessThan(60_000);

    const list = await readUniboxPage(scope, { q: "richard" }, { limit: 5, cursor: null });
    expect(list.rows).toHaveLength(1);
    expect(list.rows[0]).toMatchObject({ interest: "interested", conversation: "waiting_on_us", lastTheirsAt: "2026-10-30T21:57:00.000Z" });
    const card = await readUniboxLead(scope, richard);
    expect(card?.lead).toMatchObject({ interest: "interested", conversation: "waiting_on_us", lastTheirsAt: "2026-10-30T21:57:00.000Z" });

    // The round ends; whatever it read before the reply, the next pass puts Richard back as he is.
    const tick = await round;
    expect(tick.error).toBeNull();
    await fastLanePass(new Date(), { onlyOrgId: orgId });
    expect(await row(richard)).toMatchObject({ interest: "interested", conversation: "waiting_on_us" });
  }, 300_000);

  it("a parallel burst of fast-lane refreshes beside a running round never deadlocks", async () => {
    const humans = (await db.execute(sql`
      SELECT human_id::text AS h FROM relationship_subjects WHERE org_id = ${orgId} AND brand_id = ${brandId} ORDER BY random() LIMIT 200
    `)) as unknown as Array<{ h: string }>;
    const batches = Array.from({ length: 10 }, (_, i) => humans.slice(i * 20, i * 20 + 20).map((r) => r.h).concat(richard));
    const settled = await Promise.allSettled([sweepScope(scope), ...batches.map((b) => refreshPeopleNow(scope, b))]);
    const failures = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason));
    expect(failures).toEqual([]);
    expect(await row(richard)).toMatchObject({ interest: "interested", conversation: "waiting_on_us" });
  }, 300_000);

  it("the lag check is red only when an arrival waited past the line, and normal once the fast lane ran", async () => {
    resetFastLaneCursors(await maxSeqs());
    crmSeq = (await maxSeqs()).crm + 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${crmSeq.toString()}::bigint, ${orgId}, ${brandId}, 'email:p7@big.test', 'email:p7@big.test', 'Person 7', ARRAY['p7@big.test'], '{}'::text[],
        'message_in', now(), 'event', 'gmail', ${randomUUID()}, '{"text":"Can we talk tomorrow?"}'::jsonb, '{}'::jsonb)`);

    const fresh = await measureUniboxReplyLag(new Date(), { onlyOrgId: orgId });
    expect(fresh.waiting).toBe(1);
    expect(lagCheckRun(fresh, new Date()).ok).toBe(true);

    const later = new Date(Date.now() + (LAG_RED_AFTER_MINUTES + 5) * 60_000);
    const stuck = await measureUniboxReplyLag(later, { onlyOrgId: orgId });
    expect(stuck.lagMinutes).toBeGreaterThan(LAG_RED_AFTER_MINUTES);
    const red = lagCheckRun(stuck, later);
    expect(red).toMatchObject({ check: "unibox-reply-lag", ok: false, unit: "minutes" });

    await fastLanePass(new Date(), { onlyOrgId: orgId });
    const after = await measureUniboxReplyLag(later, { onlyOrgId: orgId });
    expect(after).toMatchObject({ waiting: 0, lagMinutes: 0 });
    expect(after.checked).toBeGreaterThan(0);
    expect(lagCheckRun(after, later).ok).toBe(true);
  }, 300_000);
});
