/**
 * COST-ACCOUNTING-1023-P1 (second pass) against a REAL database: every meeting booked / attended and sale OUR
 * outreach caused is declared once on the brand's recording run of the day (src/lib/outcome-fact-declarations.ts).
 * runs-service is faked at `fetch` and records every declaration.
 *
 *   - ours (caused_by_outreach = true) -> meeting_booked / meeting_attended / paid_client, subject = the lead,
 *     each consuming the outcome it came from (positive reply -> booked -> attended -> paid).
 *   - theirs (false), unasked (null) and withdrawn facts -> nothing.
 *   - a second pass declares nothing twice; one recording run per (org, brand, day, outcome key).
 * Every pass is scoped to this file's org: the suite's files share one database.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const { db } = await import("../../src/db/index.js");
const { leads, conversionEvents } = await import("../../src/db/schema.js");
const { sweepOutcomeFactDeclarations, resetOutcomeRecordingRunMemo } = await import("../../src/lib/outcome-fact-declarations.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

interface Declared {
  runId: string;
  orgId: string | null;
  body: { produced: Array<{ outcomeKey: string; subjectService: string; subjectId: string }>; consumed: Array<{ outcomeKey: string; subjectService: string; subjectId: string }> };
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
          declared.push({ runId: m[1], orgId: headers.get("x-org-id"), body: JSON.parse(String(init?.body)) });
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
    for (const id of created) await db.execute(sql`DELETE FROM leads WHERE id = ${id}::uuid`);
  });

  it("declares each outcome our outreach caused once, consuming what it came from", async () => {
    const ours = await newLead();
    await fact(ours, "positive_reply", "2026-10-01T10:00:00Z");
    await fact(ours, "meeting_booked", "2026-10-02T10:00:00Z");
    await fact(ours, "meeting_booked", "2026-10-03T10:00:00Z"); // a second booking: still one occurrence
    await fact(ours, "meeting_attended", "2026-10-05T10:00:00Z");
    await fact(ours, "sale", "2026-10-09T10:00:00Z", { valueCents: 10000 });

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
    expect(first).toMatchObject({ read: 4, delivered: 4, queued: 0, refused: 0, failed: 0 });

    const lead = (s: string) => ({ subjectService: "lead-service", subjectId: s });
    const byLead = (id: string) => declared.filter((d) => d.body.produced[0].subjectId === id).map((d) => d.body);
    expect(byLead(ours)).toEqual([
      { produced: [{ outcomeKey: "meeting_booked", ...lead(ours) }], consumed: [{ outcomeKey: "conversation", ...lead(ours) }] },
      { produced: [{ outcomeKey: "meeting_attended", ...lead(ours) }], consumed: [{ outcomeKey: "meeting_booked", ...lead(ours) }] },
      { produced: [{ outcomeKey: "paid_client", ...lead(ours) }], consumed: [{ outcomeKey: "meeting_attended", ...lead(ours) }] },
    ]);
    expect(byLead(visitor)).toEqual([
      { produced: [{ outcomeKey: "paid_client", ...lead(visitor) }], consumed: [{ outcomeKey: "website_visit", ...lead(visitor) }] },
    ]);
    for (const id of [theirs, unasked, withdrawn]) expect(byLead(id)).toEqual([]);

    // A day with a booked meeting, an attended meeting and a paid client opens THREE recording runs, one per outcome
    // key: runs-service splits a run's consumptions over what that run produced, so a shared run would make
    // `meeting_attended` consume itself (COST-ACCOUNTING-1023-LEAD-FIX). Every declaration under the org.
    expect(runsCreated).toHaveLength(3);
    expect(new Set(declared.map((d) => d.runId))).toEqual(new Set(runsCreated));
    const keysByRun = new Map<string, Set<string>>();
    for (const d of declared) for (const p of d.body.produced) keysByRun.set(d.runId, (keysByRun.get(d.runId) ?? new Set()).add(p.outcomeKey));
    expect([...keysByRun.values()].map((k) => [...k].sort()).sort()).toEqual([["meeting_attended"], ["meeting_booked"], ["paid_client"]]);
    for (const d of declared) {
      const produced = new Set(d.body.produced.map((p) => p.outcomeKey));
      for (const c of d.body.consumed) expect(produced.has(c.outcomeKey)).toBe(false);
    }
    expect(new Set(declared.map((d) => d.orgId))).toEqual(new Set([orgId]));

    const again = await sweepOutcomeFactDeclarations({ orgId });
    expect(again.read).toBe(0);
    expect(declared).toHaveLength(4);
  });
});
