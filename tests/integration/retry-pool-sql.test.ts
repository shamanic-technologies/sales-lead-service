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
import { leads, leadsCampaigns } from "../../src/db/schema.js";
import {
  claimCandidate,
  loadRetryCandidates,
  markSenderClosedCandidates,
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
});
