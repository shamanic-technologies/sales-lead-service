/**
 * Executes the retry pool's own writes against a REAL database.
 *
 * The pool shipped with `WHERE id::text = ANY(${ids}::text[])` in `markSentCandidates`.
 * Every unit test around it passed, because they all mock the database: nothing ever ran
 * the statement before production did. The driver renders a bare JS array parameter as a
 * ROW, so the hand-written cast failed at runtime with `cannot cast type record to
 * text[]`, and a live campaign's serve failed on every pull that found an already-sent
 * candidate.
 *
 * So this file runs the statements rather than asserting their shape. A mocked database
 * cannot fail the way the real one did, which is exactly why the class survived review.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { leadContactMethods, leads, leadsCampaigns } from "../../src/db/schema.js";
import {
  claimCandidate,
  loadRetryCandidates,
  markSenderClosedCandidates,
  markSendRefusedCandidates,
  markChannelSentCandidates,
  markSentCandidates,
} from "../../src/lib/retry-pool.js";

/**
 * `tests/setup.ts` fills the DSN only when one is absent, so CI's throwaway Postgres wins
 * there and this placeholder is what a laptop with no database sees. Skipping on it keeps
 * the local suite runnable; CI always executes these.
 */
const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("retry-pool statements against a real database", () => {
  const campaignId = `itest-${randomUUID()}`;
  const orgId = randomUUID();
  const brandId = randomUUID();
  const seeded: string[] = [];

  async function seedServedRow(): Promise<string> {
    const [lead] = await db
      .insert(leads)
      .values({ name: `itest ${randomUUID()}` })
      .returning({ id: leads.id });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({
        leadId: lead.id,
        campaignId,
        orgId,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date(),
      })
      .returning({ id: leadsCampaigns.id });
    return row.id;
  }

  beforeAll(async () => {
    for (let i = 0; i < 3; i++) seeded.push(await seedServedRow());
  });

  afterAll(async () => {
    await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, campaignId));
  });

  it("hands a retried serve the buying signal stored on the original serve", async () => {
    // A separate campaign so the shared rows above keep their exact state.
    const signalCampaignId = `itest-signal-${randomUUID()}`;
    const signal = {
      type: "hiring",
      occurredOn: "2026-09-21",
      fact: "Acme Clinics posted a job for Office Manager on September 21, 2026",
      source: "apollo:job_postings",
      sourceUrl: null,
    } as const;
    const [lead] = await db
      .insert(leads)
      .values({ name: `itest ${randomUUID()}` })
      .returning({ id: leads.id });
    await db.insert(leadContactMethods).values({
      leadId: lead.id,
      channel: "email",
      value: `signal-${randomUUID()}@itest.example`,
      source: "apollo",
    });
    await db.insert(leadsCampaigns).values([
      {
        leadId: lead.id,
        campaignId: signalCampaignId,
        orgId,
        brandIds: [brandId],
        status: "served",
        servedAt: new Date(Date.now() - 60_000),
        buyingSignal: signal,
        personId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      },
    ]);
    try {
      const candidates = await loadRetryCandidates({ orgId, campaignId: signalCampaignId, nowMs: Date.now() });
      expect(candidates).toHaveLength(1);
      expect(candidates[0].buyingSignal).toEqual(signal);
      expect(candidates[0].personId).toBe("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f");
    } finally {
      await db.delete(leadsCampaigns).where(eq(leadsCampaigns.campaignId, signalCampaignId));
      await db.delete(leadContactMethods).where(eq(leadContactMethods.leadId, lead.id));
    }
  });

  it("marks several candidates sent in one statement", async () => {
    await markSentCandidates(seeded, Date.now());

    const stillUnsent = await db
      .select({ id: leadsCampaigns.id })
      .from(leadsCampaigns)
      .where(and(eq(leadsCampaigns.campaignId, campaignId), isNull(leadsCampaigns.sentAt)));

    expect(stillUnsent).toHaveLength(0);
  });

  it("marks a single candidate sent — one element is the same statement", async () => {
    const id = await seedServedRow();

    await markSentCandidates([id], Date.now());

    const [after] = await db
      .select({ sentAt: leadsCampaigns.sentAt })
      .from(leadsCampaigns)
      .where(eq(leadsCampaigns.id, id));

    expect(after.sentAt).not.toBeNull();
  });

  it("writes nothing when the list is empty", async () => {
    await expect(markSentCandidates([], Date.now())).resolves.toBeUndefined();
  });

  it("claims a candidate once — a second claim of the same row is refused", async () => {
    const id = await seedServedRow();
    const now = Date.now();

    const first = await claimCandidate({ id, nowMs: now, runId: randomUUID(), parentRunId: null });
    const second = await claimCandidate({ id, nowMs: now, runId: randomUUID(), parentRunId: null });

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("closes a candidate the sender is finished with: out of the pool, never claimable, not sent", async () => {
    const id = await seedServedRow();

    await markSenderClosedCandidates([id], Date.now());

    const [after] = await db
      .select({ senderClosedAt: leadsCampaigns.senderClosedAt, sentAt: leadsCampaigns.sentAt })
      .from(leadsCampaigns)
      .where(eq(leadsCampaigns.id, id));
    expect(after.senderClosedAt).not.toBeNull();
    expect(after.sentAt).toBeNull();

    const candidates = await loadRetryCandidates({ orgId, campaignId, nowMs: Date.now() });
    expect(candidates.map((c) => c.id)).not.toContain(id);

    const claimed = await claimCandidate({ id, nowMs: Date.now(), runId: randomUUID(), parentRunId: null });
    expect(claimed).toBe(false);
  });
  it("sets aside a person the sender refuses for a window: out until it lapses, then back", async () => {
    const id = await seedServedRow();
    const now = Date.now();
    const until = new Date(now + 24 * 60 * 60 * 1000).toISOString();

    await markSendRefusedCandidates([{ id, refusal: { code: "recent_brand_contact", until } }], now);

    const [after] = await db
      .select({
        at: leadsCampaigns.sendRefusedAt,
        code: leadsCampaigns.sendRefusalCode,
        until: leadsCampaigns.sendRefusedUntil,
        sentAt: leadsCampaigns.sentAt,
        closedAt: leadsCampaigns.senderClosedAt,
      })
      .from(leadsCampaigns)
      .where(eq(leadsCampaigns.id, id));
    expect(after.at).not.toBeNull();
    expect(after.code).toBe("recent_brand_contact");
    expect(after.until?.toISOString()).toBe(until);
    expect(after.sentAt).toBeNull();
    expect(after.closedAt).toBeNull();

    const inside = await loadRetryCandidates({ orgId, campaignId, nowMs: now });
    expect(inside.map((c) => c.id)).not.toContain(id);
    expect(await claimCandidate({ id, nowMs: now, runId: randomUUID(), parentRunId: null })).toBe(false);

    const lapsed = Date.parse(until) + 1;
    expect(await claimCandidate({ id, nowMs: lapsed, runId: randomUUID(), parentRunId: null })).toBe(true);
  });

  it("never hands back a person the sender refuses for good (opt-out: no end)", async () => {
    const id = await seedServedRow();
    const now = Date.now();

    await markSendRefusedCandidates([{ id, refusal: { code: "lead_opted_out", until: null } }], now);

    const tenYears = now + 10 * 365 * 24 * 60 * 60 * 1000;
    for (const nowMs of [now, tenYears]) {
      const candidates = await loadRetryCandidates({ orgId, campaignId, nowMs });
      expect(candidates.map((c) => c.id)).not.toContain(id);
      expect(await claimCandidate({ id, nowMs, runId: randomUUID(), parentRunId: null })).toBe(false);
    }
  });

  // WA-RESERVE-LOOP-1014: a person the campaign's non-email sender (crm-service) states it wrote to leaves the pool for
  // good, in its own column (never sent_at: the lead history reads that as the email hand-off).
  it("takes a person the channel sender wrote to out of the pool for good, never claimable, not sent_at", async () => {
    const [lead] = await db.insert(leads).values({ name: `itest ${randomUUID()}` }).returning({ id: leads.id });
    await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: `wa-${randomUUID()}@example.com`, source: "itest" });
    const [row] = await db
      .insert(leadsCampaigns)
      .values({ leadId: lead.id, campaignId, orgId, brandIds: [brandId], status: "served", servedAt: new Date() })
      .returning({ id: leadsCampaigns.id });
    const now = Date.now();
    // A candidate before: it has an email and nothing marks it.
    expect((await loadRetryCandidates({ orgId, campaignId, nowMs: now })).map((c) => c.id)).toContain(row.id);

    await markChannelSentCandidates([{ id: row.id, sentAt: "2026-10-12T14:43:32.913Z", sendId: "send-abc" }], now);
    // Written once: a second statement never moves the first.
    await markChannelSentCandidates([{ id: row.id, sentAt: "2026-10-13T00:00:00.000Z", sendId: "send-later" }], now);

    const [after] = await db
      .select({ at: leadsCampaigns.channelSentAt, sendId: leadsCampaigns.channelSendId, sentAt: leadsCampaigns.sentAt })
      .from(leadsCampaigns)
      .where(eq(leadsCampaigns.id, row.id));
    expect(after.at?.toISOString()).toBe("2026-10-12T14:43:32.913Z");
    expect(after.sendId).toBe("send-abc");
    expect(after.sentAt).toBeNull();

    const tomorrow = now + 2 * 60 * 60 * 1000;
    expect((await loadRetryCandidates({ orgId, campaignId, nowMs: tomorrow })).map((c) => c.id)).not.toContain(row.id);
    expect(await claimCandidate({ id: row.id, nowMs: tomorrow, runId: randomUUID(), parentRunId: null })).toBe(false);
  });
});
