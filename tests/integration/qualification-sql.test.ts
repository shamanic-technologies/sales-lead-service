/**
 * Qualification checks against a REAL database: a company is observed and judged ONCE per
 * question, whatever the number of its leads; a second run reuses everything and pays nothing;
 * the lead read serves the stored answer. Vendors are faked at the client boundary (treg meter,
 * chat-service, cloudflare, prices); the SQL is real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

const tregCalls: Array<{ endpointId: string; params: unknown }> = [];
vi.mock("../../src/lib/treg-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  class FakeMeter {
    async call(req: { endpointId: string; params: unknown }) {
      tregCalls.push(req);
      return { status: 200, body: { markdown: "Welcome. Subscribe to our weekly newsletter." }, chargedMicro: 1000, contentType: "application/json" };
    }
  }
  return { ...actual, TregMeter: FakeMeter };
});
const judgeCalls: unknown[] = [];
vi.mock("../../src/lib/qualification-judge.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    judgeYesNo: async (state: unknown, questions: Record<string, { instructions: string }>) => {
      if ("q0" in questions) {
        // The same-condition test between a draft and a kept criterion.
        const probabilities: Record<string, number> = {};
        for (const [k, q] of Object.entries(questions)) probabilities[k] = /A: "[^"]*LinkedIn/.test(q.instructions) ? 0.92 : 0.05;
        return { probabilities, model: "jev-1.13.0" };
      }
      judgeCalls.push(state);
      return { probabilities: { answerable: 0.95, holds: 0.9 }, model: "jev-1.13.0" };
    },
  };
});
vi.mock("../../src/lib/chat-complete-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    complete: async () => {
      if (invalidJsonAnswers > 0) {
        invalidJsonAnswers--;
        throw new (actual.ModelInvalidJsonError as new (d: string) => Error)("Expected ',' or ']'");
      }
      return { content: "The homepage invites visitors to a weekly newsletter.", json: draftJson, model: "flash-lite", tokensInput: 1, tokensOutput: 1 };
    },
  };
});
let draftJson: Record<string, unknown> | null = null;
let invalidJsonAnswers = 0;
vi.mock("../../src/lib/brand-client.js", async (orig) => ({
  ...((await orig()) as object),
  getOfferText: async (_o: string, _b: string, offerId: string) => ({ offerId, name: "Site speed audit", description: "We make slow sites fast.", fields: {} }),
}));
vi.mock("../../src/lib/price-client.js", () => ({ priceCentsPerUnit: async () => 0.0005 }));

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns, organizations, leadsOrganizations, qualificationCriteria } = await import("../../src/db/schema.js");
const { mustPassCriteria, passRates, OfferUnresolvedError } = await import("../../src/lib/qualification.js");
const { sql } = await import("drizzle-orm");
const { runCriterionOnLeads, readLeadQualification, recentServedLeadIds, leadsOfBrand, generateSuggestions } = await import("../../src/lib/qualification-run.js");
const { listCriteria } = await import("../../src/lib/qualification.js");
const { buildFullLeadsBatch } = await import("../../src/lib/lead-shape.js");
const { BUILTIN_PROBES } = await import("../../src/lib/qualification-probes.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("qualification checks, against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const sharedDomain = `shared-${tag}.com`;
  const otherDomain = `other-${tag}.com`;
  const ids: string[] = [];
  const identity = { orgId, userId: randomUUID(), runId: randomUUID(), brandId };
  const offerA = randomUUID();
  const offerB = randomUUID();
  let criterion: Awaited<ReturnType<typeof insertCriterion>>;

  async function insertCriterion(values: Partial<typeof qualificationCriteria.$inferInsert>) {
    const [row] = await db
      .insert(qualificationCriteria)
      .values({ orgId, brandId, offerId: offerA, question: `Does the company run a newsletter? ${tag}`, probe: BUILTIN_PROBES.homepage_text.spec, mode: "mention", enabled: true, ...values })
      .returning();
    return row;
  }

  async function seedLead(domain: string, servedAt: Date): Promise<string> {
    const [lead] = await db.insert(leads).values({ firstName: `L-${tag}` }).returning({ id: leads.id });
    const [org] = await db.insert(organizations).values({ name: domain, primaryDomain: domain }).returning({ id: organizations.id });
    await db.insert(leadsOrganizations).values({ leadId: lead.id, organizationId: org.id, current: true });
    await db.insert(leadsCampaigns).values({ leadId: lead.id, campaignId: `camp-${tag}`, orgId, brandIds: [brandId], status: "served", servedAt });
    return lead.id;
  }

  beforeAll(async () => {
    criterion = await insertCriterion({});
    ids.push(await seedLead(sharedDomain, new Date(Date.now() - 3000)));
    ids.push(await seedLead(sharedDomain, new Date(Date.now() - 2000)));
    ids.push(await seedLead(otherDomain, new Date(Date.now() - 1000)));
  });

  afterAll(async () => {
    tregCalls.length = 0;
  });

  it("picks the brand's latest served leads and recognises its own leads only", async () => {
    expect(await recentServedLeadIds(orgId, brandId, 3)).toEqual([ids[2], ids[1], ids[0]]);
    const owned = await leadsOfBrand(orgId, brandId, [ids[0], randomUUID()]);
    expect([...owned]).toEqual([ids[0]]);
  });

  it("checks each company once: the second lead at the same company is reused and free", async () => {
    const rows = await runCriterionOnLeads(criterion, ids, identity);
    expect(tregCalls.map((c) => (c.params as { url: string }).url).sort()).toEqual([`https://${otherDomain}`, `https://${sharedDomain}`].sort());
    expect(judgeCalls).toHaveLength(2);
    expect(rows.map((r) => [r.domain, r.verdict, r.reused])).toEqual([
      [sharedDomain, "yes", false],
      [sharedDomain, "yes", true],
      [otherDomain, "yes", false],
    ]);
    expect(rows[0].probeCostUsd).toBeGreaterThan(0);
    expect(rows[1].probeCostUsd).toBe(0);
    expect(rows[0].evidence).toBe("The homepage invites visitors to a weekly newsletter.");
  });

  it("a second run on the same companies observes, judges and pays nothing", async () => {
    tregCalls.length = 0;
    judgeCalls.length = 0;
    const rows = await runCriterionOnLeads(criterion, ids, identity);
    expect(tregCalls).toHaveLength(0);
    expect(judgeCalls).toHaveLength(0);
    expect(rows.every((r) => r.reused && r.probeCostUsd === 0)).toBe(true);
  });

  it("the lead read serves the stored answer, and not_checked for a question nobody asked", async () => {
    const lead = (await buildFullLeadsBatch([ids[1]])).get(ids[1])!;
    const other = { ...criterion, id: randomUUID(), question: `Never asked ${tag}` };
    const read = await readLeadQualification(lead, [criterion, other]);
    expect(read.domain).toBe(sharedDomain);
    expect(read.checks.map((c) => c.verdict)).toEqual(["yes", "not_checked"]);
    expect(read.checks[0].evidence).toContain("newsletter");
  });

  it("pass rate per criterion equals a direct count of the stored verdicts (one row per lead checked)", async () => {
    const rate = (await passRates([criterion.id])).get(criterion.id)!;
    const [direct] = (await db.execute(sql`
      SELECT count(*)::int AS checked, count(*) FILTER (WHERE v.verdict = 'yes')::int AS yes
      FROM qualification_checks c JOIN qualification_verdicts v ON v.id = c.verdict_id
      WHERE c.criterion_id = ${criterion.id}
    `)) as unknown as Array<{ checked: number; yes: number }>;
    expect(rate).toEqual({ checked: 3, yes: 3, no: 0, unavailable: 0, passRate: 1 });
    expect([rate.checked, rate.yes]).toEqual([Number(direct.checked), Number(direct.yes)]);
  });

  it("a must-pass check on offer A never applies to offer B of the same brand; off checks never apply", async () => {
    const onA = await insertCriterion({ mode: "must_pass", question: `Must A ${tag}` });
    await insertCriterion({ mode: "must_pass", enabled: false, question: `Off A ${tag}` });
    expect((await mustPassCriteria(orgId, brandId, offerA)).map((c) => c.id)).toEqual([onA.id]);
    expect(await mustPassCriteria(orgId, brandId, offerB)).toEqual([]);
    // The campaign's offer unknown while the brand holds must-pass checks: refuse, never serve unchecked.
    await expect(mustPassCriteria(orgId, brandId, null)).rejects.toBeInstanceOf(OfferUnresolvedError);
    expect(await mustPassCriteria(orgId, randomUUID(), null)).toEqual([]);
  });

  it("suggestions are written OFF on the offer; firmographics dropped; a rerun replaces only untouched ones", async () => {
    const offer = randomUUID();
    const scope = { orgId, brandId, offerId: offer };
    draftJson = {
      checks: [
        { question: `Is the homepage slow on mobile? ${tag}`, why: "Slow sites lose buyers.", kind: "need", source: "homepage_text" },
        { question: `Is the company in retail? ${tag}`, why: "x", kind: "firmographic", universal: false, source: "company_data" },
      ],
    };
    const { rows: first, dropped } = await generateSuggestions({ ...scope, identity });
    expect(dropped.map((d) => d.reason)).toEqual(["firmographic_not_universal"]);
    expect(first.map((r) => [r.offerId, r.enabled, r.origin, r.why])).toEqual([[offer, false, "suggested", "Slow sites lose buyers."]]);

    // A person turns one on: it survives the next run; the same question is not suggested twice.
    await db.update(qualificationCriteria).set({ enabled: true, updatedAt: new Date() }).where(sql`id = ${first[0].id}`);
    draftJson = {
      checks: [
        { question: `Is the homepage slow on mobile? ${tag}`, why: "dup", kind: "need", source: "homepage_text" },
        { question: `Does the homepage lack a newsletter form? ${tag}`, why: "No list to sell to.", kind: "need", source: "homepage_text" },
      ],
    };
    await generateSuggestions({ ...scope, identity });
    // The bare list the model also answers with.
    draftJson = [{ question: `Is the site missing a blog? ${tag}`, why: "No content.", kind: "need", source: "homepage_text" }] as unknown as Record<string, unknown>;
    await generateSuggestions({ ...scope, identity });
    const live = await listCriteria(scope);
    expect(live.map((r) => [r.question.replace(` ${tag}`, ""), r.enabled])).toEqual([
      ["Is the homepage slow on mobile?", true],
      ["Is the site missing a blog?", false],
    ]);
    draftJson = null;
  });

  it("invalid JSON from the model is asked once more; twice in a row is named suggestion_draft_unreadable", async () => {
    const { SuggestionDraftUnreadableError } = await import("../../src/lib/qualification-run.js");
    const scope = { orgId, brandId, offerId: randomUUID() };
    draftJson = { checks: [{ question: `Is the homepage slow? ${tag}`, why: "w", kind: "need", source: "homepage_text" }] };
    invalidJsonAnswers = 1;
    expect((await generateSuggestions({ ...scope, identity })).rows).toHaveLength(1);
    invalidJsonAnswers = 2;
    await expect(generateSuggestions({ ...scope, identity })).rejects.toBeInstanceOf(SuggestionDraftUnreadableError);
    invalidJsonAnswers = 0;
    draftJson = null;
  });

  it("a re-run never suggests what a kept criterion already asks, even reworded; a different check on the same source is kept", async () => {
    const scope = { orgId, brandId, offerId: randomUUID() };
    const linkedin = BUILTIN_PROBES.linkedin_company_posts.spec;
    await insertCriterion({ offerId: scope.offerId, question: `Has the company posted on LinkedIn less than twice in the last month? ${tag}`, probe: linkedin, enabled: false, origin: "suggested", updatedAt: new Date() });
    draftJson = {
      checks: [
        { question: `Has the company posted on its LinkedIn page less than twice in the last thirty days? ${tag}`, why: "w", kind: "need", source: "linkedin_company_posts" },
        { question: `Do the company's posts get fewer than ten reactions? ${tag}`, why: "w", kind: "need", source: "linkedin_company_posts" },
      ],
    };
    const { rows, dropped } = await generateSuggestions({ ...scope, identity });
    expect(rows.map((r) => r.question.replace(` ${tag}`, ""))).toEqual(["Do the company's posts get fewer than ten reactions?"]);
    expect(dropped).toEqual([{ question: `Has the company posted on its LinkedIn page less than twice in the last thirty days? ${tag}`, reason: "already_asked" }]);
    draftJson = null;
  });
});
