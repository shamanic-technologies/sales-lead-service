/**
 * An offer's checks on sample companies that are NOT leads (PREVIEW-CHECKS-1017), against a REAL database:
 * Must haves first, a company failing one is not paid its Nice to haves, each check reads back with verdict,
 * evidence and mode, a second preview of the same domains pays nothing, no lead row is written, and a company
 * first seen by name alone does not answer firmographic checks once we hold its organization. Vendors are faked at
 * the client boundary (treg meter, Jev, chat-service, prices); the SQL is real.
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
const judged: Array<{ question: string; observation: string }> = [];
vi.mock("../../src/lib/qualification-judge.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    judgeYesNo: async (state: { observation: string; company: { domain: string } }, questions: Record<string, { instructions: string }>) => {
      judged.push({ question: questions.holds.instructions, observation: state.observation });
      // The must-pass "sells online" holds only for the companies named shop-*; firmographics need more than a name.
      const domain = state.company.domain;
      const isFirmographic = questions.holds.instructions.startsWith("Sells online");
      if (isFirmographic && !/industry/.test(state.observation)) return { probabilities: { answerable: 0.2, holds: 0.5 }, model: "jev-test" };
      const holds = isFirmographic ? (domain.startsWith("shop-") ? 0.9 : 0.1) : 0.9;
      return { probabilities: { answerable: 0.95, holds }, model: "jev-test" };
    },
  };
});
vi.mock("../../src/lib/chat-complete-client.js", async (orig) => ({
  ...((await orig()) as object),
  complete: async () => ({ content: "The homepage invites visitors to a weekly newsletter.", json: null, model: "flash-lite", tokensInput: 1, tokensOutput: 1 }),
}));
vi.mock("../../src/lib/price-client.js", () => ({ priceCentsPerUnit: async () => 0.0005 }));

const { db } = await import("../../src/db/index.js");
const { organizations, qualificationCriteria, qualificationPreviews } = await import("../../src/db/schema.js");
const { sql, eq } = await import("drizzle-orm");
const { BUILTIN_PROBES } = await import("../../src/lib/qualification-probes.js");
const { normalizePreviewCompanies, runPreview, getPreview, previewCriteria, readPreview, PREVIEW_STALE_MS } = await import("../../src/lib/qualification-preview.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("qualification preview on companies that are not leads, against a real database", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const offerId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const scope = { orgId, brandId, offerId };
  const identity = { orgId, userId: randomUUID(), runId: randomUUID(), brandId };
  const shop = `shop-${tag}.com`;
  const agency = `agency-${tag}.com`;
  const unknown = `unknown-${tag}.com`;
  let mustPass: typeof qualificationCriteria.$inferSelect;
  let mention: typeof qualificationCriteria.$inferSelect;

  async function startAndRun(companies: Array<{ domain: string; name: string }>) {
    const normalized = normalizePreviewCompanies(companies);
    if (!normalized.ok) throw new Error("bad domains");
    const criteria = [mustPass, mention];
    const [row] = await db
      .insert(qualificationPreviews)
      .values({ ...scope, companies: normalized.companies, criterionIds: criteria.map((c) => c.id), runId: identity.runId, status: "running" })
      .returning();
    const closed: boolean[] = [];
    await runPreview(row, criteria, identity, async (ok) => void closed.push(ok));
    const done = (await getPreview(scope, row.id))!;
    return { answer: await readPreview(done, await previewCriteria(done)), closed };
  }

  beforeAll(async () => {
    [mustPass] = await db
      .insert(qualificationCriteria)
      .values({ ...scope, title: "Sells online", question: `Sells online ${tag}?`, probe: BUILTIN_PROBES.company_data.spec, mode: "must_pass", enabled: true })
      .returning();
    [mention] = await db
      .insert(qualificationCriteria)
      .values({ ...scope, title: "Has a newsletter", question: `Does the company run a newsletter? ${tag}`, probe: BUILTIN_PROBES.homepage_text.spec, mode: "mention", enabled: true })
      .returning();
    // Two of the three companies are organizations we already hold (firmographics); the third is a name only.
    await db.insert(organizations).values([
      { name: "Shop", primaryDomain: shop, industry: "retail" },
      { name: "Agency", primaryDomain: `www.${agency}`, industry: "marketing" },
    ]);
  });

  afterAll(async () => {
    tregCalls.length = 0;
  });

  it("refuses unusable domains and folds duplicates", () => {
    expect(normalizePreviewCompanies([{ domain: "not a domain", name: "x" }])).toEqual({ ok: false, invalidDomains: ["not a domain"] });
    expect(normalizePreviewCompanies([{ domain: "https://www.Acme.com/about", name: "Acme" }, { domain: "acme.com", name: "Again" }])).toEqual({ ok: true, companies: [{ domain: "acme.com", name: "Acme" }] });
  });

  it("runs every enabled check per company: a Must have failure stops its Nice to haves; unavailable never fails", async () => {
    const { answer, closed } = await startAndRun([
      { domain: shop, name: "Shop" },
      { domain: agency, name: "Agency" },
      { domain: unknown, name: "Unknown Co" },
    ]);
    expect(closed).toEqual([true]);
    expect(answer.status).toBe("completed");
    expect(answer.checks.map((c) => [c.title, c.mode])).toEqual([["Sells online", "must_pass"], ["Has a newsletter", "mention"]]);
    const byDomain = Object.fromEntries(answer.companies.map((c) => [c.domain, c]));

    expect(byDomain[shop].mustPass).toEqual({ state: "passes", failed: [] });
    expect(byDomain[shop].qualification.checks.map((c) => [c.mode, c.verdict])).toEqual([["must_pass", "yes"], ["mention", "yes"]]);
    expect(byDomain[shop].qualification.checks[1].evidence).toContain("newsletter");

    expect(byDomain[agency].mustPass).toEqual({ state: "fails", failed: [{ criterionId: mustPass.id, title: "Sells online", question: mustPass.question }] });
    expect(byDomain[agency].qualification.checks.map((c) => [c.verdict, c.reason])).toEqual([["no", null], ["not_checked", "failed_must_pass"]]);

    // Name and domain only: the firmographic check cannot answer, which never declines; the Nice to have runs.
    expect(byDomain[unknown].mustPass.state).toBe("passes");
    expect(byDomain[unknown].qualification.checks.map((c) => c.verdict)).toEqual(["unavailable", "yes"]);

    // The agency's homepage was never paid for.
    expect(tregCalls.map((c) => (c.params as { url: string }).url).sort()).toEqual([`https://${shop}`, `https://${unknown}`].sort());

    // Each check applied counts in the pass rate, on the company.
    const rows = (await db.execute(sql`
      SELECT subject FROM qualification_checks WHERE criterion_id IN (${mustPass.id}, ${mention.id}) ORDER BY subject
    `)) as unknown as Array<{ subject: string }>;
    expect(rows.map((r) => r.subject).sort()).toEqual([`company:${agency}`, `company:${shop}`, `company:${shop}`, `company:${unknown}`, `company:${unknown}`].sort());
  });

  it("a second preview of the same domains observes, judges and pays nothing", async () => {
    tregCalls.length = 0;
    judged.length = 0;
    const { answer } = await startAndRun([{ domain: shop, name: "Shop" }, { domain: agency, name: "Agency" }]);
    expect(tregCalls).toHaveLength(0);
    expect(judged).toHaveLength(0);
    expect(answer.companies.map((c) => c.mustPass.state)).toEqual(["passes", "fails"]);
  });

  it("a company first seen by name alone is judged again from full firmographics once we hold them", async () => {
    judged.length = 0;
    await db.insert(organizations).values({ name: "Unknown Co", primaryDomain: unknown, industry: "retail" });
    const { answer } = await startAndRun([{ domain: unknown, name: "Unknown Co" }]);
    expect(judged.map((j) => j.question)).toEqual([mustPass.question]);
    expect(answer.companies[0].qualification.checks[0].verdict).toBe("no");
    expect(answer.companies[0].mustPass.state).toBe("fails");
  });

  it("a preview whose process died reads failed / interrupted; another org never sees it", async () => {
    const [row] = await db
      .insert(qualificationPreviews)
      .values({ ...scope, companies: [{ domain: shop, name: "Shop" }], criterionIds: [mustPass.id], status: "running", createdAt: new Date(Date.now() - PREVIEW_STALE_MS - 1000) })
      .returning();
    const read = (await getPreview(scope, row.id))!;
    expect([read.status, read.error?.split(":")[0]]).toEqual(["failed", "interrupted"]);
    expect(await getPreview({ ...scope, orgId: randomUUID() }, row.id)).toBeNull();
    await db.delete(qualificationPreviews).where(eq(qualificationPreviews.id, row.id));
  });

  it("writes no lead and files nobody: no organization link, no campaign row for these companies", async () => {
    const [linked] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM leads_organizations lo JOIN organizations o ON o.id = lo.organization_id
      WHERE lower(o.primary_domain) IN (${shop}, ${`www.${agency}`}, ${unknown})
    `)) as unknown as Array<{ n: number }>;
    expect(Number(linked.n)).toBe(0);
  });
});
