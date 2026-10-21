/**
 * The whose-win rule counts a NON-EMAIL pipe send as our touch (first-touch.ts, owner 2026-10-21: any of our pipes,
 * any channel). Real database; email-gateway mocked as "never delivered" for everyone, so every answer below comes
 * from `leads_campaigns.channel_sent_at` alone.
 *
 *   - a signup dated AFTER a WhatsApp pipe send to the lead reads ours;
 *   - one dated BEFORE it reads not ours (the pipe wrote to someone who had already signed up);
 *   - a send marked on a row of ANOTHER brand is not a touch of this brand;
 *   - an email delivery earlier than the channel send wins (earliest touch).
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const state = vi.hoisted(() => ({ delivered: new Map<string, string | null>() }));

vi.mock("../../src/lib/email-gateway-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/email-gateway-client.js")>();
  return {
    ...actual,
    checkDeliveryStatus: vi.fn(async (_b: string, _c: unknown, items: Array<{ email: string }>) => ({
      results: items.map(({ email }) => {
        const at = state.delivered.get(email) ?? null;
        return {
          email,
          broadcast: {
            brand: at
              ? { contacted: true, sent: true, delivered: true, firstContactedAt: at, firstSentAt: at, firstDeliveredAt: at }
              : null,
          },
        };
      }),
    })),
  };
});

const { db } = await import("../../src/db/index.js");
const { sql } = await import("drizzle-orm");
const { leads, leadContactMethods } = await import("../../src/db/schema.js");
const { applyOutcomeCauseRule } = await import("../../src/lib/outcome-cause.js");
const { firstChannelSends, firstTouchAt } = await import("../../src/lib/first-touch.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe("firstTouchAt", () => {
  it("takes the earliest instant, whatever the format", () => {
    expect(firstTouchAt(null, null)).toBeNull();
    expect(firstTouchAt("2026-05-10T00:00:00.000Z", null)).toBe("2026-05-10T00:00:00.000Z");
    expect(firstTouchAt(null, "2026-05-10T00:00:00.000Z")).toBe("2026-05-10T00:00:00.000Z");
    expect(firstTouchAt("2026-05-10T00:00:00Z", "2026-05-09T23:00:00.000Z")).toBe("2026-05-09T23:00:00.000Z");
    expect(firstTouchAt("2026-05-09T00:00:00Z", "2026-05-09T23:00:00.000Z")).toBe("2026-05-09T00:00:00Z");
  });
});

describe.skipIf(!hasRealDatabase)("outcome cause rule reads non-email pipe sends", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const otherBrandId = randomUUID();
  const lead: Record<string, { id: string; email: string }> = {};
  const row: Record<string, string> = {};

  async function seedLead(key: string) {
    const email = `${key.toLowerCase()}-${randomUUID().slice(0, 8)}@example.com`;
    const [l] = await db.insert(leads).values({ firstName: key, lastName: "Touch", name: `${key} Touch` }).returning();
    await db.insert(leadContactMethods).values({ leadId: l.id, channel: "email", value: email, source: "test" });
    lead[key] = { id: l.id, email };
  }

  async function seedServe(key: string, brand: string, channelSentAt: string | null) {
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at, channel_sent_at)
      VALUES (${lead[key].id}, ${randomUUID()}, ${orgId}, ${sql.param([brand])}::text[], 'served',
              '2026-04-01T00:00:00.000Z', ${channelSentAt})
    `);
  }

  async function seedSignup(key: string, at: string) {
    const rows = (await db.execute(sql`
      INSERT INTO conversion_events (
        brand_id, org_id, event, dedupe_signature, matched_lead_id, match_method, match_confidence,
        attribution_status, candidate_count, received_at, source
      ) VALUES (
        ${brandId}, ${orgId}, 'signup', ${`itest-touch-${key}-${randomUUID()}`}, ${lead[key].id},
        'email', 'deterministic', 'attributed', 1, ${at}, 'tracker'
      )
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    row[key] = rows[0].id;
  }

  async function read(key: string) {
    const rows = (await db.execute(sql`
      SELECT caused_by_outreach, cause_rule FROM conversion_events WHERE id = ${row[key]}
    `)) as unknown as Array<{
      caused_by_outreach: boolean | null;
      cause_rule: { reason: string; firstDeliveredAt: string | null } | null;
    }>;
    return rows[0];
  }

  beforeAll(async () => {
    for (const k of ["waBefore", "waAfter", "otherBrand", "emailFirst"]) await seedLead(k);
    // WhatsApp sent 05-10, signup 05-20: ours.
    await seedServe("waBefore", brandId, "2026-05-10T00:00:00.000Z");
    await seedServe("waBefore", brandId, "2026-05-15T00:00:00.000Z");
    await seedSignup("waBefore", "2026-05-20T00:00:00.000Z");
    // Signed up 05-01, WhatsApp only 05-10: not ours.
    await seedServe("waAfter", brandId, "2026-05-10T00:00:00.000Z");
    await seedSignup("waAfter", "2026-05-01T00:00:00.000Z");
    // The only send is on another brand: still never touched at this brand.
    await seedServe("otherBrand", otherBrandId, "2026-05-10T00:00:00.000Z");
    await seedSignup("otherBrand", "2026-05-20T00:00:00.000Z");
    // Email delivered 05-02, WhatsApp 05-10, signup 05-05: the email is the first touch -> ours.
    state.delivered.set(lead.emailFirst.email, "2026-05-02T00:00:00.000Z");
    await seedServe("emailFirst", brandId, "2026-05-10T00:00:00.000Z");
    await seedSignup("emailFirst", "2026-05-05T00:00:00.000Z");
  });

  it("reads the earliest non-email send per lead, at this brand only", async () => {
    const sends = await firstChannelSends(orgId, brandId, Object.values(lead).map((l) => l.id));
    expect(sends.get(lead.waBefore.id)).toBe("2026-05-10T00:00:00.000Z");
    expect(sends.has(lead.otherBrand.id)).toBe(false);
  });

  it("answers by the earliest touch on any channel", async () => {
    const result = await applyOutcomeCauseRule(orgId, brandId);
    expect(result.updated).toBe(4);

    const waBefore = await read("waBefore");
    expect(waBefore.caused_by_outreach).toBe(true);
    expect(waBefore.cause_rule?.reason).toBe("after_first_delivery");
    expect(waBefore.cause_rule?.firstDeliveredAt).toBe("2026-05-10T00:00:00.000Z");

    const waAfter = await read("waAfter");
    expect(waAfter.caused_by_outreach).toBe(false);
    expect(waAfter.cause_rule?.reason).toBe("before_first_delivery");

    const otherBrand = await read("otherBrand");
    expect(otherBrand.caused_by_outreach).toBeNull();
    expect(otherBrand.cause_rule?.reason).toBe("never_delivered");

    const emailFirst = await read("emailFirst");
    expect(emailFirst.caused_by_outreach).toBe(true);
    expect(emailFirst.cause_rule?.firstDeliveredAt).toBe("2026-05-02T00:00:00.000Z");
  });
});
