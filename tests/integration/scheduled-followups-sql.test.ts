/**
 * NEXT-STEPS-ALL-CHANNELS-1019 against a REAL database: what a campaign scheduled on every channel = the people whose
 * follow-up date it last stated (not a stop, not a 30-day recheck) plus its reactive follow-up queue, once per person
 * at the earliest time. Staff test addresses only.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { loadScheduledFollowups } = await import("../../src/lib/scheduled-followups.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("scheduled follow-ups of a campaign (NEXT-STEPS-ALL-CHANNELS-1019)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const writer = randomUUID();
  const other = randomUUID();
  const leads: string[] = [];
  const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

  async function person(): Promise<string> {
    const [row] = (await db.execute(sql`INSERT INTO leads (first_name, human_id) VALUES ('Sched', ${randomUUID()}::uuid) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leads.push(row.id);
    return row.id;
  }

  async function dated(leadId: string, at: string | null, basis: string, statedBy: string | null) {
    await db.execute(sql`
      INSERT INTO lead_followup_dates (org_id, brand_id, lead_id, next_followup_at, basis, stated_by_campaign_id)
      VALUES (${orgId}, ${brandId}, ${leadId}::uuid, ${at}::timestamptz, ${basis}, ${statedBy})`);
  }

  async function queuedRow(leadId: string, campaignId: string, dueAt: string) {
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, followup_due_at)
      VALUES (${leadId}::uuid, ${campaignId}, ${orgId}, ARRAY[${brandId}]::text[], 'served', now(), ${dueAt}::timestamptz)`);
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM lead_followup_dates WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    if (leads.length > 0) await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(leads)}::uuid[])`);
  });

  it("counts every person the campaign scheduled once, due vs upcoming, by day, never a stop or another campaign's", async () => {
    const a = await person();
    const b = await person();
    const c = await person();
    const d = await person();
    const e = await person();
    const f = await person();
    await dated(a, hours(13), "stated", writer); // tomorrow
    await dated(b, hours(14), "stated", writer); // tomorrow
    await dated(c, hours(-2), "stated", writer); // due: goes out on the next pass
    await dated(d, null, "stopped", writer); // their word ended it
    await dated(e, hours(24 * 30), "stop_recheck", writer); // not owed: asked again later, not a follow-up
    await dated(f, hours(5), "stated", other); // another campaign's
    await dated(await person(), hours(24 * 60), "stated", writer); // beyond the by-day horizon
    await queuedRow(a, writer, hours(3)); // same person, earlier in the reactive queue: counted once, at 3h
    await queuedRow(f, writer, hours(40));

    const s = await loadScheduledFollowups(orgId, [writer]);
    expect(s).toMatchObject({ leads: 5, due: 1, upcoming: 4, laterThanHorizon: 1 });
    expect(new Date(s.nextAt!).getTime()).toBeCloseTo(new Date(hours(3)).getTime(), -4);
    expect(s.oldestDueAt).not.toBeNull();
    expect(s.byDay.reduce((n, d) => n + d.leads, 0)).toBe(3);

    const none = await loadScheduledFollowups(orgId, [randomUUID()]);
    expect(none).toMatchObject({ leads: 0, due: 0, upcoming: 0, nextAt: null, oldestDueAt: null, byDay: [], laterThanHorizon: 0 });
    expect(none.asOf).toMatch(/^\d{4}-/);
  });
});
