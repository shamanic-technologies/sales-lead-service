/**
 * REPLY-LATENCY-ALL-CHANNELS-1019 against a REAL database: first message we sent under a group of campaigns (timeline
 * email, non-email channel send, follow-up worker answer) -> that person's first positive reply after it (timeline
 * verdict positive, or the CRM's positive reply), per group, fleet-wide. Staff test addresses only.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { loadReplyLatencyByGroups, REPLY_LATENCY_BUCKETS } = await import("../../src/lib/reply-latency.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (h: number) => new Date(T0 + h * HOUR).toISOString();

describe.skipIf(!hasRealDatabase)("first message -> first positive reply per campaign group (REPLY-LATENCY-ALL-CHANNELS-1019)", () => {
  const tag = randomUUID().slice(0, 8);
  const orgA = randomUUID();
  const orgB = randomUUID();
  const brandA = randomUUID();
  const brandB = randomUUID();
  const cold = `itest-cold-${tag}`;
  const whatsapp = `itest-wa-${tag}`;
  const writer = `itest-writer-${tag}`;
  const coldB = `itest-cold-b-${tag}`;
  const silent = `itest-silent-${tag}`;
  const leads: string[] = [];

  async function person(): Promise<string> {
    const [row] = (await db.execute(sql`INSERT INTO leads (first_name) VALUES ('Latency') RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leads.push(row.id);
    return row.id;
  }

  async function fact(org: string, brand: string, lead: string, campaign: string | null, h: number, label: string, source: string, detail: object = {}, withdrawn = false) {
    const id = `${source}:itest:${tag}:${randomUUID()}`;
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, campaign_id, occurred_at, label, source, source_ref, detail, withdrawn_at)
      VALUES (${id}, ${org}, ${brand}, ${lead}::uuid, ${campaign}, ${at(h)}::timestamptz, ${label}, ${source}, ${id},
              ${JSON.stringify(detail)}::jsonb, ${withdrawn ? at(h) : null}::timestamptz)`);
  }
  const send = (org: string, brand: string, lead: string, campaign: string, h: number, label = "initial_email") =>
    fact(org, brand, lead, campaign, h, label, "outreach");
  const positive = (org: string, brand: string, lead: string, h: number, withdrawn = false) =>
    fact(org, brand, lead, `itest-other-${tag}`, h, "interested", "reply", { classification: "positive" }, withdrawn);
  const neutral = (org: string, brand: string, lead: string, h: number) =>
    fact(org, brand, lead, `itest-other-${tag}`, h, "question", "reply", { classification: "neutral" });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM lead_timeline_facts WHERE org_id IN (${orgA}, ${orgB})`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id IN (${orgA}, ${orgB})`);
    await db.execute(sql`DELETE FROM followup_actions WHERE org_id IN (${orgA}, ${orgB})`);
    await db.execute(sql`DELETE FROM conversion_events WHERE org_id IN (${orgA}, ${orgB})`);
    if (leads.length > 0) await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(leads)}::uuid[])`);
  });

  it("measures from the first message on any channel to the first positive reply after it, per group, cross-org", async () => {
    // a: emailed at 0 (cold) and followed up at 24, first positive at 48 -> 48h. An earlier neutral reply is not positive.
    const a = await person();
    await send(orgA, brandA, a, cold, 0);
    await send(orgA, brandA, a, cold, 24, "followup");
    await neutral(orgA, brandA, a, 10);
    await positive(orgA, brandA, a, 48);
    await positive(orgA, brandA, a, 72);
    // b: a WhatsApp send (no email) at 0, positive at 6 -> 6h.
    const b = await person();
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, channel_sent_at)
      VALUES (${b}::uuid, ${whatsapp}, ${orgA}, ARRAY[${brandA}]::text[], 'served', ${at(-1)}::timestamptz, ${at(0)}::timestamptz)`);
    await positive(orgA, brandA, b, 6);
    // c: answered by the follow-up worker at 0 (acted under the writer campaign), CRM positive reply at 12 -> 12h.
    const c = await person();
    await db.execute(sql`
      INSERT INTO followup_actions (org_id, brand_ids, lead_campaign_id, lead_id, held_by_campaign_id, acting_campaign_id, action, occurred_at)
      VALUES (${orgA}, ARRAY[${brandA}]::text[], ${randomUUID()}::uuid, ${c}::uuid, ${cold}, ${writer}, 'acted', ${at(0)}::timestamptz)`);
    await db.execute(sql`
      INSERT INTO conversion_events (org_id, brand_id, event, source, email, matched_lead_id, match_confidence, attribution_status, received_at)
      VALUES (${orgA}, ${brandA}, 'positive_reply', 'crm', ${`c-${tag}@example.test`}, ${c}::uuid, 'deterministic', 'attributed', ${at(12)}::timestamptz)`);
    // d: another org, emailed at 0 on its own cold campaign, positive at 2 -> 2h (the fleet group reads it).
    const d = await person();
    await send(orgB, brandB, d, coldB, 0);
    await positive(orgB, brandB, d, 2);
    // e: positive reply only BEFORE our first message, and a withdrawn positive after: not in the sample.
    const e = await person();
    await positive(orgA, brandA, e, -5);
    await send(orgA, brandA, e, cold, 0);
    await positive(orgA, brandA, e, 3, true);
    // f: positive at the right time but at ANOTHER brand than the send: not this person at this brand.
    const f = await person();
    await send(orgA, brandA, f, cold, 0);
    await positive(orgA, brandB, f, 4);
    // g: emailed, never replied: not in the sample.
    const g = await person();
    await send(orgA, brandA, g, silent, 0);

    const out = await loadReplyLatencyByGroups([
      { key: "campaign", campaignIds: [cold, whatsapp, writer, cold] },
      { key: "fleet", campaignIds: [cold, whatsapp, writer, coldB] },
      { key: "silent", campaignIds: [silent] },
      { key: "unknown", campaignIds: [`itest-nobody-${tag}`] },
    ]);

    expect(out.map((o) => o.key)).toEqual(["campaign", "fleet", "silent", "unknown"]);
    expect(out[0].campaignIds).toEqual([cold, whatsapp, writer]);
    // campaign: 48h, 6h, 12h -> median 12h, average 22h.
    const campaign = out[0].timeToFirstPositiveReply;
    expect({ sampleSize: campaign.sampleSize, medianMs: campaign.medianMs, averageMs: campaign.averageMs }).toEqual({ sampleSize: 3, medianMs: 12 * HOUR, averageMs: 22 * HOUR });
    // interpolated over [6, 12, 48]: p10 = 6 + 0.2*6, p25 = 6 + 0.5*6, p75 = 12 + 0.5*36, p90 = 12 + 0.8*36.
    expect(campaign.percentilesMs).toEqual({ p10: 7.2 * HOUR, p25: 9 * HOUR, p50: 12 * HOUR, p75: 30 * HOUR, p90: 40.8 * HOUR });
    const counts = (d: typeof campaign.distribution) => Object.fromEntries(d.filter((b) => b.count > 0).map((b) => [b.key, b.count]));
    expect(campaign.distribution.map((b) => b.key)).toEqual(REPLY_LATENCY_BUCKETS.map((b) => b.key));
    // 6h falls in [6h, 12h) (lower bound inclusive), 12h in [12h, 24h), 48h in [2d, 3d).
    expect(counts(campaign.distribution)).toEqual({ "6h_12h": 1, "12h_1d": 1, "2d_3d": 1 });
    expect(campaign.distribution.at(-1)!.cumulativeCount).toBe(3);
    // fleet: + 2h -> median (6+12)/2 = 9h, average 17h.
    const fleet = out[1].timeToFirstPositiveReply;
    expect({ sampleSize: fleet.sampleSize, medianMs: fleet.medianMs, averageMs: fleet.averageMs }).toEqual({ sampleSize: 4, medianMs: 9 * HOUR, averageMs: 17 * HOUR });
    expect(fleet.percentilesMs.p50).toBe(fleet.medianMs);
    expect(counts(fleet.distribution)).toEqual({ "1h_3h": 1, "6h_12h": 1, "12h_1d": 1, "2d_3d": 1 });
    expect(fleet.distribution.reduce((s, b) => s + b.count, 0)).toBe(4);
    // empty groups: nulls and no buckets, never zeros.
    const empty = { sampleSize: 0, medianMs: null, averageMs: null, percentilesMs: { p10: null, p25: null, p50: null, p75: null, p90: null }, distribution: [] };
    expect(out[2].timeToFirstPositiveReply).toEqual(empty);
    expect(out[3].timeToFirstPositiveReply).toEqual(empty);
  });
});
