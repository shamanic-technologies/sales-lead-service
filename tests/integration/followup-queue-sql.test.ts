/**
 * The follow-up queue's concurrency, executed against a REAL database.
 *
 * Two workers must never answer the same prospect twice: several replies land at the same moment,
 * and a read-then-write race would double-email a person, which is the one failure this feature
 * cannot take back. That guarantee lives in a conditional `UPDATE ... RETURNING` — a claim only
 * one transaction can win — and a mocked database cannot fail the way a real one does, which is
 * exactly how the paid pool's `cannot cast type record to text[]` reached production. So this file
 * RUNS the statements, concurrently, rather than asserting their shape.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

vi.mock("../../src/lib/email-gateway-client.js", () => ({
  // Nobody in these fixtures opted out. The opt-out stop has its own unit coverage; what is under
  // test here is the claim's exclusivity against a real Postgres.
  checkDeliveryStatus: async () => ({ results: [] }),
}));

/**
 * When each acting responder campaign started (campaign-service createdAt). Default: long ago, so
 * nothing in the concurrency fixtures predates a responder; the hand-over tests set their own.
 */
const responderCreatedAt = new Map<string, string>();
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: async (id: string) => ({ id, createdAt: responderCreatedAt.get(id) ?? "2020-01-01T00:00:00.000Z" }),
}));

const { db } = await import("../../src/db/index.js");
const { leads, leadContactMethods, leadsCampaigns, followupResponders } = await import("../../src/db/schema.js");
const {
  claimFollowup,
  loadFollowupCandidates,
  OWED_BEFORE_RESPONDER_REASON,
  recordResponder,
  pickFollowupCandidate,
  readFollowupState,
  lookupFollowupRowByEmail,
  stopFollowups,
  writeFollowupStatement,
} = await import("../../src/lib/followup-queue.js");

/**
 * `tests/setup.ts` fills the DSN only when one is absent, so CI's throwaway Postgres wins there and
 * this placeholder is what a laptop with no database sees.
 */
const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("follow-up queue against a real database", () => {
  const campaignId = `itest-followup-${randomUUID()}`;
  const actingCampaignId = `itest-responder-${randomUUID()}`;
  const orgId = randomUUID();
  const brandId = randomUUID();

  async function seedDueRow(dueAt: Date, campaign = campaignId, followupCount = 0): Promise<string> {
    const [lead] = await db
      .insert(leads)
      .values({ name: `itest ${randomUUID()}` })
      .returning({ id: leads.id });
    await db.insert(leadContactMethods).values({
      leadId: lead.id,
      channel: "email",
      value: `${randomUUID()}@example.test`,
      source: "itest",
    });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId: campaign,
        orgId,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date(),
        followupDueAt: dueAt,
        followupCount,
      })
      .returning({ id: leadsCampaigns.id });
    return row.id;
  }

  beforeEach(async () => {
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
  });

  afterAll(async () => {
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
    await db.delete(followupResponders).where(eq(followupResponders.heldCampaignId, campaignId));
  });

  it("claims a due row once — a second claim of the same row is refused", async () => {
    const id = await seedDueRow(new Date(Date.now() - 60_000));
    const now = Date.now();

    const first = await claimFollowup({ id, nowMs: now, runId: randomUUID() });
    const second = await claimFollowup({ id, nowMs: now, runId: randomUUID() });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("eight workers racing for ONE row: exactly one wins", async () => {
    const id = await seedDueRow(new Date(Date.now() - 60_000));
    const now = Date.now();

    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => claimFollowup({ id, nowMs: now, runId: randomUUID() })),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(1);
  });

  it("four concurrent claims over two due people never hand the same person to two workers", async () => {
    const a = await seedDueRow(new Date(Date.now() - 120_000));
    const b = await seedDueRow(new Date(Date.now() - 60_000));

    const claims = await Promise.all(
      Array.from({ length: 4 }, () =>
        pickFollowupCandidate({
          orgId,
          campaignId,
          runId: randomUUID(),
          actingCampaignId,
          context: { orgId },
        }),
      ),
    );

    const claimedIds = claims.map((c) => c.claimed?.id).filter((x): x is string => Boolean(x));

    // Every worker either got somebody nobody else got, or got nobody. Never a duplicate.
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.length).toBeGreaterThan(0);
    expect(claimedIds.length).toBeLessThanOrEqual(2);
    for (const id of claimedIds) expect([a, b]).toContain(id);
  });

  it("serves the oldest due person first — a backlog cannot starve whoever waited longest", async () => {
    const oldest = await seedDueRow(new Date(Date.now() - 10 * 24 * 60 * 60 * 1000));
    await seedDueRow(new Date(Date.now() - 60_000));

    const claim = await pickFollowupCandidate({
      orgId,
      campaignId,
      runId: randomUUID(),
      actingCampaignId,
      context: { orgId },
    });

    expect(claim.claimed?.id).toBe(oldest);
  });

  it("does not hand back a row whose due date is still in the future", async () => {
    await seedDueRow(new Date(Date.now() + 60 * 60 * 1000));

    const claim = await pickFollowupCandidate({
      orgId,
      campaignId,
      runId: randomUUID(),
      actingCampaignId,
      context: { orgId },
    });

    expect(claim).toEqual({ claimed: null, reason: "nothing_due" });
  });

  it("never returns a person with a booked meeting on record", async () => {
    const id = await seedDueRow(new Date(Date.now() - 60_000));
    const [row] = await db
      .select({ leadId: leadsCampaigns.leadId })
      .from(leadsCampaigns)
      .where(eq(leadsCampaigns.id, id));

    const { conversionEvents } = await import("../../src/db/schema.js");
    await db.insert(conversionEvents).values({
      brandId,
      orgId,
      event: "meeting_booked",
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "manual",
      campaignId,
      leadCampaignId: id,
      matchedLeadId: row.leadId,
    });

    const candidates = await loadFollowupCandidates({ orgId, campaignId, nowMs: Date.now(), responderStartedAtIso: "2020-01-01T00:00:00.000Z" });
    expect(candidates).toHaveLength(0);
  });

  it("a withdrawn booking stops stopping them — the read filters withdrawn statements", async () => {
    const id = await seedDueRow(new Date(Date.now() - 60_000));
    const { conversionEvents } = await import("../../src/db/schema.js");
    await db.insert(conversionEvents).values({
      brandId,
      orgId,
      event: "meeting_booked",
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "manual",
      campaignId,
      leadCampaignId: id,
      withdrawnAt: new Date(),
    });

    const candidates = await loadFollowupCandidates({ orgId, campaignId, nowMs: Date.now(), responderStartedAtIso: "2020-01-01T00:00:00.000Z" });
    expect(candidates.map((c) => c.id)).toEqual([id]);
  });

  it("records an action, releases the claim, and re-enters the person at the stated date", async () => {
    const id = await seedDueRow(new Date(Date.now() - 60_000));
    await claimFollowup({ id, nowMs: Date.now(), runId: randomUUID() });

    const nextDue = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const state = await writeFollowupStatement({
      orgId,
      id,
      kind: "acted",
      dueAtIso: nextDue,
      reason: null,
      nowMs: Date.now(),
    });

    expect(state).toMatchObject({ followupCount: 1, claimedAt: null, stoppedReason: null });
    expect(state?.dueAt).toBe(new Date(nextDue).toISOString());
    expect(state?.lastActionAt).not.toBeNull();

    // Still in the future, so nobody is due yet.
    const claim = await pickFollowupCandidate({
      orgId,
      campaignId,
      runId: randomUUID(),
      actingCampaignId,
      context: { orgId },
    });
    expect(claim.claimed).toBeNull();
  });

  it("a stop empties the schedule, and a later schedule re-enters them — they answered again", async () => {
    const id = await seedDueRow(new Date(Date.now() - 60_000));

    const stopped = await writeFollowupStatement({
      orgId,
      id,
      kind: "stopped",
      dueAtIso: null,
      reason: "answered_again",
      nowMs: Date.now(),
    });
    expect(stopped).toMatchObject({ dueAt: null, stoppedReason: "answered_again" });
    expect(
      (await pickFollowupCandidate({ orgId, campaignId, runId: null, actingCampaignId, context: { orgId } })).claimed,
    ).toBeNull();

    const requeued = await writeFollowupStatement({
      orgId,
      id,
      kind: "scheduled",
      dueAtIso: new Date(Date.now() - 1_000).toISOString(),
      reason: null,
      nowMs: Date.now(),
    });
    expect(requeued).toMatchObject({ stoppedReason: null, followupCount: 0 });
    expect(
      (await pickFollowupCandidate({ orgId, campaignId, runId: null, actingCampaignId, context: { orgId } })).claimed
        ?.id,
    ).toBe(id);
  });

  it("a thread handed to a person is never claimed, and a later schedule does not re-enter it", async () => {
    const id = await seedDueRow(new Date(Date.now() - 60_000));

    const handed = await writeFollowupStatement({
      orgId,
      id,
      kind: "handed",
      dueAtIso: null,
      reason: "client asked to answer",
      nowMs: Date.now(),
    });
    expect(handed).toMatchObject({ dueAt: null, handedReason: "client asked to answer" });
    expect(handed?.handedAt).not.toBeNull();

    // The prospect writes again: qualification re-schedules, and the row stays the person's.
    const requeued = await writeFollowupStatement({
      orgId,
      id,
      kind: "scheduled",
      dueAtIso: new Date(Date.now() - 1_000).toISOString(),
      reason: null,
      nowMs: Date.now(),
    });
    expect(requeued).toMatchObject({ dueAt: null, handedAt: handed?.handedAt, stoppedReason: "client asked to answer" });
    expect(
      (await pickFollowupCandidate({ orgId, campaignId, runId: null, actingCampaignId, context: { orgId } })).claimed,
    ).toBeNull();
    // Even a direct claim of the row is refused.
    expect(await claimFollowup({ id, nowMs: Date.now(), runId: null })).toBe(false);
  });

  it("switching a responder on hands over the never-answered backlog instead of answering it", async () => {
    const held = `itest-followup-backlog-${randomUUID()}`;
    const responder = `itest-responder-${randomUUID()}`;
    const startedAt = new Date(Date.now() - 10 * 60_000);
    responderCreatedAt.set(responder, startedAt.toISOString());
    try {
      // Owed five weeks before the responder existed: a human's reply to answer.
      const backlog = await seedDueRow(new Date(Date.now() - 35 * 24 * 3600_000), held);
      // Already answered by a responder (an ongoing AI conversation): stays claimable.
      const ongoing = await seedDueRow(new Date(Date.now() - 20 * 60_000), held, 2);
      // A reply that landed after the responder started: the responder's to answer.
      const fresh = await seedDueRow(new Date(Date.now() - 60_000), held);

      const claimed: string[] = [];
      for (let i = 0; i < 3; i++) {
        const out = await pickFollowupCandidate({
          orgId,
          campaignId: held,
          runId: null,
          actingCampaignId: responder,
          context: { orgId },
        });
        if (out.claimed) claimed.push(out.claimed.id);
      }
      expect(claimed.sort()).toEqual([ongoing, fresh].sort());

      const state = await readFollowupState(orgId, backlog);
      expect(state).toMatchObject({ dueAt: null, handedReason: OWED_BEFORE_RESPONDER_REASON });
      expect(state?.handedAt).not.toBeNull();
    } finally {
      await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, held));
      await db.delete(followupResponders).where(eq(followupResponders.heldCampaignId, held));
    }
  });

  it("the earliest responder start wins: a later sibling never moves the cut forward", async () => {
    const held = `itest-followup-siblings-${randomUUID()}`;
    try {
      const elder = await recordResponder({
        heldCampaignId: held,
        actingCampaignId: "elder",
        actingStartedAtIso: "2026-09-02T00:00:00.000Z",
      });
      const younger = await recordResponder({
        heldCampaignId: held,
        actingCampaignId: "younger",
        actingStartedAtIso: "2026-10-05T00:00:00.000Z",
      });
      const earlier = await recordResponder({
        heldCampaignId: held,
        actingCampaignId: "earliest",
        actingStartedAtIso: "2026-08-01T00:00:00.000Z",
      });
      expect(elder).toBe("2026-09-02T00:00:00.000Z");
      expect(younger).toBe("2026-09-02T00:00:00.000Z");
      expect(earlier).toBe("2026-08-01T00:00:00.000Z");
      const [row] = await db.select().from(followupResponders).where(eq(followupResponders.heldCampaignId, held));
      expect(row.firstResponderCampaignId).toBe("earliest");
    } finally {
      await db.delete(followupResponders).where(eq(followupResponders.heldCampaignId, held));
    }
  });

  it("stopFollowups clears a batch and readFollowupState reads it back", async () => {
    const a = await seedDueRow(new Date(Date.now() - 60_000));
    const b = await seedDueRow(new Date(Date.now() - 60_000));

    await stopFollowups([a, b], "opted_out", Date.now());

    for (const id of [a, b]) {
      const state = await readFollowupState(orgId, id);
      expect(state).toMatchObject({ dueAt: null, stoppedReason: "opted_out" });
    }
    expect(await readFollowupState(randomUUID(), a)).toBeNull();
  });
});

/**
 * The email → row lookup, against a REAL database.
 *
 * This is the identification that decides WHO gets emailed, so it must be exercised rather than
 * shaped: a mocked `sql` compiles no predicate at all, and a lookup that cannot run — or that
 * matches too widely — is the difference between answering the person who replied and answering
 * somebody who never did.
 */
describe.skipIf(!hasRealDatabase)("resolving a follow-up row by email", () => {
  const campaignId = `itest-followup-lookup-${randomUUID()}`;
  const otherCampaignId = `${campaignId}-other`;
  const orgId = randomUUID();
  const brandId = randomUUID();

  async function seedRow(email: string, campaign: string, org = orgId): Promise<string> {
    const [lead] = await db
      .insert(leads)
      .values({ name: `itest ${randomUUID()}` })
      .returning({ id: leads.id });
    await db
      .insert(leadContactMethods)
      .values({ leadId: lead.id, channel: "email", value: email, source: "itest" });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId: campaign,
        orgId: org,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date(),
      })
      .returning({ id: leadsCampaigns.id });
    return row.id;
  }

  afterAll(async () => {
    for (const c of [campaignId, otherCampaignId]) {
      await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, c));
    }
  });

  it("finds the row for an exactly-matching address, case-folded", async () => {
    const email = `Exact.${randomUUID()}@example.test`;
    const id = await seedRow(email, campaignId);

    const found = await lookupFollowupRowByEmail({ orgId, campaignId, email: email.toUpperCase() });

    expect(found).toMatchObject({ ok: true, id });
  });

  it("refuses a SUBSTRING of a real address — identification is exact or it is nothing", async () => {
    const local = `sub${randomUUID().replace(/-/g, "")}`;
    await seedRow(`${local}@example.test`, campaignId);

    const found = await lookupFollowupRowByEmail({ orgId, campaignId, email: local });

    expect(found).toEqual({ ok: false, code: "lead_not_found" });
  });

  it("refuses an address this org's campaign does not hold", async () => {
    const found = await lookupFollowupRowByEmail({
      orgId,
      campaignId,
      email: `ghost.${randomUUID()}@example.test`,
    });
    expect(found).toEqual({ ok: false, code: "lead_not_found" });
  });

  it("does not reach across campaigns, and does not reach across orgs", async () => {
    const email = `scoped.${randomUUID()}@example.test`;
    await seedRow(email, otherCampaignId);

    expect(await lookupFollowupRowByEmail({ orgId, campaignId, email })).toEqual({
      ok: false,
      code: "lead_not_found",
    });
    expect(
      await lookupFollowupRowByEmail({ orgId: randomUUID(), campaignId: otherCampaignId, email }),
    ).toEqual({ ok: false, code: "lead_not_found" });
  });

  it("states ambiguity rather than picking one when two leads case-fold onto one address", async () => {
    const suffix = randomUUID();
    const a = await seedRow(`dup.${suffix}@example.test`, campaignId);
    const b = await seedRow(`DUP.${suffix}@example.test`, campaignId);

    const found = await lookupFollowupRowByEmail({
      orgId,
      campaignId,
      email: `dup.${suffix}@example.test`,
    });

    expect(found.ok).toBe(false);
    if (found.ok || found.code !== "ambiguous_lead") throw new Error("expected ambiguity");
    expect(found.matches.map((m) => m.id).sort()).toEqual([a, b].sort());
  });
});
