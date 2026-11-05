/**
 * AGENT-READS-LEAD-1105 against a REAL database: one lead's Unibox state, by lead id and by email, with who acted last,
 * whether anything waits on us, the next follow-up date and the messages each way. The seeded case is Edmund Bartlett's
 * (prod 2026-11-02..04): one sequence email, his reply 11-02 13:22, three answers of ours, the last 11-04 18:54.
 */
import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string) => {
    if (String(url).endsWith("/public/catalogue/steps")) {
      return new Response(JSON.stringify({ object: "step", lifecycleLadder: [{ key: "contacted", rank: 2, label: "Contacted" }], rows: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  },
}));

const { db } = await import("../../src/db/index.js");
const { readUniboxLeadState, AmbiguousBrandError } = await import("../../src/lib/unibox-state.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("one lead's Unibox state (AGENT-READS-LEAD-1105)", () => {
  const org = randomUUID();
  const brand = randomUUID();
  const otherBrand = randomUUID();
  const human = randomUUID();
  const company = randomUUID();
  let leadId = "";
  const email = `EBartlett-${randomUUID()}@behavioral.test`;
  const point = `email:${email.toLowerCase()}`;
  let seq = Math.floor(Math.random() * 1e9) * 1000 + 8e14;

  async function outreach(type: string, at: string, brandIds = [brand]) {
    seq += 1;
    await db.execute(sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, brand_ids, raw)
      VALUES (${seq}, ${`ievt:${randomUUID()}`}, ${type}, ${at}::timestamptz, ${email}, ${org}, ${sql.param(brandIds)}::text[], '{}'::jsonb)`);
  }

  async function seed() {
    const [l] = (await db.execute(sql`INSERT INTO leads (first_name, last_name) VALUES ('Edmund', 'Bartlett') RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leadId = l.id;
    await db.execute(sql`
      INSERT INTO unibox_rows (org_id, brand_id, human_id, company_key, name, emails, relation_keys, lead_ids, interest, conversation, contactability, fit,
        last_theirs_at, last_ours_at, last_activity_at, lifecycle_key, lifecycle_rank)
      VALUES (${org}, ${brand}, ${human}::uuid, ${company}, 'Edmund Bartlett', ARRAY[${email}]::text[], ARRAY[${`rel:${randomUUID()}:org:${company}`}]::text[],
        ARRAY[${leadId}]::uuid[], 'interested', 'waiting_on_them', 'contactable', 'fit',
        '2026-11-02T13:22:45Z', '2026-11-04T18:54:18Z', '2026-11-04T18:54:18Z', 'contacted', 2)`);
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, name, contact_points)
      VALUES (${org}, ${brand}, ${human}::uuid, ${company}, 'Edmund Bartlett', ARRAY[${point}]::text[])`);
    await outreach("email_sent", "2026-11-02T12:23:48Z");
    await outreach("reply", "2026-11-02T13:22:45Z");
    await outreach("reply_sent", "2026-11-02T13:24:00Z");
    await outreach("reply_sent", "2026-11-02T13:26:00Z");
    await outreach("reply_sent", "2026-11-04T18:54:18Z");
    // Another brand's send to the same address is not this brand's message.
    await outreach("email_sent", "2026-11-03T00:00:00Z", [otherBrand]);
    // One WhatsApp exchange on the relation's own point, and a withdrawn one that no longer counts.
    const crm = async (type: string, factId = randomUUID(), withdrawnOf: string | null = null) => {
      await db.execute(sql`
        INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw, withdrawn_of)
        VALUES (${factId}, ${String(BigInt(seq) + 1_000_000n + BigInt(Math.floor(Math.random() * 1e6)))}::bigint, ${org}, ${brand}, ${point}, ${point},
          ARRAY[${email}]::text[], '{}'::text[], ${type}, now(), 'event', 'matrix', ${randomUUID()}, '{}'::jsonb, '{}'::jsonb, ${withdrawnOf})`);
      return factId;
    };
    await crm("message_out");
    await crm("message_in");
    const gone = await crm("message_in");
    await crm("withdrawn", randomUUID(), gone);
    await db.execute(sql`
      INSERT INTO lead_followup_dates (org_id, brand_id, lead_id, next_followup_at, basis, reason)
      VALUES (${org}, ${brand}, ${leadId}::uuid, '2026-11-11T18:54:18Z', 'send', 'Last email send + 7 days')`);
  }

  it("answers Edmund's case: last action ours (11-04), nothing waiting on us", async () => {
    await seed();
    const state = await readUniboxLeadState(org, { brandId: null, leadId, email: null });
    expect(state).not.toBeNull();
    expect(state!.brandId).toBe(brand);
    expect(state!.leadId).toBe(leadId);
    expect(state!.lastAction).toEqual({ side: "ours", at: "2026-11-04T18:54:18.000Z" });
    expect(state!.waitingOnUs).toBe(false);
    expect(state!.lead.conversation).toBe("waiting_on_them");
    expect(state!.lead.interest).toBe("interested");
    expect(state!.nextFollowup).toEqual({ at: "2026-11-11T18:54:18.000Z", basis: "send", reason: "Last email send + 7 days" });
    expect(state!.messages).toEqual({
      ours: 5, theirs: 2, sequenceEmails: 1, emailAnswers: 3, emailReplies: 1, otherChannelsOurs: 1, otherChannelsTheirs: 1,
    });
  });

  it("by email (any case) + brand reads the same row; unknown = null", async () => {
    const byEmail = await readUniboxLeadState(org, { brandId: brand, leadId: null, email: email.toUpperCase() });
    expect(byEmail?.lead.humanId).toBe(human);
    expect(await readUniboxLeadState(org, { brandId: null, leadId: randomUUID(), email: null })).toBeNull();
    expect(await readUniboxLeadState(randomUUID(), { brandId: null, leadId, email: null })).toBeNull();
  });

  it("the same person in two brands' Unibox: no brand named = several brands, a brand named = its row", async () => {
    await db.execute(sql`
      INSERT INTO unibox_rows (org_id, brand_id, human_id, company_key, emails, lead_ids, interest, conversation, contactability, fit, last_activity_at)
      VALUES (${org}, ${otherBrand}, ${human}::uuid, ${company}, ARRAY[${email}]::text[], ARRAY[${leadId}]::uuid[], 'not_asked', 'no_reply_yet', 'contactable', 'fit', now())`);
    await expect(readUniboxLeadState(org, { brandId: null, leadId, email: null })).rejects.toBeInstanceOf(AmbiguousBrandError);
    const other = await readUniboxLeadState(org, { brandId: otherBrand, leadId, email: null });
    expect(other?.messages.sequenceEmails).toBe(1);
    expect(other?.nextFollowup).toBeNull();
    expect(other?.nextFollowupReason).toBe("no_date_yet");
  });
});
