/**
 * COST-BACKFILL-1023-LEAD against a REAL database: which past serve run FOUND which lead, from our own rows only
 * (src/lib/run-outcome-backfill.ts). runs-service is faked (the batch door and the child-run lookup).
 *
 *   - a find row never re-pointed -> lead_found on its run (+ email_checked consumed when a verdict is recorded);
 *   - its archived copy (requeued_serves) -> same;
 *   - a re-pointed find -> credited to the caller run's lead-serve child whose window holds served_at, never to the
 *     re-hand run now on the row;
 *   - a stock hand-over, a follow-up population, a journalist, a find before 2026-02-02 -> nothing;
 *   - a find from the client's CRM -> also consumes crm-service's `lead_identified` on the crm relation carrying its
 *     email (LEAD-IDENTIFIED-CONSUME-1024); a personal or withdrawn relation, or a non-CRM find, consumes nothing new;
 *   - a re-run declares the same bytes (runs-service answers already_recorded).
 * Every read is scoped to this file's org: the suite's files share one database.
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, leadsCampaigns, leadContactMethods } = await import("../../src/db/schema.js");
const { runOutcomeBackfill } = await import("../../src/lib/run-outcome-backfill.js");
const { crmIdentifiedRelationKeys } = await import("../../src/lib/crm-lead-identified.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("run outcome backfill against a real database", () => {
  const orgId = `itest-rob-${randomUUID()}`;
  const brandId = randomUUID();
  const createdLeads: string[] = [];

  async function newLead(email?: string, verdict?: string, source = "apollo", companyId?: string): Promise<string> {
    const [lead] = await db.insert(leads).values({ firstName: "Itest", lastName: "Backfill", ...(companyId ? { companyId } : {}) }).returning({ id: leads.id });
    createdLeads.push(lead.id);
    if (email) await db.insert(leadContactMethods).values({ leadId: lead.id, channel: "email", value: email, source, verificationVerdict: verdict ?? null });
    return lead.id;
  }

  /** A crm relation fact as crm-service's feed copies it (crm_registry_facts). Returns its fact id. */
  async function relation(
    email: string,
    relationKey: string,
    over: { capacity?: string; tags?: string[]; companyId?: string; basis?: "conversation" | "source" } = {},
  ): Promise<string> {
    const factId = `itest-${randomUUID()}`;
    // crm-service's tag basis: a judged conversation (what it PRODUCES lead_identified on) or a source (the brand's tools).
    const basis = over.basis === "source" ? [{ kind: "source", ref: "instantly" }] : [{ kind: "conversation", ref: `matrix:${randomUUID()}` }];
    const payload = { relationKey, capacity: over.capacity ?? "professional", tags: (over.tags ?? ["professional_to_brand"]).map((tag) => ({ tag, basis })), companyId: over.companyId ?? null };
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, raw)
      VALUES (${factId}, ${String(Math.floor(Math.random() * 1e15) + 9e15)}::bigint, ${orgId}, ${brandId}, ${`person:${randomUUID()}`},
              ARRAY[${email}]::text[], ARRAY[]::text[], 'relation', 'observed', 'crm', ${factId}, ${JSON.stringify(payload)}::jsonb, '{}'::jsonb)
    `);
    return factId;
  }

  async function row(leadId: string, over: Partial<typeof leadsCampaigns.$inferInsert>): Promise<string> {
    const [r] = await db
      .insert(leadsCampaigns)
      .values({ leadId, campaignId: randomUUID(), orgId, brandIds: [brandId], status: "served", statusReason: "served", servedAt: new Date("2026-09-01T10:00:05Z"), ...over })
      .returning({ id: leadsCampaigns.id });
    return r.id;
  }

  afterAll(async () => {
    await db.execute(sql`DELETE FROM idempotency_cache WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM crm_registry_facts WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM requeued_serves WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM brand_journalists WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    if (createdLeads.length > 0) await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
  });

  it("declares exactly the finds our rows prove, on the run that found them", async () => {
    const findRun = randomUUID();
    const checkedRun = randomUUID();
    const archivedRun = randomUUID();
    const originalRun = randomUUID();
    const retryRun = randomUUID();
    const callerOriginal = randomUUID();
    const callerRetry = randomUUID();

    const plain = await newLead("plain@itest.example");
    await row(plain, { runId: findRun, statusDetails: `Served via audience ${randomUUID()}, email=plain@itest.example` });

    // From the client's CRM, identified by crm-service's registry: consumes its lead_identified.
    const crmRun = randomUUID();
    const crmRel = `rel:${randomUUID()}:pro`;
    const crmLead = await newLead("crm@itest.example", undefined, "crm");
    await row(crmLead, { runId: crmRun, statusDetails: "Served via audience c, email=crm@itest.example" });
    await relation("crm@itest.example", crmRel);
    // From the CRM, but crm-service's only relation for them is personal: nothing new consumed.
    const crmPersonalRun = randomUUID();
    const crmPersonal = await newLead("crm-personal@itest.example", undefined, "crm");
    await row(crmPersonal, { runId: crmPersonalRun, statusDetails: "Served via audience c, email=crm-personal@itest.example" });
    await relation("crm-personal@itest.example", `rel:${randomUUID()}:personal`, { capacity: "personal", tags: ["personal_friend"] });

    const checked = await newLead("checked@itest.example", "valid");
    await row(checked, { runId: checkedRun, statusReason: "source_found", statusDetails: "Lead served, email=checked@itest.example, leadId=x" });

    // Archived by the requeue: only the snapshot remains.
    const archived = await newLead("archived@itest.example");
    await db.execute(sql`
      INSERT INTO requeued_serves (lead_campaign_id, lead_id, campaign_id, org_id, brand_ids, email, reason, row_snapshot)
      VALUES (${randomUUID()}::uuid, ${archived}::uuid, ${randomUUID()}, ${orgId}, ARRAY[${brandId}]::text[], 'archived@itest.example', 'itest',
              ${JSON.stringify({ run_id: archivedRun, status_reason: "served", status_details: "Served via audience a, email=archived@itest.example", served_at: "2026-08-01T09:00:00+00:00", retry_claimed_at: null })}::jsonb)
    `);

    // Found by originalRun, then re-handed to retryRun (the row now names retryRun).
    const repointed = await newLead("repointed@itest.example");
    await row(repointed, { runId: retryRun, retryClaimedAt: new Date("2026-09-03T10:00:00Z"), statusDetails: "Served via audience b, email=repointed@itest.example" });
    for (const caller of [callerOriginal, callerRetry]) {
      await db.execute(sql`
        INSERT INTO idempotency_cache (idempotency_key, org_id, response)
        VALUES (${caller}, ${orgId}, ${JSON.stringify({ found: true, lead: { data: { leadId: repointed } } })}::jsonb)
      `);
    }

    // Not finds.
    const handed = await newLead("handed@itest.example");
    await row(handed, { runId: randomUUID(), statusDetails: "Served from the stock of source campaign c (row r), email=handed@itest.example" });
    const population = await newLead("population@itest.example");
    await row(population, { runId: randomUUID(), statusReason: "source_found", statusDetails: "Found among the brand's contacted people" });
    const journalist = await newLead("journalist@itest.example");
    await row(journalist, { runId: randomUUID(), statusDetails: "Served via audience j, email=journalist@itest.example" });
    await db.execute(sql`INSERT INTO brand_journalists (org_id, brand_id, lead_id, press_only, journalist) VALUES (${orgId}, ${brandId}, ${journalist}::uuid, true, true)`);
    const old = await newLead("old@itest.example");
    await row(old, { runId: randomUUID(), servedAt: new Date("2026-01-15T00:00:00Z"), statusDetails: "Served via audience o, email=old@itest.example" });

    const lookup = async (_org: string, caller: string) =>
      caller === callerOriginal
        ? [{ id: originalRun, startedAt: "2026-09-01T10:00:00Z", completedAt: "2026-09-01T10:00:10Z", updatedAt: "2026-09-01T10:00:10Z" }]
        : [{ id: retryRun, startedAt: "2026-09-03T09:59:59Z", completedAt: "2026-09-03T10:00:02Z", updatedAt: "2026-09-03T10:00:02Z" }];
    const bodies: unknown[] = [];
    const post = async (body: unknown) => {
      bodies.push(body);
      return { status: 201, json: { recordedCount: 4, alreadyRecordedCount: 0, redatedCount: 0 }, text: "" };
    };

    const report = await runOutcomeBackfill({ dryRun: false }, { post, lookup, scope: { orgId } });
    expect(report.finds).toEqual({ direct: 4, archived: 1, repointed: 1 });
    expect(report.repointedUnconfirmed).toBe(1);

    const sent = (bodies as Array<{ runs: Array<{ runId: string; produced: unknown[]; consumed?: unknown[]; occurredAt: string; redate: boolean }> }>).flatMap((b) => b.runs);
    const byRun = new Map(sent.map((r) => [r.runId, r]));
    expect([...byRun.keys()].sort()).toEqual([findRun, checkedRun, archivedRun, originalRun, crmRun, crmPersonalRun].sort());
    const lf = (leadId: string) => [{ outcomeKey: "lead_found", subjectService: "lead-service", subjectId: leadId }];
    expect(byRun.get(findRun)).toEqual({ runId: findRun, produced: lf(plain), occurredAt: "run_started_at", redate: true });
    expect(byRun.get(checkedRun)).toEqual({
      runId: checkedRun,
      produced: lf(checked),
      consumed: [{ outcomeKey: "email_checked", subjectService: "lead-service", subjectId: checked }],
      occurredAt: "run_started_at",
      redate: true,
    });
    expect(byRun.get(crmRun)).toEqual({
      runId: crmRun,
      produced: lf(crmLead),
      consumed: [{ outcomeKey: "lead_identified", subjectService: "crm-service", subjectId: crmRel }],
      occurredAt: "run_started_at",
      redate: true,
    });
    expect(byRun.get(crmPersonalRun)).toEqual({ runId: crmPersonalRun, produced: lf(crmPersonal), occurredAt: "run_started_at", redate: true });
    expect(byRun.get(archivedRun)?.produced).toEqual(lf(archived));
    expect(byRun.get(originalRun)?.produced).toEqual(lf(repointed));
    expect(byRun.has(retryRun)).toBe(false);

    // A re-run sends the same bytes (runs-service answers already_recorded: nothing new written there).
    const again: unknown[] = [];
    await runOutcomeBackfill({ dryRun: false }, { post: async (b) => (again.push(b), { status: 200, json: { recordedCount: 0, alreadyRecordedCount: 4 }, text: "" }), lookup, scope: { orgId } });
    expect(again).toEqual(bodies);

    // A dry run declares nothing.
    const dry: unknown[] = [];
    const dryReport = await runOutcomeBackfill({ dryRun: true }, { post: async (b) => (dry.push(b), { status: 201, json: {}, text: "" }), lookup, scope: { orgId } });
    expect(dry).toEqual([]);
    expect(dryReport.runs).toBe(6);
  });

  it("names the one crm relation carrying the lead's email (company tie-break, withdrawn and untagged ignored)", async () => {
    const company = randomUUID();
    const single = await newLead("Single@itest.example", undefined, "crm");
    const singleRel = `rel:${randomUUID()}:pro`;
    await relation("single@itest.example", singleRel);

    const tied = await newLead("tied@itest.example", undefined, "crm", company);
    const tiedPro = `rel:${randomUUID()}:pro`;
    const tiedOrg = `rel:${randomUUID()}:org:${company}`;
    await relation("tied@itest.example", tiedPro);
    await relation("tied@itest.example", tiedOrg, { companyId: company });

    const twoAtCompany = await newLead("two@itest.example", undefined, "crm", company);
    await relation("two@itest.example", `rel:${randomUUID()}:org:${company}`, { companyId: company });
    await relation("two@itest.example", `rel:${randomUUID()}:org:${company}`, { companyId: company });

    const withdrawn = await newLead("withdrawn@itest.example", undefined, "crm");
    const gone = await relation("withdrawn@itest.example", `rel:${randomUUID()}:pro`);
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, raw, withdrawn_of)
      VALUES (${`itest-${randomUUID()}`}, ${String(Math.floor(Math.random() * 1e15) + 9e15)}::bigint, ${orgId}, ${brandId}, 'p', ARRAY[]::text[], ARRAY[]::text[],
              'withdrawn', 'observed', 'crm', 'w', '{}'::jsonb, '{}'::jsonb, ${gone})
    `);

    const untagged = await newLead("untagged@itest.example", undefined, "crm");
    await relation("untagged@itest.example", `rel:${randomUUID()}:pro`, { tags: ["professional_not_to_brand"] });

    const otherBrand = await newLead("single2@itest.example", undefined, "crm");
    await relation("single2@itest.example", `rel:${randomUUID()}:pro`);

    // LEDGER-HISTORY-1024: a tag the brand's own tools earned (source basis) is no judgment: crm-service produces no
    // lead_identified on it, so nothing is consumed (it read as unknown provenance on 292 of 293 such relations).
    const sourceOnly = await newLead("source@itest.example", undefined, "crm");
    await relation("source@itest.example", `rel:${randomUUID()}:pro`, { basis: "source" });

    const q = (leadId: string, brandIds = [brandId]) => ({ orgId, leadId, brandIds });
    expect(await crmIdentifiedRelationKeys([q(single), q(tied), q(twoAtCompany), q(withdrawn), q(untagged), q(otherBrand, [randomUUID()]), q(sourceOnly)])).toEqual([
      singleRel,
      tiedOrg,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});
