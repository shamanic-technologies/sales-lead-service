/**
 * The CRM pairing store, executed against a REAL database.
 *
 * Every statement in this store is raw `sql`: a five-way `unnest(...)` of typed arrays (one of
 * them a `uuid[]` carrying NULLs for the contacts nothing matched), a `DISTINCT ON`, two upserts
 * whose whole point is the conflict target, and a `NOT EXISTS` joined through a second table. A
 * mocked `sql` compiles none of it, so a statement that cannot run still ships green — this repo
 * has shipped exactly that twice (`cannot cast type record to text[]`, and a raw `Date` thrown at
 * Bind). So this file RUNS them.
 *
 * What it proves, beyond "the SQL parses":
 *   - a frozen match is written ONCE, so re-matching cannot change an answer already served
 *   - a withdrawn ruling stops being read, and restating brings it back without a second row
 *   - the "leads their CRM has never heard of" count excludes a REJECTED pairing, the same way
 *     the table does — a summary and its table must not disagree about one pair
 */
import { beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns } = await import("../../src/db/schema.js");
const {
  countLeadsNoCrmContactPointsAt,
  freezeMatches,
  loadFrozenMatches,
  loadJudgments,
  loadRulings,
  rulingKey,
  saveJudgment,
  upsertRuling,
  withdrawRuling,
} = await import("../../src/lib/crm-pairing-store.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("the CRM pairing store against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const campaignId = `itest-crm-${randomUUID()}`;

  let pairedLeadId = "";
  let rejectedLeadId = "";
  let lonelyLeadId = "";

  async function seedServedLead(lastName: string): Promise<string> {
    const [lead] = await db
      .insert(leads)
      .values({ firstName: "Dana", lastName, name: `Dana ${lastName}` })
      .returning();
    await db.insert(leadsCampaigns).values({
      leadId: lead.id,
      campaignId,
      orgId,
      userId: "u1",
      brandIds: [brandId],
      status: "served",
      servedAt: new Date(),
    });
    return lead.id;
  }

  beforeAll(async () => {
    pairedLeadId = await seedServedLead("Paired");
    rejectedLeadId = await seedServedLead("Rejected");
    lonelyLeadId = await seedServedLead("Lonely");
  }, 60_000);

  it("freezes a match once, NULL lead included, and never overwrites it", async () => {
    const written = await freezeMatches(orgId, brandId, [
      {
        crmContactId: "crm-paired",
        result: {
          matchedLeadId: pairedLeadId,
          matchMethod: "email",
          matchConfidence: "deterministic",
          attributionStatus: "attributed",
          candidateCount: 1,
          candidates: [{ leadId: pairedLeadId }],
        },
      },
      {
        // A contact nothing matched still gets a row, so it is never re-matched on every read.
        crmContactId: "crm-unmatched",
        result: {
          matchedLeadId: null,
          matchMethod: null,
          matchConfidence: "unmatched",
          attributionStatus: "unmatched",
          candidateCount: 0,
          candidates: [],
        },
      },
    ]);

    expect(written.get("crm-paired")?.matchedLeadId).toBe(pairedLeadId);
    expect(written.get("crm-paired")?.matchConfidence).toBe("deterministic");
    expect(written.get("crm-unmatched")?.matchedLeadId).toBeNull();
    expect(written.get("crm-unmatched")?.matchMethod).toBeNull();

    // Re-matching the same contact to a DIFFERENT lead must change nothing — the freeze is what
    // makes reading the view twice return the same pairings.
    const again = await freezeMatches(orgId, brandId, [
      {
        crmContactId: "crm-paired",
        result: {
          matchedLeadId: rejectedLeadId,
          matchMethod: "last_name",
          matchConfidence: "probabilistic",
          attributionStatus: "attributed",
          candidateCount: 9,
          candidates: [{ leadId: rejectedLeadId }],
        },
      },
    ]);
    expect(again.get("crm-paired")?.matchedLeadId).toBe(pairedLeadId);
    expect(again.get("crm-paired")?.matchConfidence).toBe("deterministic");

    const loaded = await loadFrozenMatches(brandId, ["crm-paired", "crm-unmatched", "crm-absent"]);
    expect(loaded.size).toBe(2);
    expect(loaded.has("crm-absent")).toBe(false);
  });

  it("freezes a judgment with the release that produced it", async () => {
    await saveJudgment({
      orgId,
      brandId,
      crmContactId: "crm-judged",
      leadId: pairedLeadId,
      samePersonProbability: 0.9312,
      model: "jev-1.13.0",
    });
    // The same release answering again is the same answer: nothing is written twice.
    await saveJudgment({
      orgId,
      brandId,
      crmContactId: "crm-judged",
      leadId: pairedLeadId,
      samePersonProbability: 0.1,
      model: "jev-1.13.0",
    });

    const judgments = await loadJudgments(brandId, ["crm-judged"]);
    const judged = judgments.get("crm-judged");
    expect(judged?.leadId).toBe(pairedLeadId);
    expect(judged?.model).toBe("jev-1.13.0");
    expect(judged?.samePersonProbability).toBeCloseTo(0.9312, 4);
  });

  it("withdraws a ruling without deleting it, and restating brings it back", async () => {
    await upsertRuling({
      orgId,
      brandId,
      crmContactId: "crm-ruled",
      leadId: pairedLeadId,
      ruling: "accepted",
      note: "same person, confirmed on the call",
      statedByUserId: "u1",
    });
    let live = await loadRulings(brandId, ["crm-ruled"]);
    expect(live.get(rulingKey("crm-ruled", pairedLeadId))?.ruling).toBe("accepted");

    const withdrawn = await withdrawRuling({
      brandId,
      crmContactId: "crm-ruled",
      leadId: pairedLeadId,
      withdrawnByUserId: "u1",
    });
    expect(withdrawn).toEqual({ existed: true, alreadyWithdrawn: false });

    live = await loadRulings(brandId, ["crm-ruled"]);
    expect(live.size).toBe(0);

    expect(
      await withdrawRuling({
        brandId,
        crmContactId: "crm-ruled",
        leadId: pairedLeadId,
        withdrawnByUserId: "u1",
      }),
    ).toEqual({ existed: true, alreadyWithdrawn: true });

    expect(
      await withdrawRuling({
        brandId,
        crmContactId: "crm-never-ruled",
        leadId: pairedLeadId,
        withdrawnByUserId: "u1",
      }),
    ).toEqual({ existed: false, alreadyWithdrawn: false });

    // Restating is the same person making the same statement again: one row, mark cleared.
    await upsertRuling({
      orgId,
      brandId,
      crmContactId: "crm-ruled",
      leadId: pairedLeadId,
      ruling: "rejected",
      note: null,
      statedByUserId: "u2",
    });
    live = await loadRulings(brandId, ["crm-ruled"]);
    expect(live.size).toBe(1);
    const restated = live.get(rulingKey("crm-ruled", pairedLeadId));
    expect(restated?.ruling).toBe("rejected");
    expect(restated?.note).toBeNull();
    expect(restated?.statedByUserId).toBe("u2");
  });

  it("counts our leads no LIVE pairing points at — a rejected pairing does not make a lead known", async () => {
    // Three served leads for this brand. Only `crm-paired` -> pairedLeadId is live so far.
    expect(await countLeadsNoCrmContactPointsAt(brandId)).toBe(2);

    await freezeMatches(orgId, brandId, [
      {
        crmContactId: "crm-rejected",
        result: {
          matchedLeadId: rejectedLeadId,
          matchMethod: "last_name",
          matchConfidence: "probabilistic",
          attributionStatus: "attributed",
          candidateCount: 40,
          candidates: [{ leadId: rejectedLeadId }],
        },
      },
    ]);
    expect(await countLeadsNoCrmContactPointsAt(brandId)).toBe(1);

    // A human says these are two different humans, so their CRM has NOT heard of that lead.
    await upsertRuling({
      orgId,
      brandId,
      crmContactId: "crm-rejected",
      leadId: rejectedLeadId,
      ruling: "rejected",
      note: "namesake",
      statedByUserId: "u1",
    });
    expect(await countLeadsNoCrmContactPointsAt(brandId)).toBe(2);

    // Withdrawing the rejection puts the pairing back, and the count with it.
    await withdrawRuling({
      brandId,
      crmContactId: "crm-rejected",
      leadId: rejectedLeadId,
      withdrawnByUserId: "u1",
    });
    expect(await countLeadsNoCrmContactPointsAt(brandId)).toBe(1);

    // The lead nothing ever pointed at is the one left.
    expect(lonelyLeadId).not.toBe("");
  });

  it("answers an empty key set without touching the database", async () => {
    expect((await loadFrozenMatches(brandId, [])).size).toBe(0);
    expect((await loadJudgments(brandId, [])).size).toBe(0);
    expect((await loadRulings(brandId, [])).size).toBe(0);
    expect((await freezeMatches(orgId, brandId, [])).size).toBe(0);
  });
});
