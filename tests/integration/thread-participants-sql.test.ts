/**
 * EVERY-PERSON-ON-THE-THREAD-1109 against a REAL database. Our email went to Thomas; his colleague Markus replied in the
 * same thread (instantly-service files the reply under Thomas, `participants` names Markus as its writer). Once Markus is
 * a lead of the brand (crm-service handed him over), the reply is HIS word on HIS lead too, naming Thomas's thread;
 * Thomas's row stays and states who wrote it; Markus's provenance says he came through Thomas; nothing of Thomas moves.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const offers = new Map<string, string | null>();
vi.mock("../../src/lib/campaign-leg-client.js", () => ({
  fetchOrgCampaignOffers: vi.fn(async () => offers),
}));
vi.mock("../../src/lib/brand-client.js", () => ({
  getBrandSite: vi.fn(async () => ({ domain: "livingvital.example", clickDestinationUrl: null })),
}));

const { db } = await import("../../src/db/index.js");
const { syncTimelineFacts } = await import("../../src/lib/timeline-facts.js");
const { ingestOutreachFactsPage } = await import("../../src/lib/outreach-fact-feed.js");
const { loadCameThrough, loadLocalFilings } = await import("../../src/lib/lead-provenance.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("every person on the thread against a real database", () => {
  const org = randomUUID();
  const brand = randomUUID();
  const offer = randomUUID();
  const campaign = `itest-camp-${randomUUID()}`;
  const tag = randomUUID().slice(0, 8);
  const thomas = `thomas-${tag}@markthalle.test`;
  const markus = `markus-${tag}@markthalle.test`;
  const robot = `noreply-${tag}@markthalle.test`;
  const mailbox = `kevin-${tag}@ourmailbox.test`;
  const subject = `reply:r-${tag}`;
  const leadIds: Record<string, string> = {};

  let seq = Math.floor(Math.random() * 1e12) * 100;
  function replyFact(participants: unknown, over: Record<string, unknown> = {}) {
    seq += 1;
    return {
      seq: String(seq), type: "reply", subjectKey: subject, supersedesSeq: null, occurredAt: "2026-11-09T15:28:51.000Z",
      recordedAt: "2026-11-09T15:28:51.000Z", leadEmail: thomas, orgId: org, campaignId: campaign, instantlyCampaignId: "ic",
      brandIds: [brand], transport: "smtp", send: null, open: null, click: null, bounce: null, unsubscribe: null, withdrawal: null,
      participants, threadKey: `<root-${tag}@ourmailbox.test>`,
      reply: {
        replyId: `imap:${tag}`, subject: "Re: Flohsamenschalen", fromEmail: markus, receivedAt: "2026-11-09T15:28:51.000Z",
        verdict: { kind: "k", classification: "positive", automatedAnswer: false, stopRequested: false, notOurTarget: false,
          handedToPerson: false, positiveSignal: "information_request", declinedOffer: false, notOurTargetReason: null, handoffReason: null },
        judgments: { question: null, proposalType: null }, escalation: null,
      },
      ...over,
    };
  }
  async function feed(...facts: unknown[]) {
    await ingestOutreachFactsPage({ facts, nextCursor: String(seq), hasMore: false });
  }
  async function lead(name: string, email: string, campaignId: string, brandIds: string[]) {
    const [r] = (await db.execute(sql`INSERT INTO leads (id) VALUES (gen_random_uuid()) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${r.id}::uuid, 'email', ${email}, 'itest')`);
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
      VALUES (${r.id}::uuid, ${campaignId}, ${org}, ${sql.param(brandIds)}::text[], 'served', now())`);
    leadIds[name] = r.id;
  }
  async function rows() {
    return (await db.execute(sql`
      SELECT id, lead_id::text AS lead_id, label, detail, withdrawn_at FROM lead_timeline_facts WHERE org_id = ${org} ORDER BY id
    `)) as unknown as Array<{ id: string; lead_id: string; label: string; detail: Record<string, unknown>; withdrawn_at: unknown }>;
  }

  beforeAll(async () => {
    offers.set(campaign, offer);
    await lead("thomas", thomas, campaign, [brand]);
    // A robot that is a lead of ANOTHER brand only: never written at this brand.
    await lead("robot", robot, campaign, [randomUUID()]);
  });

  afterAll(async () => {
    for (const t of ["lead_timeline_facts", "leads_campaigns", "outreach_facts", "lead_disqualification_marks"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${org}`);
    }
    for (const id of Object.values(leadIds)) await db.execute(sql`DELETE FROM leads WHERE id = ${id}::uuid`);
  });

  it("files Markus's reply on Thomas's thread, naming its writer, and writes nothing for Markus while he is no lead", async () => {
    await feed(replyFact([{ email: markus, role: "from" }, { email: mailbox, role: "to" }, { email: robot, role: "cc" }]));
    await syncTimelineFacts(org, brand);
    const r = await rows();
    expect(r).toHaveLength(1);
    expect([r[0].id, r[0].lead_id]).toEqual([subject, leadIds.thomas]);
    expect(r[0].detail.writtenBy).toBe(markus);
  });

  it("once Markus is a lead of the brand, his own word lands on his lead naming Thomas's thread; Thomas's row is unchanged", async () => {
    const before = (await rows())[0];
    await lead("markus", markus, `unibox:${brand}`, [brand]);
    await syncTimelineFacts(org, brand);
    const r = await rows();
    expect(r).toHaveLength(2);
    const thomasRow = r.find((x) => x.lead_id === leadIds.thomas)!;
    const markusRow = r.find((x) => x.lead_id === leadIds.markus)!;
    expect(thomasRow).toEqual(before);
    expect(markusRow.id).toBe(`${subject}#writer:${leadIds.markus}`);
    expect(markusRow.label).toBe(thomasRow.label);
    expect(markusRow.detail).toMatchObject({ writtenBy: markus, thread: { leadId: leadIds.thomas, email: thomas } });
    // A re-sync writes nothing.
    expect((await syncTimelineFacts(org, brand)).written).toBe(0);
  });

  it("Markus's provenance says he came through Thomas; Thomas came through nobody", async () => {
    const through = await loadCameThrough(org, brand, [markus, thomas]);
    expect(through.get(markus)).toEqual([{ leadId: leadIds.thomas, email: thomas, firstAt: "2026-11-09T15:28:51.000Z" }]);
    expect(through.get(thomas)).toBeUndefined();
    expect((await loadCameThrough(org, randomUUID(), [markus])).size).toBe(0);
    // Filings of the intake itself are not `came_through` rows (that kind is read off the timeline).
    expect((await loadLocalFilings(org, brand, [markus])).get(markus)).toBeUndefined();
  });

  it("an older fact with no participants falls back to reply.fromEmail", async () => {
    const prev = seq;
    await feed(replyFact(undefined, { supersedesSeq: String(prev), participants: undefined }));
    await syncTimelineFacts(org, brand);
    const r = await rows();
    expect(r.find((x) => x.lead_id === leadIds.markus)?.detail.writtenBy).toBe(markus);
  });

  it("a withdrawn reply withdraws the writer's row too", async () => {
    const prev = seq;
    seq += 1;
    await feed({ ...replyFact([{ email: markus, role: "from" }]), seq: String(seq), type: "withdrawn", supersedesSeq: String(prev), reply: null });
    await syncTimelineFacts(org, brand);
    const r = await rows();
    expect(r.every((x) => x.withdrawn_at !== null)).toBe(true);
    expect((await loadCameThrough(org, brand, [markus])).size).toBe(0);
  });
});
