/**
 * NEVER-NO-FOLLOWUP-1014 against a REAL database: the verdict over every stored fact, and the "contacted pure
 * prospects" source serve handing each owed person once per brand, never an excluded one, never twice.
 * The sender (email-gateway) is the one remote read, stated per test.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const queued = new Set<string>();
let gatewayDown = false;
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: vi.fn(async (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) => {
    if (gatewayDown) throw new Error("email-gateway 503");
    return {
      results: items.map(({ email }) => ({
        email,
        broadcast: { brand: { queued: queued.has(email), unsubscribed: false, bounced: false }, global: { email: { unsubscribed: false, bounced: false } } },
      })),
    };
  }),
}));

const { db } = await import("../../src/db/index.js");
const { clearRegistry, connectionTag } = await import("../helpers/crm-registry.js");
const { claimContactedProspect, loadProspectFollowupVerdicts, handoutOfSourceRow } = await import("../../src/lib/prospect-followup.js");
const { claimStockedLead } = await import("../../src/lib/source-stock.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("prospect follow-up (NEVER-NO-FOLLOWUP-1014)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const sourceCampaignId = randomUUID();
  const leads: string[] = [];

  async function person(name: string, opts: { sentAt?: string | null; labels?: string[]; human?: boolean } = {}): Promise<{ leadId: string; email: string; humanId: string | null }> {
    const humanId = opts.human === false ? null : randomUUID();
    const [row] = (await db.execute(sql`INSERT INTO leads (first_name, human_id) VALUES (${name}, ${humanId}::uuid) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leads.push(row.id);
    const email = `kevin+pfu-${name}-${randomUUID().slice(0, 6)}@distribute.you`;
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${row.id}::uuid, 'email', ${email}, 'itest')`);
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
      VALUES (${row.id}::uuid, ${`cold-${randomUUID()}`}, ${orgId}, ARRAY[${brandId}]::text[], 'served', now())`);
    if (opts.sentAt !== null) await fact(row.id, "initial_email", opts.sentAt ?? "2026-09-01T10:00:00Z");
    for (const l of opts.labels ?? []) await fact(row.id, l, "2026-09-05T10:00:00Z");
    return { leadId: row.id, email, humanId };
  }

  async function fact(leadId: string, label: string, at: string): Promise<void> {
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, label, source, source_ref, occurred_at)
      VALUES (${`itest:${randomUUID()}`}, ${orgId}, ${brandId}, ${leadId}::uuid, ${label}, 'outreach', ${randomUUID()}, ${at}::timestamptz)`);
  }

  const serve = () =>
    claimContactedProspect({
      orgId,
      brandId,
      brandIds: [brandId],
      sourceCampaignId,
      featureSlug: "sourcing-contacted-prospects",
      runId: null,
      parentRunId: null,
      userId: null,
      workflowSlug: null,
      goal: null,
      activeGoalId: null,
      brandProfileId: null,
      acceptedEmails: "as_found",
    });

  beforeEach(() => {
    queued.clear();
    gatewayDown = false;
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM prospect_followup_handouts WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await clearRegistry(orgId);
    for (const t of ["lead_timeline_facts", "conversion_events", "answered_outside_statements", "lead_disqualification_marks", "relationship_subjects", "relationship_judgments"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(leads)}::uuid[])`);
  });

  it("answers yes for a contacted pure prospect, no + reason for every stop", async () => {
    const pure = await person("pure");
    const optedOut = await person("optout");
    await db.execute(sql`INSERT INTO human_fact_copies (fact_id, human_id, kind, event_id) VALUES (${randomUUID()}::uuid, ${optedOut.humanId}::uuid, 'opt_out', 1)`);
    const disq = await person("disq");
    await db.execute(sql`
      INSERT INTO lead_disqualification_marks (org_id, brand_id, lead_id, offer_key, source, stated_by_user_id)
      VALUES (${orgId}, ${brandId}, ${disq.leadId}::uuid, 'some-offer', 'manual', 'itest')`);
    const positive = await person("positive", { labels: ["interested"] });
    const booked = await person("booked");
    await db.execute(sql`
      INSERT INTO conversion_events (org_id, brand_id, event, match_confidence, attribution_status, matched_lead_id, source)
      VALUES (${orgId}, ${brandId}, 'meeting_booked', 'exact', 'attributed', ${booked.leadId}::uuid, 'manual')`);
    const tagged: Record<string, string> = {};
    for (const tag of ["personal", "customer", "investor"]) {
      const p = await person(`tag-${tag}`);
      await db.execute(sql`INSERT INTO relationship_subjects (org_id, brand_id, human_id, has_direct) VALUES (${orgId}, ${brandId}, ${p.humanId}::uuid, true)`);
      // Personal is crm-service's connection tag (PROFESSIONAL-LEADS-1017); the others are judged.
      if (tag === "personal") await connectionTag({ orgId, brandId, human: p.humanId, personKey: `itest:${p.humanId}`, tag: "personal_to_user" });
      await db.execute(sql`
        INSERT INTO relationship_judgments (org_id, brand_id, human_id, probabilities, thread_seq, model, run_id)
        VALUES (${orgId}, ${brandId}, ${p.humanId}::uuid, ${JSON.stringify({ [tag]: 0.9, prospect: 0.9 })}::jsonb, 1, 'jev', 'run')`);
      tagged[tag] = p.leadId;
    }
    const unjudged = await person("unjudged");
    // A direct conversation never judged (a subject only our outreach knows needs no judgment).
    await db.execute(sql`INSERT INTO relationship_subjects (org_id, brand_id, human_id, has_direct) VALUES (${orgId}, ${brandId}, ${unjudged.humanId}::uuid, true)`);
    const neverSent = await person("neversent", { sentAt: null });

    const v = await loadProspectFollowupVerdicts({
      orgId,
      brandId,
      leadIds: [pure.leadId, optedOut.leadId, disq.leadId, positive.leadId, booked.leadId, ...Object.values(tagged), unjudged.leadId, neverSent.leadId],
    });
    expect(v.get(pure.leadId)).toMatchObject({ owed: true, reasons: [] });
    expect(v.get(optedOut.leadId)?.reason).toBe("opted_out");
    expect(v.get(disq.leadId)?.reason).toBe("disqualified");
    expect(v.get(positive.leadId)?.reason).toBe("positive_reply");
    expect(v.get(booked.leadId)?.reason).toBe("meeting_booked");
    for (const [tag, leadId] of Object.entries(tagged)) expect(v.get(leadId)).toMatchObject({ owed: false, reason: "not_pure_prospect", relationshipTags: [tag] });
    expect(v.get(unjudged.leadId)?.reason).toBe("relationship_not_judged");
    expect(v.get(neverSent.leadId)?.reason).toBe("not_contacted");

    queued.add(pure.email);
    expect((await loadProspectFollowupVerdicts({ orgId, brandId, leadIds: [pure.leadId] })).get(pure.leadId)).toMatchObject({ kind: "not_yet", reason: "sequence_running" });
    queued.clear();

    // A question newer than our latest answer holds them (not yet); our answer after it makes them owed again.
    const asked = await person("asked", { labels: ["question"] });
    expect((await loadProspectFollowupVerdicts({ orgId, brandId, leadIds: [asked.leadId] })).get(asked.leadId)).toMatchObject({ kind: "not_yet", reason: "in_conversation" });
    await db.execute(sql`INSERT INTO answered_outside_statements (org_id, brand_id, lead_id, stated_by_user_id, stated_at) VALUES (${orgId}, ${brandId}, ${asked.leadId}::uuid, 'itest', '2026-09-06T10:00:00Z')`);
    expect((await loadProspectFollowupVerdicts({ orgId, brandId, leadIds: [asked.leadId] })).get(asked.leadId)).toMatchObject({ kind: "owed" });
    await db.execute(sql`UPDATE lead_timeline_facts SET withdrawn_at = now() WHERE lead_id = ${asked.leadId}::uuid`);

    gatewayDown = true;
    await expect(loadProspectFollowupVerdicts({ orgId, brandId, leadIds: [pure.leadId] })).rejects.toThrow("email-gateway 503");
  });

  it("serves owed people oldest-contacted first, each once per brand, never an excluded one; then says none owed", async () => {
    // A fresh brand view: only the people of the previous test exist; the owed one there is `pure`.
    const older = await person("older", { sentAt: "2026-08-01T10:00:00Z" });
    const midSequence = await person("midseq", { sentAt: "2026-07-01T10:00:00Z" });
    queued.add(midSequence.email);

    const first = await serve();
    expect(first?.leadId).toBe(older.leadId);
    const second = await serve();
    expect(second).not.toBeNull();
    expect(second!.leadId).not.toBe(older.leadId);
    expect(second!.leadId).not.toBe(midSequence.leadId);
    expect(await serve()).toBeNull();

    const rows = (await db.execute(sql`
      SELECT lc.status, lc.status_reason, lc.audience_id, h.lead_id::text AS handed
      FROM leads_campaigns lc JOIN prospect_followup_handouts h ON h.lead_campaign_id = lc.id
      WHERE lc.campaign_id = ${sourceCampaignId} ORDER BY lc.created_at`)) as unknown as Array<Record<string, unknown>>;
    expect(rows).toEqual([
      { status: "served", status_reason: "source_found", audience_id: null, handed: older.leadId },
      { status: "served", status_reason: "source_found", audience_id: null, handed: second!.leadId },
    ]);
    expect(await handoutOfSourceRow(first!.leadCampaignId)).toEqual({ orgId, brandId, leadId: older.leadId });

    // The sequence finished: the mid-sequence person is owed now, and served once.
    queued.clear();
    expect((await serve())?.leadId).toBe(midSequence.leadId);
    expect(await serve()).toBeNull();
  });

  it("a stocked find NOT YET owed at handover is released (find + handout removed, findable again); a stopped one is set aside", async () => {
    const later = await person("later", { sentAt: "2026-06-01T10:00:00Z" });
    const found = await serve();
    expect(found?.leadId).toBe(later.leadId);
    const outreachCampaignId = randomUUID();
    const claim = (verdict: { fits: false; reason: string; release?: true }) =>
      claimStockedLead({
        orgId,
        sourceCampaignIds: [sourceCampaignId],
        outreachCampaignId,
        brandIds: [brandId],
        featureSlug: "ai-prospect-followup",
        runId: null,
        parentRunId: null,
        userId: null,
        workflowSlug: null,
        goal: null,
        activeGoalId: null,
        brandProfileId: null,
        acceptedEmails: "as_found",
        askFit: async () => {
          throw new Error("no audience to ask about");
        },
        askStillOwed: async () => verdict as never,
      });

    // Every other find of this source was already handed: only `later` is in stock.
    await db.execute(sql`UPDATE leads_campaigns SET source_handed_at = now() WHERE campaign_id = ${sourceCampaignId} AND lead_id <> ${later.leadId}::uuid`);
    const released = await claim({ fits: false, reason: "not yet", release: true });
    expect(released.lead).toBeNull();
    expect(released.setAside.map((r) => r.leadId)).toEqual([later.leadId]);
    expect(await handoutOfSourceRow(found!.leadCampaignId)).toBeNull();
    const left = (await db.execute(sql`SELECT count(*)::int AS n FROM leads_campaigns WHERE id = ${found!.leadCampaignId}::uuid`)) as unknown as Array<{ n: number }>;
    expect(left[0].n).toBe(0);

    // Owed again: the source finds them again, once; a stop then sets the find aside for good.
    const again = await serve();
    expect(again?.leadId).toBe(later.leadId);
    const stopped = await claim({ fits: false, reason: "no longer owed: opted_out" });
    expect(stopped.lead).toBeNull();
    expect(await handoutOfSourceRow(again!.leadCampaignId)).toEqual({ orgId, brandId, leadId: later.leadId });
    expect(await serve()).toBeNull();
  });
});
