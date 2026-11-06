/**
 * FACTORY-P2-CONTENT-OUTCOMES against a REAL database: a click on a post's link that ends in a signup credits that
 * post's run (src/lib/post-touch.ts, first-touch.ts, outcome-fact-declarations.ts). runs-service is faked at `fetch`
 * and records every run and declaration; email-gateway says nobody was ever emailed.
 *
 * The whole path, end to end, through the real sweeps over bronze `crm_facts`:
 *   PostHog visit (entry URL `?dy_post=meta-service:<uuid>`) + a later CRM signup of the same email
 *   -> brand-signups files the person as a lead of the brand
 *   -> the post-touch sweep: ONE spend-free `post-touch-visit` run producing `website_visit` (the lead), consuming
 *      `post_published` (meta-service/<uuid>), dated at the visit
 *   -> the CRM evidence sync: the signup is after our first touch (the post touch) = ours
 *   -> the outcome fact sweep: the signup declared consuming the lead's `website_visit`.
 * Also: no param / malformed param = nothing; a replay declares nothing twice; a refusal stays loud and is no touch;
 * several leads on the visit's emails = skipped with the why.
 * OUTCOME-FINEST-1106: the touch consumes the Unit's OWN outcome: stated by a `dy_unit` link (a newsletter email:
 * `newsletter_email_sent`), else read off the ledger for a legacy `dy_post` link (a post declared
 * `threads_post_published` consumes that; an old `post_published` one still credits); not on the ledger yet = waits.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

// `produced`: what the fake ledger says each subject PRODUCED (the legacy dy_post marker's outcome is read off it).
const state = vi.hoisted(() => ({ refusePost: new Set<string>(), produced: new Map<string, string[]>(), ledgerReads: [] as string[] }));

vi.mock("../../src/lib/email-gateway-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/email-gateway-client.js")>();
  return {
    ...actual,
    // Nobody here was ever emailed: the post touch is the only touch.
    checkDeliveryStatus: vi.fn(async (_b: string, _c: unknown, items: Array<{ email: string }>) => ({
      results: items.map(({ email }) => ({ email, broadcast: { brand: null } })),
    })),
  };
});

vi.mock("../../src/lib/campaign-leg-client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/campaign-leg-client.js")>()),
  fetchOrgCampaignLegs: vi.fn(async () => new Map()),
}));

const { db } = await import("../../src/db/index.js");
const { sql } = await import("drizzle-orm");
const { crmFacts, leads, leadContactMethods, leadsCampaigns } = await import("../../src/db/schema.js");
const { fileBrandSignups } = await import("../../src/lib/brand-signups.js");
const { sweepPostTouches } = await import("../../src/lib/post-touch.js");
const { syncCrmEvidence } = await import("../../src/lib/crm-evidence-sync.js");
const { sweepOutcomeFactDeclarations, resetOutcomeRecordingRunMemo } = await import("../../src/lib/outcome-fact-declarations.js");
const { PEOPLE_FACTS_FEED } = await import("../../src/lib/crm-fact-feed.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

interface Created {
  runId: string;
  taskName: string;
}
interface Declared {
  runId: string;
  serviceName: string | null;
  body: {
    produced: Array<{ outcomeKey: string; subjectService: string; subjectId: string }>;
    consumed: Array<{ outcomeKey: string; subjectService: string; subjectId: string }>;
    occurredAt?: string;
  };
}

describe.skipIf(!hasRealDatabase)("post touches against a real database", () => {
  const orgId = `itest-post-${randomUUID()}`;
  const brandId = randomUUID();
  const tag = randomUUID().slice(0, 8);
  const addr = (name: string) => `${name}-${tag}@example.com`;
  const POST = randomUUID();
  const REFUSED_POST = randomUUID();
  const runs: Created[] = [];
  const declared: Declared[] = [];
  const createdLeads: string[] = [];

  async function fact(type: string, email: string, over: Partial<typeof crmFacts.$inferInsert> & { humanId?: string } = {}): Promise<void> {
    const { humanId, ...rest } = over;
    await db.insert(crmFacts).values({
      factId: randomUUID(),
      seq: BigInt(Math.floor(Math.random() * 1e15)),
      orgId,
      brandId,
      personKey: `email:${email}`,
      crmContactId: `contact-${email}`,
      fullName: "Post Visitor",
      emails: [email],
      phones: [],
      type,
      occurredAt: new Date("2026-10-20T10:00:00.000Z"),
      dateBasis: type === "signup" ? "person_created_at" : "session_start",
      source: "posthog",
      sourceRef: `ref-${randomUUID()}`,
      payload: {},
      raw: { itest: true, ...(humanId ? { humanId } : {}) },
      ...rest,
    });
  }

  const visit = (email: string, firstUrl: string, at: string, humanId?: string) =>
    fact("website_visit", email, { payload: { firstUrl }, occurredAt: new Date(at), humanId });
  const signup = (email: string, at: string, humanId: string) => fact("signup", email, { occurredAt: new Date(at), humanId });

  async function leadOf(email: string): Promise<string> {
    const rows = (await db.execute(sql`SELECT lead_id::text AS lead_id FROM lead_contact_methods WHERE channel = 'email' AND lower(value) = ${email}`)) as unknown as Array<{ lead_id: string }>;
    expect(rows, email).toHaveLength(1);
    createdLeads.push(rows[0].lead_id);
    return rows[0].lead_id;
  }

  const byLead = (leadId: string) => declared.filter((d) => d.body.produced[0]?.subjectId === leadId);

  beforeAll(async () => {
    resetOutcomeRecordingRunMemo();
    // The legacy posts were declared post_published by meta-service.
    state.produced.set(POST, ["post_published"]);
    state.produced.set(REFUSED_POST, ["post_published"]);
    // The fact-feed copy reached its end at least once (the CRM evidence sync refuses a copy still filling).
    await db.execute(sql`
      INSERT INTO crm_feed_cursors (feed, cursor, caught_up_at) VALUES (${PEOPLE_FACTS_FEED}, '0', now())
      ON CONFLICT (feed) DO UPDATE SET caught_up_at = COALESCE(crm_feed_cursors.caught_up_at, now())`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (url.endsWith("/v1/runs") && init?.method === "POST") {
          const id = randomUUID();
          runs.push({ runId: id, taskName: JSON.parse(String(init?.body)).taskName });
          return new Response(JSON.stringify({ id }), { status: 200 });
        }
        if (/\/v1\/runs\/[^/]+$/.test(url) && init?.method === "PATCH") return new Response("{}", { status: 200 });
        if (url.includes("/internal/outcome-occurrences?")) {
          const q = new URL(url).searchParams;
          expect(q.get("direction")).toBe("produced");
          const subjectService = q.get("subjectService")!;
          const subjectId = q.get("subjectIds")!;
          state.ledgerReads.push(subjectId);
          const occurrences = (state.produced.get(subjectId) ?? []).map((outcomeKey) => ({ outcomeKey, subjectService, subjectId, direction: "produced" }));
          return new Response(JSON.stringify({ occurrences, nextCursor: null }), { status: 200 });
        }
        const m = url.match(/\/v1\/runs\/([^/]+)\/outcomes$/);
        if (m) {
          const body = JSON.parse(String(init?.body)) as Declared["body"];
          if (body.consumed.some((c) => state.refusePost.has(c.subjectId))) {
            return new Response(JSON.stringify({ error: "unknown_consumed_subject" }), { status: 400 });
          }
          declared.push({ runId: m[1], serviceName: headers.get("x-service-name"), body });
          return new Response(JSON.stringify({ recorded: 1 }), { status: 200 });
        }
        return new Response(`unexpected ${url}`, { status: 599 });
      }),
    );
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    for (const t of ["post_touch_declarations", "post_touch_skips", "outcome_fact_declarations", "outcome_recording_runs", "conversion_events", "crm_facts"]) {
      await db.execute(sql`DELETE FROM ${sql.identifier(t)} WHERE org_id = ${orgId}`);
    }
    await db.execute(sql`DELETE FROM run_outcome_outbox WHERE org_id = ${orgId}`);
    await db.delete(leadsCampaigns).where(sql`org_id = ${orgId}`);
    for (const id of createdLeads) {
      await db.delete(leadContactMethods).where(sql`lead_id = ${id}::uuid`);
      await db.delete(leads).where(sql`id = ${id}::uuid`);
    }
  });

  it("a click on a post's link that ends in a signup credits that post's run", async () => {
    const human = randomUUID();
    const email = addr("clicker");
    // The session's entry URL carries the post (the colon URL-encoded); an earlier-seen, LATER session too.
    await visit(email, `https://distribute.you/?utm_source=threads&dy_post=meta-service%3A${POST}`, "2026-10-20T10:00:00.000Z", human);
    await visit(email, `https://distribute.you/pricing?dy_post=meta-service:${POST}`, "2026-10-21T08:00:00.000Z", human);
    await signup(email, "2026-10-20T10:30:00.000Z", human);

    // Not a lead yet: nothing to credit, nothing claimed.
    const before = await sweepPostTouches({ orgId });
    expect(before).toMatchObject({ touches: 0, noLead: 2 });

    // The signup files them as a lead of the brand; human-service names their human.
    await fileBrandSignups({ orgId, brandId });
    const leadId = await leadOf(email);
    await db.execute(sql`UPDATE leads SET human_id = ${human}::uuid WHERE id = ${leadId}::uuid`);

    const first = await sweepPostTouches({ orgId });
    expect(first).toMatchObject({ touches: 1, delivered: 1, refused: 0, failed: 0 });

    // (a) ONE spend-free run of its own, producing the lead's website_visit, consuming the post, dated at the visit.
    const postRuns = runs.filter((r) => r.taskName === "post-touch-visit");
    expect(postRuns).toHaveLength(1);
    expect(byLead(leadId)).toEqual([
      {
        runId: postRuns[0].runId,
        serviceName: "lead-service",
        body: {
          produced: [{ outcomeKey: "website_visit", subjectService: "lead-service", subjectId: leadId, performer: { kind: "tracker" } }],
          consumed: [{ outcomeKey: "post_published", subjectService: "meta-service", subjectId: POST }],
          occurredAt: "2026-10-20T10:00:00.000Z",
        },
      },
    ]);

    // Our first touch is the post touch: the CRM signup after it is ours.
    await syncCrmEvidence(orgId, brandId);
    const events = (await db.execute(sql`
      SELECT event, caused_by_outreach, crm_evidence->'rule'->>'reason' AS reason FROM conversion_events
      WHERE org_id = ${orgId} AND matched_lead_id = ${leadId}::uuid AND withdrawn_at IS NULL
    `)) as unknown as Array<{ event: string; caused_by_outreach: boolean | null; reason: string }>;
    expect(events).toEqual([{ event: "signup", caused_by_outreach: true, reason: "after_first_delivery" }]);

    // (b) The signup is declared consuming the website_visit the post-touch run produced.
    await sweepOutcomeFactDeclarations({ orgId });
    const signupDecl = byLead(leadId).filter((d) => d.body.produced[0].outcomeKey === "signup");
    expect(signupDecl.map((d) => d.body)).toEqual([
      {
        produced: [{ outcomeKey: "signup", subjectService: "lead-service", subjectId: leadId, performer: { kind: "crm" } }],
        consumed: [{ outcomeKey: "website_visit", subjectService: "lead-service", subjectId: leadId }],
        occurredAt: "2026-10-20T10:30:00.000Z",
      },
    ]);
    // No hand-stated website_visit is declared beside the post-touch run's.
    expect(byLead(leadId).filter((d) => d.body.produced[0].outcomeKey === "website_visit")).toHaveLength(1);

    // A replay declares nothing twice and opens no run.
    const runsBefore = runs.length;
    const declaredBefore = declared.length;
    const replay = await sweepPostTouches({ orgId });
    expect(replay).toMatchObject({ touches: 1, delivered: 0, queued: 0, refused: 0, failed: 0 });
    await sweepOutcomeFactDeclarations({ orgId });
    expect(runs.length).toBe(runsBefore);
    expect(declared.length).toBe(declaredBefore);
  });

  it("no param, a malformed param, a refused post and several leads credit nothing", async () => {
    const plain = addr("plain");
    const malformed = addr("malformed");
    const refused = addr("refused");
    const humans = { plain: randomUUID(), malformed: randomUUID(), refused: randomUUID() };
    await visit(plain, "https://distribute.you/?utm_source=threads", "2026-10-22T10:00:00.000Z", humans.plain);
    await visit(malformed, "https://distribute.you/?dy_post=Meta_Service:", "2026-10-22T10:00:00.000Z", humans.malformed);
    await visit(refused, `https://distribute.you/?dy_post=meta-service:${REFUSED_POST}`, "2026-10-22T10:00:00.000Z", humans.refused);
    for (const [k, email] of Object.entries({ plain, malformed, refused })) await signup(email, "2026-10-22T11:00:00.000Z", humans[k as keyof typeof humans]);
    await fileBrandSignups({ orgId, brandId });
    for (const [k, email] of Object.entries({ plain, malformed, refused })) {
      await db.execute(sql`UPDATE leads SET human_id = ${humans[k as keyof typeof humans]}::uuid WHERE id = ${await leadOf(email)}::uuid`);
    }

    // Two leads of the brand hold the visit's address (case variants): skipped, the why kept.
    const shared = addr("shared");
    for (const variant of [shared, shared.toUpperCase()]) {
      const [l] = await db.insert(leads).values({ name: "Shared" }).returning({ id: leads.id });
      createdLeads.push(l.id);
      await db.insert(leadContactMethods).values({ leadId: l.id, channel: "email", value: variant, source: "itest" });
      await db.insert(leadsCampaigns).values({ leadId: l.id, campaignId: `itest-${randomUUID()}`, orgId, brandIds: [brandId], status: "served" });
    }
    await visit(shared, `https://distribute.you/?dy_post=meta-service:${POST}`, "2026-10-22T10:00:00.000Z");

    state.refusePost.add(REFUSED_POST);
    const runsBefore = runs.filter((r) => r.taskName === "post-touch-visit").length;
    const pass = await sweepPostTouches({ orgId });
    expect(pass).toMatchObject({ delivered: 0, refused: 1, ambiguous: 1 });
    // One run for the refused one (the refusal is the ledger's answer, kept loud), none for the others.
    expect(runs.filter((r) => r.taskName === "post-touch-visit").length).toBe(runsBefore + 1);
    const rows = (await db.execute(sql`
      SELECT p.status, p.error, cm.value AS email FROM post_touch_declarations p
      JOIN lead_contact_methods cm ON cm.lead_id = p.lead_id AND cm.channel = 'email'
      WHERE p.org_id = ${orgId} AND p.post_subject_id = ${REFUSED_POST}
    `)) as unknown as Array<{ status: string; error: string; email: string }>;
    expect(rows).toEqual([{ status: "refused", error: expect.stringContaining("400"), email: refused }]);
    const skips = (await db.execute(sql`SELECT reason, cardinality(lead_ids) AS n FROM post_touch_skips WHERE org_id = ${orgId}`)) as unknown as Array<{ reason: string; n: number }>;
    expect(skips).toEqual([{ reason: "ambiguous_lead", n: 2 }]);

    // A refused touch is no touch: none of these signups is ours, nothing declared for them.
    await syncCrmEvidence(orgId, brandId);
    for (const email of [plain, malformed, refused]) {
      const leadId = await leadOf(email);
      const ev = (await db.execute(sql`
        SELECT caused_by_outreach FROM conversion_events WHERE org_id = ${orgId} AND matched_lead_id = ${leadId}::uuid AND event = 'signup'
      `)) as unknown as Array<{ caused_by_outreach: boolean | null }>;
      expect(ev, email).toEqual([{ caused_by_outreach: null }]);
    }
    const declaredBefore = declared.length;
    await sweepOutcomeFactDeclarations({ orgId });
    expect(declared.length).toBe(declaredBefore);

    // The refusal is never re-sent.
    const again = await sweepPostTouches({ orgId });
    expect(again).toMatchObject({ refused: 0, delivered: 0 });
  });
  it("credits the Unit's own outcome: a newsletter email (dy_unit), a Threads post declared threads_post_published (dy_post)", async () => {
    const THREADS_POST = randomUUID();
    const LATE_POST = randomUUID();
    const RECIPIENT = randomUUID();
    state.produced.set(THREADS_POST, ["threads_post_published"]);
    const reader = addr("reader");
    const scroller = addr("scroller");
    const early = addr("early");
    const organic = addr("organic");
    const humans = { reader: randomUUID(), scroller: randomUUID(), early: randomUUID(), organic: randomUUID() };
    await visit(reader, `https://distribute.you/?dy_sub=s1&dy_unit=newsletter_email_sent%3Atransactional-email-service%3A${RECIPIENT}`, "2026-10-23T10:00:00.000Z", humans.reader);
    await visit(scroller, `https://distribute.you/?dy_post=meta-service:${THREADS_POST}`, "2026-10-23T10:00:00.000Z", humans.scroller);
    // A post whose occurrence is not on the ledger yet: the touch waits, never assumes an outcome.
    await visit(early, `https://distribute.you/?dy_post=meta-service:${LATE_POST}`, "2026-10-23T10:00:00.000Z", humans.early);
    // No marker: organic, whatever the timing (the newsletter went out the same minute).
    await visit(organic, "https://distribute.you/?utm_source=newsletter", "2026-10-23T10:00:00.000Z", humans.organic);
    for (const [k, email] of Object.entries({ reader, scroller, early, organic })) await signup(email, "2026-10-23T11:00:00.000Z", humans[k as keyof typeof humans]);
    await fileBrandSignups({ orgId, brandId });
    const lead: Record<string, string> = {};
    for (const [k, email] of Object.entries({ reader, scroller, early, organic })) {
      lead[k] = await leadOf(email);
      await db.execute(sql`UPDATE leads SET human_id = ${humans[k as keyof typeof humans]}::uuid WHERE id = ${lead[k]}::uuid`);
    }

    state.ledgerReads.length = 0;
    const pass = await sweepPostTouches({ orgId });
    expect(pass).toMatchObject({ delivered: 2, unresolved: 1, refused: 0, failed: 0 });
    // The newsletter Unit is stated by its link: no ledger read for it.
    expect(state.ledgerReads).not.toContain(RECIPIENT);
    expect(byLead(lead.reader).map((d) => d.body.consumed)).toEqual([
      [{ outcomeKey: "newsletter_email_sent", subjectService: "transactional-email-service", subjectId: RECIPIENT }],
    ]);
    expect(byLead(lead.scroller).map((d) => d.body.consumed)).toEqual([[{ outcomeKey: "threads_post_published", subjectService: "meta-service", subjectId: THREADS_POST }]]);
    expect(byLead(lead.early)).toEqual([]);
    expect(byLead(lead.organic)).toEqual([]);
    const waiting = (await db.execute(sql`
      SELECT status, unit_outcome_key, error FROM post_touch_declarations WHERE org_id = ${orgId} AND post_subject_id = ${LATE_POST}
    `)) as unknown as Array<{ status: string; unit_outcome_key: string | null; error: string }>;
    expect(waiting).toEqual([{ status: "claimed", unit_outcome_key: null, error: expect.stringContaining("not on the ledger") }]);
    const stored = (await db.execute(sql`
      SELECT post_subject_id, unit_outcome_key FROM post_touch_declarations WHERE org_id = ${orgId} AND status = 'delivered' ORDER BY post_subject_id
    `)) as unknown as Array<{ post_subject_id: string; unit_outcome_key: string }>;
    expect(Object.fromEntries(stored.map((r) => [r.post_subject_id, r.unit_outcome_key]))).toMatchObject({
      [RECIPIENT]: "newsletter_email_sent",
      [THREADS_POST]: "threads_post_published",
      [POST]: "post_published",
    });

    // Once the post lands on the ledger, the next pass credits its own outcome; nothing else is re-sent.
    state.produced.set(LATE_POST, ["linkedin_post_published"]);
    const declaredBefore = declared.length;
    const next = await sweepPostTouches({ orgId });
    expect(next).toMatchObject({ delivered: 1, unresolved: 0 });
    expect(declared.length).toBe(declaredBefore + 1);
    expect(byLead(lead.early).map((d) => d.body.consumed)).toEqual([[{ outcomeKey: "linkedin_post_published", subjectService: "meta-service", subjectId: LATE_POST }]]);

    // The signups consume the visit each Unit's touch produced; the organic one consumes nothing of ours.
    await syncCrmEvidence(orgId, brandId);
    await sweepOutcomeFactDeclarations({ orgId });
    for (const k of ["reader", "scroller"]) {
      expect(byLead(lead[k]).filter((d) => d.body.produced[0].outcomeKey === "signup").map((d) => d.body.consumed), k).toEqual([
        [{ outcomeKey: "website_visit", subjectService: "lead-service", subjectId: lead[k] }],
      ]);
    }
    expect(byLead(lead.organic)).toEqual([]);
  });
});
