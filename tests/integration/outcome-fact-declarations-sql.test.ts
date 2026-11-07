/**
 * COST-ACCOUNTING-1023-P1 (second pass) against a REAL database: every meeting booked / attended and sale OUR
 * outreach caused is declared once on the brand's recording run of the day (src/lib/outcome-fact-declarations.ts).
 * runs-service is faked at `fetch` and records every declaration.
 *
 *   - ours (caused_by_outreach = true) -> meeting_booked / meeting_attended / paid_client, subject = the lead,
 *     each consuming the outcome it came from (positive reply -> booked -> attended -> paid).
 *   - theirs (false) and unasked (null) -> ONE Unit too, consuming nothing, performer = the attester (LEDGER-DECLARE-1107);
 *     withdrawn facts -> nothing; a reach only the CRM copy holds -> one Unit per lead and outcome (a lead paying twice = 1).
 *   - a second pass declares nothing twice; one recording run per (org, brand, day, outcome key).
 * Every pass is scoped to this file's org: the suite's files share one database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, conversionEvents } = await import("../../src/db/schema.js");
const { sweepOutcomeFactDeclarations, resetOutcomeRecordingRunMemo, redateUndatedDeclarations, statePastPerformers, upgradeToOurs, reverseWithdrawnUnits } = await import("../../src/lib/outcome-fact-declarations.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

interface Declared {
  runId: string;
  orgId: string | null;
  serviceName: string | null;
  body: {
    produced: Array<{ outcomeKey: string; subjectService: string; subjectId: string }>;
    consumed: Array<{ outcomeKey: string; subjectService: string; subjectId: string }>;
    occurredAt?: string;
  };
}

describe.skipIf(!hasRealDatabase)("outcome fact declarations against a real database", () => {
  const orgId = `itest-ofd-${randomUUID()}`;
  const brandId = randomUUID();
  const created: string[] = [];
  const runsCreated: string[] = [];
  const declared: Declared[] = [];

  async function newLead(): Promise<string> {
    const [lead] = await db.insert(leads).values({ firstName: "Itest", lastName: "Person" }).returning({ id: leads.id });
    created.push(lead.id);
    return lead.id;
  }

  async function fact(leadId: string, event: string, at: string, over: Partial<typeof conversionEvents.$inferInsert> = {}): Promise<void> {
    await db.insert(conversionEvents).values({
      brandId,
      orgId,
      event,
      matchedLeadId: leadId,
      matchConfidence: "deterministic",
      attributionStatus: "attributed",
      source: "crm",
      receivedAt: new Date(at),
      causedByOutreach: true,
      dedupeSignature: `itest:${randomUUID()}`,
      ...over,
    });
  }

  beforeAll(() => {
    resetOutcomeRecordingRunMemo();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (url.endsWith("/v1/runs") && init?.method === "POST") {
          const id = randomUUID();
          runsCreated.push(id);
          return new Response(JSON.stringify({ id }), { status: 200 });
        }
        if (/\/v1\/runs\/[^/]+$/.test(url) && init?.method === "PATCH") return new Response("{}", { status: 200 });
        const m = url.match(/\/v1\/runs\/([^/]+)\/outcomes$/);
        if (m) {
          declared.push({ runId: m[1], orgId: headers.get("x-org-id"), serviceName: headers.get("x-service-name"), body: JSON.parse(String(init?.body)) });
          return new Response(JSON.stringify({ recorded: 1 }), { status: 200 });
        }
        return new Response(`unexpected ${url}`, { status: 599 });
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await db.execute(sql`DELETE FROM outcome_fact_declarations WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM outcome_recording_runs WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM conversion_events WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM crm_facts WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM lead_contact_methods WHERE lead_id = ANY(${sql.param(created)}::uuid[])`);
    await db.execute(sql`DELETE FROM lead_timeline_facts WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    for (const id of created) await db.execute(sql`DELETE FROM leads WHERE id = ${id}::uuid`);
  });

  it("declares each outcome our outreach caused once, consuming what it came from", async () => {
    const ours = await newLead();
    await fact(ours, "positive_reply", "2026-10-01T10:00:00Z");
    await fact(ours, "meeting_booked", "2026-10-02T10:00:00Z");
    await fact(ours, "meeting_booked", "2026-10-03T10:00:00Z"); // a second booking: still one occurrence
    await fact(ours, "meeting_attended", "2026-10-05T10:00:00Z");
    await fact(ours, "sale", "2026-10-09T10:00:00Z", { valueCents: 10000 });
    // Our first touch: the cold email of campaign camp-ours, sent by its serve workflow (LEAD-GENERIC-1106 performer).
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, workflow_slug)
      VALUES (${ours}::uuid, 'camp-ours', ${orgId}, ARRAY[${brandId}]::text[], 'served', 'cold-email-v7')
    `);
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, campaign_id, occurred_at, label, source, source_ref)
      VALUES (${`outreach:itest-${randomUUID()}`}, ${orgId}, ${brandId}, ${ours}::uuid, 'camp-ours', '2026-09-30T10:00:00Z', 'initial_email', 'outreach', 'itest-send')
    `);

    const theirs = await newLead();
    await fact(theirs, "meeting_booked", "2026-10-02T10:00:00Z", { causedByOutreach: false });
    const unasked = await newLead();
    await fact(unasked, "sale", "2026-10-02T10:00:00Z", { causedByOutreach: null });
    const withdrawn = await newLead();
    await fact(withdrawn, "meeting_booked", "2026-10-02T10:00:00Z", { withdrawnAt: new Date() });
    const visitor = await newLead();
    await fact(visitor, "website_visit", "2026-10-01T10:00:00Z", { source: "manual" });
    await fact(visitor, "sale", "2026-10-04T10:00:00Z");

    const first = await sweepOutcomeFactDeclarations({ orgId });
    expect(first).toMatchObject({ read: 7, delivered: 7, queued: 0, refused: 0, failed: 0, theirs: 2 });

    const lead = (s: string) => ({ subjectService: "lead-service", subjectId: s });
    // WHO performed it (LEAD-GENERIC-1106): our script when its send first touched them, else the fact's attester.
    const script = { performer: { kind: "script", workflowSlug: "cold-email-v7" } };
    const byLead = (id: string) => declared.filter((d) => d.body.produced[0].subjectId === id).map((d) => d.body);
    // Each occurrence is dated on the instant its fact happened (MEETING-DATED-OCCURRENCES-1024), the earliest booking.
    expect(byLead(ours)).toEqual([
      { produced: [{ outcomeKey: "meeting_booked", ...lead(ours), ...script }], consumed: [{ outcomeKey: "conversation", ...lead(ours) }], occurredAt: "2026-10-02T10:00:00.000Z" },
      { produced: [{ outcomeKey: "meeting_attended", ...lead(ours), ...script }], consumed: [{ outcomeKey: "meeting_booked", ...lead(ours) }], occurredAt: "2026-10-05T10:00:00.000Z" },
      { produced: [{ outcomeKey: "paid_client", ...lead(ours), ...script }], consumed: [{ outcomeKey: "meeting_attended", ...lead(ours) }], occurredAt: "2026-10-09T10:00:00.000Z" },
    ]);
    // A visit known only by hand is its own occurrence (LEDGER-HISTORY-1024), consuming the message our outreach sent.
    expect(byLead(visitor)).toEqual([
      { produced: [{ outcomeKey: "website_visit", ...lead(visitor), performer: { kind: "client_team", name: "manual" } }], consumed: [{ outcomeKey: "message_sent", ...lead(visitor) }], occurredAt: "2026-10-01T10:00:00.000Z" },
      { produced: [{ outcomeKey: "paid_client", ...lead(visitor), performer: { kind: "crm" } }], consumed: [{ outcomeKey: "website_visit", ...lead(visitor) }], occurredAt: "2026-10-04T10:00:00.000Z" },
    ]);
    // runs-service takes a past instant only from the run's own service.
    expect(new Set(declared.map((d) => d.serviceName))).toEqual(new Set(["lead-service"]));
    // A Unit our outreach did not cause is still ONE Unit of the brand's total, consuming nothing (none of our cost),
    // performed by its attester, never one of our scripts (LEDGER-DECLARE-1107).
    expect(byLead(theirs)).toEqual([
      { produced: [{ outcomeKey: "meeting_booked", ...lead(theirs), performer: { kind: "crm" } }], consumed: [], occurredAt: "2026-10-02T10:00:00.000Z" },
    ]);
    expect(byLead(unasked)).toEqual([
      { produced: [{ outcomeKey: "paid_client", ...lead(unasked), performer: { kind: "crm" } }], consumed: [], occurredAt: "2026-10-02T10:00:00.000Z" },
    ]);
    expect(byLead(withdrawn)).toEqual([]);

    // A day with a booked meeting, an attended meeting and a paid client opens THREE recording runs, one per outcome
    // key: runs-service splits a run's consumptions over what that run produced, so a shared run would make
    // `meeting_attended` consume itself (COST-ACCOUNTING-1023-LEAD-FIX). Every declaration under the org.
    // One run per (fact's UTC day, outcome key): the two sales of 10-04 and 10-09 sit on two runs.
    // A Unit another factory made sits on a run of its own (2 more): a shared run would split our consumptions onto it.
    expect(runsCreated).toHaveLength(7);
    for (const id of [theirs, unasked]) {
      const run = declared.find((d) => d.body.produced[0].subjectId === id)!.runId;
      expect(declared.filter((d) => d.runId === run)).toHaveLength(1);
    }
    expect(new Set(declared.map((d) => d.runId))).toEqual(new Set(runsCreated));
    const keysByRun = new Map<string, Set<string>>();
    for (const d of declared) for (const p of d.body.produced) keysByRun.set(d.runId, (keysByRun.get(d.runId) ?? new Set()).add(p.outcomeKey));
    expect([...keysByRun.values()].map((k) => [...k].sort()).sort()).toEqual([["meeting_attended"], ["meeting_booked"], ["meeting_booked"], ["paid_client"], ["paid_client"], ["paid_client"], ["website_visit"]]);
    const days = (await db.execute(sql`
      SELECT day::text AS day, outcome_key FROM outcome_recording_runs WHERE org_id = ${orgId} ORDER BY day, outcome_key
    `)) as unknown as Array<{ day: string; outcome_key: string }>;
    expect(days).toEqual([
      { day: "2026-10-01", outcome_key: "website_visit" },
      { day: "2026-10-02", outcome_key: "meeting_booked" },
      { day: "2026-10-04", outcome_key: "paid_client" },
      { day: "2026-10-05", outcome_key: "meeting_attended" },
      { day: "2026-10-09", outcome_key: "paid_client" },
    ]);
    const undated = (await db.execute(sql`SELECT count(*)::int AS n FROM outcome_fact_declarations WHERE org_id = ${orgId} AND NOT dated`)) as unknown as Array<{ n: number }>;
    expect(undated[0].n).toBe(0);
    for (const d of declared) {
      const produced = new Set(d.body.produced.map((p) => p.outcomeKey));
      for (const c of d.body.consumed) expect(produced.has(c.outcomeKey)).toBe(false);
    }
    expect(new Set(declared.map((d) => d.orgId))).toEqual(new Set([orgId]));

    const again = await sweepOutcomeFactDeclarations({ orgId });
    expect(again.read).toBe(0);
    expect(declared).toHaveLength(7);
  });

  it("LEDGER-HISTORY-1024: a signup, a direct purchase and its paid client are declared; a visit our tracker measured is not", async () => {
    const before = declared.length;
    const buyer = await newLead();
    await fact(buyer, "website_visit", "2026-09-01T08:00:00Z", { source: "manual" });
    await fact(buyer, "signup", "2026-09-01T09:00:00Z");
    await fact(buyer, "sale", "2026-09-02T09:00:00Z", { source: "tracker", valueCents: 4900 });
    const clicked = await newLead();
    await fact(clicked, "website_visit", "2026-09-01T08:00:00Z", { source: "manual" });
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, occurred_at, label, source, source_ref)
      VALUES (${`outreach:itest-${randomUUID()}`}, ${orgId}, ${brandId}, ${clicked}::uuid, '2026-09-01T07:59:00Z', 'website_visit', 'outreach', 'itest')
    `);
    const theirSignup = await newLead();
    await fact(theirSignup, "signup", "2026-09-01T09:00:00Z", { causedByOutreach: false });

    const pass = await sweepOutcomeFactDeclarations({ orgId });
    expect(pass).toMatchObject({ read: 5, delivered: 5, failed: 0, theirs: 1 });
    const mine = declared.slice(before).filter((d) => d.body.produced[0].subjectId === buyer);
    const subject = { subjectService: "lead-service", subjectId: buyer };
    expect(mine.map((d) => d.body)).toEqual([
      { produced: [{ outcomeKey: "website_visit", ...subject, performer: { kind: "client_team", name: "manual" } }], consumed: [{ outcomeKey: "message_sent", ...subject }], occurredAt: "2026-09-01T08:00:00.000Z" },
      { produced: [{ outcomeKey: "signup", ...subject, performer: { kind: "crm" } }], consumed: [{ outcomeKey: "website_visit", ...subject }], occurredAt: "2026-09-01T09:00:00.000Z" },
      { produced: [{ outcomeKey: "purchase", ...subject, performer: { kind: "tracker" } }], consumed: [{ outcomeKey: "website_visit", ...subject }], occurredAt: "2026-09-02T09:00:00.000Z" },
      { produced: [{ outcomeKey: "paid_client", ...subject, performer: { kind: "tracker" } }], consumed: [{ outcomeKey: "purchase", ...subject }], occurredAt: "2026-09-02T09:00:00.000Z" },
    ]);
    // One recording run per outcome key, never two keys on one run.
    expect(new Set(mine.map((d) => d.runId)).size).toBe(4);
    expect(declared.slice(before).filter((d) => d.body.produced[0].subjectId === theirSignup).map((d) => d.body)).toEqual([
      { produced: [{ outcomeKey: "signup", subjectService: "lead-service", subjectId: theirSignup, performer: { kind: "crm" } }], consumed: [], occurredAt: "2026-09-01T09:00:00.000Z" },
    ]);
    await db.execute(sql`DELETE FROM lead_timeline_facts WHERE org_id = ${orgId}`);
  });

  it("a declaration made before the dating rule is moved to its fact's instant once, as the same occurrence", async () => {
    const lead = await newLead();
    await fact(lead, "meeting_booked", "2026-05-20T09:30:00Z");
    const [ce] = (await db.execute(sql`SELECT id::text AS id FROM conversion_events WHERE matched_lead_id = ${lead}::uuid`)) as unknown as Array<{ id: string }>;
    const oldRun = randomUUID();
    await db.execute(sql`
      INSERT INTO outcome_fact_declarations (org_id, brand_id, lead_id, outcome_key, conversion_event_id, run_id, consumed_outcome_key, consumed_basis)
      VALUES (${orgId}, ${brandId}, ${lead}::uuid, 'meeting_booked', ${ce.id}::uuid, ${oldRun}::uuid, 'conversation', 'no_evidence')
    `);
    const posted: unknown[] = [];
    const post = async (body: unknown) => {
      posted.push(body);
      return { status: 201, text: JSON.stringify({ recordedCount: 0, redatedCount: 1, alreadyRecordedCount: 0 }) };
    };
    const first = await redateUndatedDeclarations({ orgId }, post);
    expect(first).toEqual({ read: 1, redated: 1, alreadyRecorded: 0, undated: 0, refused: 0 });
    const subject = { subjectService: "lead-service", subjectId: lead };
    expect(posted).toEqual([
      {
        runs: [
          {
            runId: oldRun,
            occurredAt: "2026-05-20T09:30:00.000Z",
            redate: true,
            produced: [{ outcomeKey: "meeting_booked", ...subject }],
            consumed: [{ outcomeKey: "conversation", ...subject }],
          },
        ],
      },
    ]);
    // Moved once: the next pass asks nothing.
    expect((await redateUndatedDeclarations({ orgId }, post)).read).toBe(0);
    expect(posted).toHaveLength(1);
  });

  it("a refused re-date stays undated and is asked again", async () => {
    const lead = await newLead();
    await fact(lead, "sale", "2026-06-01T09:30:00Z");
    const [ce] = (await db.execute(sql`SELECT id::text AS id FROM conversion_events WHERE matched_lead_id = ${lead}::uuid`)) as unknown as Array<{ id: string }>;
    await db.execute(sql`
      INSERT INTO outcome_fact_declarations (org_id, brand_id, lead_id, outcome_key, conversion_event_id, run_id, consumed_outcome_key, consumed_basis)
      VALUES (${orgId}, ${brandId}, ${lead}::uuid, 'paid_client', ${ce.id}::uuid, ${randomUUID()}::uuid, 'conversation', 'no_evidence')
    `);
    const refuse = async () => ({ status: 422, text: JSON.stringify({ error: "invalid_runs" }) });
    expect((await redateUndatedDeclarations({ orgId }, refuse)).refused).toBe(1);
    expect((await redateUndatedDeclarations({ orgId }, refuse)).read).toBe(1);
    await expect(redateUndatedDeclarations({ orgId }, async () => ({ status: 503, text: "down" }))).rejects.toThrow(/503/);
  });

  it("an occurrence declared before performers gets its performer stated once; a refusal is kept, never resent (LEAD-GENERIC-1106)", async () => {
    const lead = await newLead();
    await fact(lead, "meeting_booked", "2026-05-21T09:30:00Z");
    const refusedLead = await newLead();
    await fact(refusedLead, "meeting_booked", "2026-05-21T09:30:00Z", { source: "manual" });
    const runId = randomUUID();
    for (const id of [lead, refusedLead]) {
      const [ce] = (await db.execute(sql`SELECT id::text AS id FROM conversion_events WHERE matched_lead_id = ${id}::uuid`)) as unknown as Array<{ id: string }>;
      await db.execute(sql`
        INSERT INTO outcome_fact_declarations (org_id, brand_id, lead_id, outcome_key, conversion_event_id, run_id, consumed_outcome_key, consumed_basis, dated)
        VALUES (${orgId}, ${brandId}, ${id}::uuid, 'meeting_booked', ${ce.id}::uuid, ${runId}::uuid, 'conversation', 'no_evidence', true)
      `);
    }
    // Earlier cases' rows are not this case's subject.
    await db.execute(sql`UPDATE outcome_fact_declarations SET performer_error = 'itest: other case' WHERE org_id = ${orgId} AND performer IS NULL AND run_id <> ${runId}::uuid`);
    const posted: Array<{ runs: Array<{ runId: string; produced: unknown[] }> }> = [];
    const post = async (body: unknown) => {
      const b = body as { runs: Array<{ runId: string; produced: Array<{ subjectId: string }> }> };
      posted.push(b);
      if (b.runs[0].produced[0].subjectId === refusedLead) return { status: 409, text: JSON.stringify({ code: "performer_conflict" }) };
      return { status: 200, text: JSON.stringify({ performerStatedCount: 1 }) };
    };
    expect(await statePastPerformers({ orgId }, post)).toEqual({ read: 2, stated: 1, refused: 1 });
    const stated = posted.find((p) => p.runs[0].produced.some((x) => (x as { subjectId: string }).subjectId === lead))!;
    expect(stated).toEqual({
      runs: [{ runId, produced: [{ outcomeKey: "meeting_booked", subjectService: "lead-service", subjectId: lead, performer: { kind: "crm" } }] }],
    });
    const rows = (await db.execute(sql`
      SELECT lead_id::text AS lead_id, performer, performer_error FROM outcome_fact_declarations WHERE run_id = ${runId}::uuid
    `)) as unknown as Array<{ lead_id: string; performer: unknown; performer_error: string | null }>;
    expect(rows.find((r) => r.lead_id === lead)).toMatchObject({ performer: { kind: "crm" }, performer_error: null });
    expect(rows.find((r) => r.lead_id === refusedLead)?.performer_error).toMatch(/^409 /);
    // Stated once, refused once: the next pass asks nothing.
    expect((await statePastPerformers({ orgId }, post)).read).toBe(0);
  });
  it("LEDGER-DECLARE-1107: a signup and a paid client only the CRM copy holds are ONE Unit each per lead, at the first reach", async () => {
    let seq = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
    const crmFact = async (email: string | string[], type: string, at: string, source: string, payload: Record<string, unknown> = {}) => {
      const emails = Array.isArray(email) ? email : [email];
      const id = `itest-ofd-${randomUUID()}`;
      seq += 1n;
      await db.execute(sql`
        INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
        VALUES (${id}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${`pk-${emails[0]}`}, ${sql.param(emails)}::text[], ARRAY[]::text[], ${type},
                ${at}::timestamptz, 'occurred_at', ${source}, ${id}, ${JSON.stringify(payload)}::jsonb, '{}'::jsonb)
      `);
      return id;
    };
    const leadOfBrand = async (email: string) => {
      const id = await newLead();
      await db.execute(sql`
        INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status)
        VALUES (${id}::uuid, ${`signups:${brandId}`}, ${orgId}, ARRAY[${brandId}]::text[], 'served')
      `);
      await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${id}::uuid, 'email', ${email}, 'itest')`);
      return id;
    };
    const tag = randomUUID().slice(0, 8);
    const payer = await leadOfBrand(`payer-${tag}@example.com`);
    await crmFact(`Payer-${tag}@Example.com`, "signup", "2026-08-01T09:00:00Z", "clerk");
    await crmFact(`payer-${tag}@example.com`, "signup", "2026-08-03T09:00:00Z", "posthog"); // a second signup fact: one Unit
    await crmFact(`payer-${tag}@example.com`, "payment", "2026-08-02T09:00:00Z", "stripe", { status: "failed", amountMinor: 9900 }); // refused: no reach
    await crmFact(`payer-${tag}@example.com`, "payment", "2026-08-05T09:00:00Z", "stripe", { status: "succeeded", amountMinor: 9900 });
    await crmFact(`payer-${tag}@example.com`, "payment", "2026-09-05T09:00:00Z", "stripe", { status: "succeeded", amountMinor: 9900 }); // paid twice: one Unit
    const refunded = await leadOfBrand(`refunded-${tag}@example.com`);
    await crmFact(`refunded-${tag}@example.com`, "payment", "2026-08-05T09:00:00Z", "stripe", { status: "succeeded", amountMinor: 9900, amountRefunded: 9900 });
    await crmFact(`stranger-${tag}@example.com`, "signup", "2026-08-01T09:00:00Z", "clerk"); // not a lead of the brand: nobody to name
    // One person, an address per lead row: ONE Unit, on the lowest lead id.
    const twoA = await leadOfBrand(`two-a-${tag}@example.com`);
    const twoB = await leadOfBrand(`two-b-${tag}@example.com`);
    await crmFact([`two-b-${tag}@example.com`, `two-a-${tag}@example.com`], "signup", "2026-08-01T10:00:00Z", "clerk");
    await crmFact(`two-b-${tag}@example.com`, "signup", "2026-08-02T10:00:00Z", "posthog");
    const [low] = [twoA, twoB].sort();
    // A ledger row a person WITHDREW (a staff test, a wrong attribution) is never brought back from the CRM copy.
    const unsaid = await leadOfBrand(`unsaid-${tag}@example.com`);
    await fact(unsaid, "signup", "2026-08-01T09:00:00Z", { withdrawnAt: new Date(), causedByOutreach: false });
    await crmFact(`unsaid-${tag}@example.com`, "signup", "2026-08-01T09:00:00Z", "clerk");
    const before = declared.length;

    // (An earlier case's hand-stated visit became declarable once its timeline fact was deleted: not this case's subject.)
    const pass = await sweepOutcomeFactDeclarations({ orgId });
    expect(pass).toMatchObject({ failed: 0, theirs: 3 });
    const subject = { subjectService: "lead-service", subjectId: payer };
    const mine = () => declared.slice(before).filter((d) => [payer, refunded, unsaid].includes(d.body.produced[0].subjectId));
    expect(mine().map((d) => d.body)).toEqual([
      { produced: [{ outcomeKey: "signup", ...subject, performer: { kind: "crm", name: "clerk" } }], consumed: [], occurredAt: "2026-08-01T09:00:00.000Z" },
      { produced: [{ outcomeKey: "paid_client", ...subject, performer: { kind: "crm", name: "stripe" } }], consumed: [], occurredAt: "2026-08-05T09:00:00.000Z" },
    ]);
    expect(mine().some((d) => d.body.produced[0].subjectId === refunded)).toBe(false);
    expect(declared.slice(before).filter((d) => [twoA, twoB].includes(d.body.produced[0].subjectId)).map((d) => [d.body.produced[0].subjectId, d.body.occurredAt])).toEqual([
      [low, "2026-08-01T10:00:00.000Z"],
    ]);

    // A later payment, a ledger row of the same reach (the contact paired): never a second Unit.
    await crmFact(`payer-${tag}@example.com`, "payment", "2026-10-05T09:00:00Z", "stripe", { status: "succeeded", amountMinor: 9900 });
    await fact(payer, "sale", "2026-08-05T09:00:00Z", { causedByOutreach: false });
    expect((await sweepOutcomeFactDeclarations({ orgId })).read).toBe(0);
    expect(mine()).toHaveLength(2);
    // The second signup naming one address alone is still that person: never a second Unit on another pass.
    expect(declared.slice(before).filter((d) => [twoA, twoB].includes(d.body.produced[0].subjectId))).toHaveLength(1);
  });

  it("LEDGER-DECLARE-1107: a Unit declared as theirs that the cause rule turns ours takes its consumption on the SAME occurrence, once", async () => {
    const lead = await newLead();
    await fact(lead, "signup", "2026-07-01T09:00:00Z", { causedByOutreach: null });
    const before = declared.length;
    await sweepOutcomeFactDeclarations({ orgId });
    const first = declared.slice(before).find((d) => d.body.produced[0].subjectId === lead)!;
    expect(first.body.consumed).toEqual([]);

    await db.execute(sql`UPDATE conversion_events SET caused_by_outreach = true WHERE matched_lead_id = ${lead}::uuid`);
    const posted: unknown[] = [];
    const post = async (body: unknown) => {
      posted.push(body);
      return { status: 201, text: JSON.stringify({ recordedCount: 1, performerCorrectedCount: 1 }) };
    };
    // Other cases' theirs Units stay theirs (their facts are not ours): only this lead turns.
    expect(await upgradeToOurs({ orgId }, post)).toEqual({ read: 1, upgraded: 1, refused: 0 });
    const subject = { subjectService: "lead-service", subjectId: lead };
    expect(posted).toEqual([
      {
        runs: [
          {
            runId: first.runId,
            occurredAt: "2026-07-01T09:00:00.000Z",
            correctPerformer: true,
            produced: [{ outcomeKey: "signup", ...subject, performer: { kind: "crm" } }],
            consumed: [{ outcomeKey: "message_sent", ...subject }],
          },
        ],
      },
    ]);
    expect((await upgradeToOurs({ orgId }, post)).read).toBe(0);
    // Never a second Unit.
    expect((await sweepOutcomeFactDeclarations({ orgId })).read).toBe(0);
  });

  it("LEDGER-REVERSAL-1107: a Unit whose fact is taken back is reversed once, at the withdrawal; the fact coming back is a NEW Unit", async () => {
    const lead = await newLead();
    await fact(lead, "sale", "2026-06-10T09:00:00Z", { causedByOutreach: false, valueCents: 100 });
    const before = declared.length;
    await sweepOutcomeFactDeclarations({ orgId });
    const unit = declared.slice(before).find((d) => d.body.produced[0].subjectId === lead)!;
    const posted: unknown[] = [];
    const post = async (body: unknown) => {
      posted.push(body);
      return { status: 201, text: JSON.stringify({ reversedCount: 1 }) };
    };
    // Still live: nothing to reverse (an absence is never evidence).
    expect((await reverseWithdrawnUnits({ orgId }, post)).read).toBe(0);

    await db.execute(sql`UPDATE conversion_events SET withdrawn_at = '2026-11-05T18:30:14Z', withdrawn_reason = 'wrong_attribution' WHERE matched_lead_id = ${lead}::uuid`);
    expect(await reverseWithdrawnUnits({ orgId }, post)).toEqual({ read: 1, reversed: 1, refused: 0 });
    expect(posted).toEqual([
      {
        reversedBy: "lead-service outcome-fact-declarations",
        reversals: [{ runId: unit.runId, outcomeKey: "paid_client", subjectService: "lead-service", subjectId: lead, reversedAt: "2026-11-05T18:30:14.000Z", reason: "fact taken back: wrong_attribution" }],
      },
    ]);
    expect((await reverseWithdrawnUnits({ orgId }, post)).read).toBe(0);

    // The person undoes the withdrawal: the fact stands again, a NEW Unit on a run of its own.
    await db.execute(sql`UPDATE conversion_events SET withdrawn_at = NULL, withdrawn_reason = NULL WHERE matched_lead_id = ${lead}::uuid`);
    const mark = declared.length;
    await sweepOutcomeFactDeclarations({ orgId });
    const again = declared.slice(mark).filter((d) => d.body.produced[0].subjectId === lead);
    expect(again).toHaveLength(1);
    expect(again[0].runId).not.toBe(unit.runId);
    const [row] = (await db.execute(sql`
      SELECT reversed_at, run_id::text AS run_id FROM outcome_fact_declarations WHERE org_id = ${orgId} AND lead_id = ${lead}::uuid AND outcome_key = 'paid_client'
    `)) as unknown as Array<{ reversed_at: string | null; run_id: string }>;
    expect(row).toEqual({ reversed_at: null, run_id: again[0].runId });
  });

  it("a refused reversal is kept, never resent", async () => {
    const lead = await newLead();
    await fact(lead, "signup", "2026-06-11T09:00:00Z", { causedByOutreach: false });
    await sweepOutcomeFactDeclarations({ orgId });
    await db.execute(sql`UPDATE conversion_events SET withdrawn_at = now() WHERE matched_lead_id = ${lead}::uuid`);
    const refuse = async () => ({ status: 422, text: JSON.stringify({ error: "invalid_reversals" }) });
    // Earlier cases' withdrawn Units are not this case's subject: only this lead is asked.
    const first = await reverseWithdrawnUnits({ orgId }, refuse);
    expect(first.refused).toBeGreaterThanOrEqual(1);
    expect((await reverseWithdrawnUnits({ orgId }, refuse)).read).toBe(0);
    await expect(
      (async () => {
        const l2 = await newLead();
        await fact(l2, "signup", "2026-06-12T09:00:00Z", { causedByOutreach: false });
        await sweepOutcomeFactDeclarations({ orgId });
        await db.execute(sql`UPDATE conversion_events SET withdrawn_at = now() WHERE matched_lead_id = ${l2}::uuid`);
        await reverseWithdrawnUnits({ orgId }, async () => ({ status: 503, text: "down" }));
      })(),
    ).rejects.toThrow(/503/);
    // The door not served yet (404) is not a refusal: asked again next pass.
    await expect(reverseWithdrawnUnits({ orgId }, async () => ({ status: 404, text: JSON.stringify({ error: "Not found" }) }))).rejects.toThrow(/404/);
    expect((await reverseWithdrawnUnits({ orgId }, async () => ({ status: 201, text: "{}" }))).reversed).toBeGreaterThanOrEqual(1);
  });
});
