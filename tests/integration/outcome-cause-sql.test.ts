/**
 * The owner's whose-win rule applied to every outcome nobody answered — executed against a REAL
 * database (a mocked `sql` compiles none of the JSON / predicate work this does). email-gateway is
 * mocked; everything outcome-cause.ts writes or reads runs for real.
 *
 * What it proves:
 *   - a dated tracker outcome on a lead we delivered to BEFORE it reads ours; one dated before our
 *     first delivery reads not ours
 *   - an unmatched outcome, an undated one, and one on a lead we never delivered to stay null, each
 *     with its reason stored
 *   - a hand-stated outcome with no cause follows the rule; one whose author gave a cause is never
 *     touched
 *   - a "never delivered" answer is re-evaluated once we deliver, and a settled answer is not
 *     rewritten
 *   - the reads features-service consumes (`byCause`, `causedByOutreach`) carry the answers
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";

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
              ? {
                  contacted: true,
                  sent: true,
                  delivered: true,
                  firstContactedAt: at,
                  firstSentAt: at,
                  firstDeliveredAt: at,
                }
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
const { applyOutcomeCauseRule, listPendingCauseBrands } = await import(
  "../../src/lib/outcome-cause.js"
);
const conversionsRouter = (await import("../../src/routes/conversions.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("outcome cause rule against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const DELIVERED = "2026-05-10T00:00:00.000Z";
  const lead: Record<string, { id: string; email: string }> = {};
  const row: Record<string, string> = {};

  async function seedLead(key: string) {
    const email = `${key}-${randomUUID().slice(0, 8)}@example.com`;
    const [l] = await db
      .insert(leads)
      .values({ firstName: key, lastName: "Cause", name: `${key} Cause` })
      .returning();
    await db.insert(leadContactMethods).values({ leadId: l.id, channel: "email", value: email, source: "test" });
    lead[key] = { id: l.id, email };
  }

  async function seedEvent(
    key: string,
    e: {
      source: "tracker" | "manual";
      event: string;
      leadKey: string | null;
      at: string | null;
      stated?: boolean;
    },
  ) {
    const leadId = e.leadKey ? lead[e.leadKey].id : null;
    const rows = (await db.execute(sql`
      INSERT INTO conversion_events (
        brand_id, org_id, event, dedupe_signature, matched_lead_id, match_method, match_confidence,
        attribution_status, candidate_count, received_at, source, caused_by_outreach,
        stated_caused_by_outreach
      ) VALUES (
        ${brandId}, ${orgId}, ${e.event}, ${`itest-cause-${key}-${randomUUID()}`}, ${leadId},
        ${leadId ? "email" : null}, ${leadId ? "deterministic" : "unmatched"},
        ${leadId ? "attributed" : "unmatched"}, ${leadId ? 1 : 0}, ${e.at}, ${e.source},
        ${e.stated ?? null}, ${e.stated ?? null}
      )
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    row[key] = rows[0].id;
  }

  async function read(key: string) {
    const rows = (await db.execute(sql`
      SELECT caused_by_outreach, stated_caused_by_outreach, cause_rule
      FROM conversion_events WHERE id = ${row[key]}
    `)) as unknown as Array<{
      caused_by_outreach: boolean | null;
      stated_caused_by_outreach: boolean | null;
      cause_rule: { reason: string; causedByOutreach: boolean | null; firstDeliveredAt: string | null } | null;
    }>;
    return rows[0];
  }

  beforeAll(async () => {
    for (const k of ["after", "before", "never", "manual", "stated", "undated"]) await seedLead(k);
    for (const k of ["after", "before", "manual", "stated", "undated"]) {
      state.delivered.set(lead[k].email, DELIVERED);
    }
    state.delivered.set(lead.never.email, null);

    await seedEvent("after", { source: "tracker", event: "signup", leadKey: "after", at: "2026-05-20T00:00:00.000Z" });
    await seedEvent("before", { source: "tracker", event: "signup", leadKey: "before", at: "2026-05-01T00:00:00.000Z" });
    await seedEvent("unmatched", { source: "tracker", event: "signup", leadKey: null, at: "2026-05-20T00:00:00.000Z" });
    await seedEvent("never", { source: "tracker", event: "signup", leadKey: "never", at: "2026-05-20T00:00:00.000Z" });
    await seedEvent("manual", { source: "manual", event: "meeting_attended", leadKey: "manual", at: "2026-06-01T00:00:00.000Z" });
    await seedEvent("stated", { source: "manual", event: "sale", leadKey: "stated", at: "2026-06-01T00:00:00.000Z", stated: false });
    await seedEvent("undated", { source: "tracker", event: "signup", leadKey: "undated", at: null });
  });

  it("lists the brand as having unanswered outcomes", async () => {
    const brands = await listPendingCauseBrands();
    expect(brands).toContainEqual({ orgId, brandId });
  });

  it("answers every unanswered outcome by the date rule, and never defaults to ours", async () => {
    const result = await applyOutcomeCauseRule(orgId, brandId);
    expect(result.updated).toBe(6);

    const after = await read("after");
    expect(after.caused_by_outreach).toBe(true);
    expect(after.cause_rule?.reason).toBe("after_first_delivery");
    expect(after.cause_rule?.firstDeliveredAt).toBe(DELIVERED);

    const before = await read("before");
    expect(before.caused_by_outreach).toBe(false);
    expect(before.cause_rule?.reason).toBe("before_first_delivery");

    expect((await read("unmatched")).caused_by_outreach).toBeNull();
    expect((await read("unmatched")).cause_rule?.reason).toBe("not_matched");
    expect((await read("never")).caused_by_outreach).toBeNull();
    expect((await read("never")).cause_rule?.reason).toBe("never_delivered");
    expect((await read("undated")).caused_by_outreach).toBeNull();
    expect((await read("undated")).cause_rule?.reason).toBe("event_undated");

    // A hand-stated outcome nobody answered the cause of follows the same rule.
    expect((await read("manual")).caused_by_outreach).toBe(true);
    // A person's answer is never touched, even where the rule would say otherwise.
    const stated = await read("stated");
    expect(stated.caused_by_outreach).toBe(false);
    expect(stated.cause_rule).toBeNull();
  });

  it("does not rewrite a settled answer, and re-evaluates one that could still move", async () => {
    const again = await applyOutcomeCauseRule(orgId, brandId);
    expect(again.updated).toBe(0);

    // We deliver to the "never" lead AFTER its signup: the rule now answers not ours.
    state.delivered.set(lead.never.email, "2026-05-25T00:00:00.000Z");
    const third = await applyOutcomeCauseRule(orgId, brandId);
    expect(third.updated).toBe(1);
    const never = await read("never");
    expect(never.caused_by_outreach).toBe(false);
    expect(never.cause_rule?.reason).toBe("before_first_delivery");
  });

  it("serves the answers on the reads features-service consumes", async () => {
    const app = express();
    app.use(conversionsRouter);
    const counts = await request(app)
      .get(`/internal/brands/${brandId}/conversion-counts`)
      .set("x-api-key", process.env.LEAD_SERVICE_API_KEY ?? "test-api-key");
    expect(counts.status).toBe(200);
    // Attributed signups: after (ours), before + never (not ours), undated (undecided).
    expect(counts.body.byCause.outreach.signup).toBe(1);
    expect(counts.body.byCause.other.signup).toBe(2);
    expect(counts.body.byCause.unstated.signup).toBe(1);

    const converted = await request(app)
      .get(`/internal/brands/${brandId}/converted-leads?event=signup`)
      .set("x-api-key", process.env.LEAD_SERVICE_API_KEY ?? "test-api-key");
    expect(converted.status).toBe(200);
    const byLead = new Map(
      (converted.body.outcomes as Array<{ leadId: string; causedByOutreach: boolean | null; causeBasis: string | null; causeReason: string | null }>).map(
        (o) => [o.leadId, o],
      ),
    );
    expect(byLead.get(lead.after.id)).toMatchObject({
      causedByOutreach: true,
      causeBasis: "rule",
      causeReason: "after_first_delivery",
    });
    expect(byLead.get(lead.undated.id)).toMatchObject({
      causedByOutreach: null,
      causeBasis: "rule",
      causeReason: "event_undated",
    });

    const sales = await request(app)
      .get(`/internal/brands/${brandId}/converted-leads?event=sale`)
      .set("x-api-key", process.env.LEAD_SERVICE_API_KEY ?? "test-api-key");
    expect(sales.body.outcomes[0]).toMatchObject({ causedByOutreach: false, causeBasis: "person", causeReason: null });
  });
});
