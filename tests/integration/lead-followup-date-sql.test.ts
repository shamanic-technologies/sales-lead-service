/**
 * LEAD-FOLLOWUP-DATE-1016 against a REAL database: every lead of a brand carries a next follow-up date, every send we
 * observe moves it (email and Unibox channels alike), a writer's statement wins as stated, and "Lead follow-up due"
 * hands a due person again each time their date passes again, never a client or a personal conversation.
 * The sender (email-gateway) is the one remote read, stated per test. Staff test addresses only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const queued = new Set<string>();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: vi.fn(async (_brandId: string, _campaignId: string | undefined, items: Array<{ email: string }>) => ({
    results: items.map(({ email }) => ({
      email,
      broadcast: { brand: { queued: queued.has(email), unsubscribed: false, bounced: false }, global: { email: { unsubscribed: false, bounced: false } } },
    })),
  })),
}));

const { db } = await import("../../src/db/index.js");
const { clearRegistry, connectionTag } = await import("../helpers/crm-registry.js");
const fd = await import("../../src/lib/lead-followup-date.js");
const { refreshActedAt } = await import("../../src/lib/their-acts.js");
const { listScopes } = await import("../../src/lib/relationship-subjects.js");
const { claimStockedLead } = await import("../../src/lib/source-stock.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

// Feed positions above anything another suite inserts (they draw seqs below 1e15).
let seq = BigInt(Date.now()) * 10_000n;
const nextSeq = () => (seq += 1n).toString();

describe.skipIf(!hasRealDatabase)("lead follow-up dates (LEAD-FOLLOWUP-DATE-1016)", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const sourceCampaignId = randomUUID();
  const followupCampaignId = randomUUID();
  const leads: string[] = [];

  async function person(name: string, opts: { email?: boolean; phone?: string } = {}): Promise<{ leadId: string; email: string | null; humanId: string; rowId: string }> {
    const humanId = randomUUID();
    const [row] = (await db.execute(sql`INSERT INTO leads (first_name, human_id) VALUES (${name}, ${humanId}::uuid) RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    leads.push(row.id);
    const email = opts.email === false ? null : `kevin+lfd-${name}-${randomUUID().slice(0, 6)}@distribute.you`;
    if (email) await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${row.id}::uuid, 'email', ${email}, 'itest')`);
    if (opts.phone) await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${row.id}::uuid, 'phone', ${opts.phone}, 'itest')`);
    const [lc] = (await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
      VALUES (${row.id}::uuid, ${`cold-${randomUUID()}`}, ${orgId}, ARRAY[${brandId}]::text[], 'served', now())
      RETURNING id::text AS id`)) as unknown as Array<{ id: string }>;
    return { leadId: row.id, email, humanId, rowId: lc.id };
  }

  async function dateOf(leadId: string) {
    return fd.loadFollowupDate(orgId, brandId, leadId);
  }

  /** crm-service reads these points as professional TO the brand (a relationship subject of the brand holds them; no thread to judge). */
  async function toBrandSubject(humanId: string, points: string[]) {
    await db.execute(sql`
      INSERT INTO relationship_subjects (org_id, brand_id, human_id, company_key, contact_points, has_direct)
      VALUES (${orgId}, ${brandId}, ${humanId}::uuid, '', ${sql.param(points)}::text[], false)
      ON CONFLICT (org_id, brand_id, human_id, company_key) DO UPDATE SET contact_points = excluded.contact_points`);
  }

  /** Jev's frozen answer "a person or a machine?" for one inbound message. */
  async function judgedHuman(factId: string, automated = false) {
    await db.execute(sql`
      INSERT INTO crm_act_judgments (fact_id, automated, probability, model) VALUES (${factId}, ${automated}, ${automated ? 0.97 : 0.03}, 'jev-itest')
      ON CONFLICT (fact_id) DO UPDATE SET automated = excluded.automated`);
  }

  /** crm-service judged this conversation NOT about the brand. */
  async function notAboutBrand(point: string) {
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, ${point}, '{}', '{}', 'connection_tag', 'none', 'crm', ${randomUUID()},
        ${JSON.stringify({ tag: "professional_not_to_brand", brandId, userIds: [], basis: [{ kind: "conversation", ref: point }] })}::jsonb, '{}'::jsonb)`);
  }

  async function setDue(leadId: string, at = "2026-01-01T00:00:00Z") {
    await db.execute(sql`UPDATE lead_followup_dates SET next_followup_at = ${at}::timestamptz WHERE org_id = ${orgId} AND brand_id = ${brandId} AND lead_id = ${leadId}::uuid`);
  }

  /** Something they did toward the brand, on their labelled timeline (a click to the site). */
  async function act(leadId: string) {
    await db.execute(sql`
      INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, label, source, source_ref, occurred_at, attribution_basis)
      VALUES (${`itest:${randomUUID()}`}, ${orgId}, ${brandId}, ${leadId}::uuid, 'website_visit', 'outreach', ${randomUUID()}, now(), 'reaction_to_our_email')`);
  }

  const serveDue = () =>
    fd.claimDueFollowupLead({
      orgId,
      brandId,
      brandIds: [brandId],
      sourceCampaignId,
      featureSlug: "lead-sourcing",
      runId: null,
      parentRunId: null,
      userId: null,
      workflowSlug: null,
      goal: null,
      activeGoalId: null,
      brandProfileId: null,
      acceptedEmails: "as_found",
    });

  const takeStock = () =>
    claimStockedLead({
      orgId,
      sourceCampaignIds: [sourceCampaignId],
      outreachCampaignId: followupCampaignId,
      brandIds: [brandId],
      featureSlug: "ai-follow-up",
      runId: `run-${randomUUID()}`,
      parentRunId: null,
      userId: null,
      workflowSlug: "follow-up",
      goal: null,
      activeGoalId: null,
      brandProfileId: null,
      reachableBy: ["email", "phone"],
      acceptedEmails: "as_found",
      askFit: async () => {
        throw new Error("a due find has no audience");
      },
      askDueOwed: (q) => fd.dueVerdict(q, {}),
    });

  beforeEach(() => queued.clear());

  afterAll(async () => {
    await db.execute(sql`DELETE FROM lead_followup_due_serves WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM lead_followup_dates WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await clearRegistry(orgId);
    for (const t of ["conversion_events", "relationship_subjects", "relationship_judgments", "crm_facts"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
    await db.execute(sql`DELETE FROM outreach_facts WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(leads)}::uuid[])`);
  });

  it("gives every lead of the brand a date, default now", async () => {
    const a = await person("a");
    const phoneOnly = await person("wa", { email: false, phone: "+33 6 11 22 33 44" });
    await fd.ensureLeadFollowupDates({ orgId, brandId });
    for (const p of [a, phoneOnly]) {
      const d = await dateOf(p.leadId);
      expect(d.basis).toBe("default");
      expect(Math.abs(new Date(d.nextFollowupAt!).getTime() - Date.now())).toBeLessThan(60_000);
    }
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n FROM leads_campaigns lc
      WHERE lc.org_id = ${orgId} AND NOT EXISTS (SELECT 1 FROM lead_followup_dates d WHERE d.org_id = lc.org_id AND d.brand_id = ${brandId} AND d.lead_id = lc.lead_id)
    `)) as unknown as Array<{ n: number }>;
    expect(rows[0].n).toBe(0);
  });

  it("moves the date on every send we observe: an email send and a WhatsApp message of ours", async () => {
    const emailed = await person("emailed");
    const wa = await person("wa2", { email: false, phone: "+33 6 99 88 77 66" });
    await fd.ensureLeadFollowupDates({ orgId, brandId });
    await fd.syncSendFeeds(30_000); // walk whatever is already there first

    await db.execute(sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, brand_ids, raw)
      VALUES (${nextSeq()}::bigint, ${`s:${randomUUID()}`}, 'email_sent', '2026-10-10T10:00:00Z', ${emailed.email!.toUpperCase()}, ${orgId}, ARRAY[${brandId}]::text[], '{}'::jsonb)`);
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, ${`phone:${randomUUID()}`}, ${`phone:${randomUUID()}`}, 'Wa Two', '{}', ARRAY['+33699887766']::text[],
        'message_out', '2026-10-11T08:00:00Z', 'sent_at', 'matrix', ${randomUUID()}, '{"channel":"whatsapp"}'::jsonb, '{}'::jsonb)`);
    await fd.syncSendFeeds(30_000);

    const e = await dateOf(emailed.leadId);
    expect(e).toMatchObject({ basis: "send", lastSentChannel: "email", nextFollowupAt: "2026-10-17T10:00:00.000Z", reason: "Last email send + 7 days" });
    const w = await dateOf(wa.leadId);
    expect(w).toMatchObject({ basis: "send", lastSentChannel: "whatsapp", nextFollowupAt: "2026-10-18T08:00:00.000Z", sentCount: 1 });

    // An OLDER send arriving late moves nothing.
    await fd.applySends([{ orgId, brandId, leadId: emailed.leadId, sentAt: "2026-10-01T00:00:00Z", channel: "email" }]);
    expect((await dateOf(emailed.leadId)).nextFollowupAt).toBe("2026-10-17T10:00:00.000Z");
  });

  it("keeps a writer's stated date: as stated, a later sequence step never shortens it, a stop ends the follow-ups", async () => {
    const p = await person("stated");
    await fd.ensureLeadFollowupDates({ orgId, brandId });
    const now = new Date();
    const j20 = new Date(now.getTime() + 20 * 86_400_000).toISOString();
    await fd.stateLeadFollowupDate({ orgId, brandId, leadId: p.leadId, statement: { kind: "date", nextFollowupAt: j20, reason: "after the last queued step" }, campaignId: "content-gen", runId: "r1" });
    // The J+3 step goes out after the statement: J+3+7 < J+20, the stated date stands.
    await fd.applySends([{ orgId, brandId, leadId: p.leadId, sentAt: new Date(now.getTime() + 1_000).toISOString(), channel: "email" }]);
    expect(await dateOf(p.leadId)).toMatchObject({ basis: "stated", nextFollowupAt: j20, reason: "after the last queued step", lastSentChannel: "email" });

    // A writer who just sent states "in 2 days": that is the date, even shorter than the default.
    const in2 = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const sentAt = new Date(Date.now() - 1_000).toISOString();
    await fd.stateLeadFollowupDate({ orgId, brandId, leadId: p.leadId, statement: { kind: "date", nextFollowupAt: in2, reason: "He waits for a price", sent: { channel: "whatsapp", at: sentAt } }, campaignId: "follow-up", runId: "r2" });
    // The observed copy of that same send arriving afterwards does not override the writer.
    await fd.applySends([{ orgId, brandId, leadId: p.leadId, sentAt, channel: "whatsapp" }]);
    expect(await dateOf(p.leadId)).toMatchObject({ basis: "stated", nextFollowupAt: in2, reason: "He waits for a price" });

    // Same run, same body: replayed, nothing changes.
    const replay = await fd.stateLeadFollowupDate({ orgId, brandId, leadId: p.leadId, statement: { kind: "date", nextFollowupAt: in2, reason: "He waits for a price", sent: { channel: "whatsapp", at: sentAt } }, campaignId: "follow-up", runId: "r2" });
    expect(replay.replayed).toBe(true);

    await expect(
      fd.stateLeadFollowupDate({ orgId, brandId, leadId: p.leadId, statement: { kind: "date", nextFollowupAt: "2020-01-01T00:00:00Z", reason: "x" }, campaignId: null, runId: null }),
    ).rejects.toMatchObject({ code: "date_out_of_range" });

    await fd.stateLeadFollowupDate({ orgId, brandId, leadId: p.leadId, statement: { kind: "stop", reason: "Please stop writing to me" }, campaignId: "follow-up", runId: "r3" });
    await fd.applySends([{ orgId, brandId, leadId: p.leadId, sentAt: new Date().toISOString(), channel: "email" }]);
    expect(await dateOf(p.leadId)).toMatchObject({ basis: "stopped", nextFollowupAt: null, reason: "Please stop writing to me" });
  });

  it("serves a due person, most overdue first, again each time the date passes again; never a client or a personal conversation", async () => {
    // Everyone of the earlier tests is pushed out: only the people of this test can be due.
    await db.execute(sql`UPDATE lead_followup_dates SET next_followup_at = now() + interval '300 days' WHERE org_id = ${orgId} AND basis <> 'stopped'`);
    const older = await person("older");
    const waOnly = await person("waonly", { email: false, phone: "+33 6 55 44 33 22" });
    const client = await person("client");
    const friend = await person("friend");
    await fd.ensureLeadFollowupDates({ orgId, brandId });
    await setDue(older.leadId, "2026-01-01T00:00:00Z");
    await setDue(waOnly.leadId, "2026-02-01T00:00:00Z");
    await setDue(client.leadId, "2025-01-01T00:00:00Z");
    await setDue(friend.leadId, "2025-02-01T00:00:00Z");
    for (const p of [older, client, friend]) await act(p.leadId);
    // The phone-only person wrote to us on WhatsApp: an act of theirs read off the Unibox facts, on a point crm-service
    // reads as professional to the brand, a person's words (LEADS-JUDGE-BRAND-1021).
    const waPoint = `phone:${randomUUID()}`;
    const waFact = randomUUID();
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${waFact}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, ${waPoint}, ${waPoint}, 'Wa Only', '{}', ARRAY['+33655443322']::text[],
        'message_in', '2026-10-01T08:00:00Z', 'sent_at', 'matrix', ${randomUUID()}, '{"channel":"whatsapp"}'::jsonb, '{}'::jsonb)`);
    await toBrandSubject(waOnly.humanId, [waPoint]);
    await judgedHuman(waFact);
    await fd.syncSendFeeds(30_000);
    await refreshActedAt({ orgId, brandId });
    await db.execute(sql`
      INSERT INTO conversion_events (org_id, brand_id, event, match_confidence, attribution_status, matched_lead_id, source)
      VALUES (${orgId}, ${brandId}, 'sale', 'exact', 'attributed', ${client.leadId}::uuid, 'manual')`);
    await db.execute(sql`INSERT INTO relationship_subjects (org_id, brand_id, human_id, has_direct) VALUES (${orgId}, ${brandId}, ${friend.humanId}::uuid, true)`);
    await db.execute(sql`
      INSERT INTO relationship_judgments (org_id, brand_id, human_id, probabilities, thread_seq, model, run_id)
      VALUES (${orgId}, ${brandId}, ${friend.humanId}::uuid, ${JSON.stringify({ prospect: 0.2 })}::jsonb, 1, 'jev', 'run')`);
    // Personal is crm-service's connection tag (PROFESSIONAL-LEADS-1017), never judged.
    await connectionTag({ orgId, brandId, human: friend.humanId, personKey: `itest:${friend.humanId}`, tag: "personal_to_user" });

    const first = await serveDue();
    expect(first?.leadId).toBe(older.leadId);
    expect(first?.email).toBe(older.email);
    const second = await serveDue();
    expect(second).toMatchObject({ leadId: waOnly.leadId, email: null, phone: "+33 6 55 44 33 22" });
    expect(await serveDue()).toBeNull();

    // The client and the friend were never served: their dates moved out with the reason.
    expect(await dateOf(client.leadId)).toMatchObject({ basis: "stop_recheck" });
    expect((await dateOf(client.leadId)).reason).toContain("customer");
    expect((await dateOf(friend.leadId)).reason).toContain("not_pure_prospect");
    // Served = 7 days out until the writer sends or states.
    const served = await dateOf(older.leadId);
    expect(served).toMatchObject({ basis: "served", servedCount: 1 });
    expect(new Date(served.nextFollowupAt!).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);

    // The follow-up pipe takes both from the stock, the phone-only one included.
    const t1 = await takeStock();
    const t2 = await takeStock();
    expect([t1.lead?.leadId, t2.lead?.leadId].sort()).toEqual([older.leadId, waOnly.leadId].sort());
    expect([t1.lead, t2.lead].find((l) => l?.leadId === waOnly.leadId)).toMatchObject({ email: null, phone: "+33 6 55 44 33 22" });
    expect((await takeStock()).lead).toBeNull();

    // Their date passes again: served again (the source row re-opened), handed again (the follow-up row re-served).
    await setDue(older.leadId);
    const again = await serveDue();
    expect(again?.leadId).toBe(older.leadId);
    expect(again?.leadCampaignId).toBe(first?.leadCampaignId);
    const t3 = await takeStock();
    expect(t3.lead?.leadId).toBe(older.leadId);
    const rounds = (await db.execute(sql`
      SELECT count(*)::int AS n FROM lead_followup_due_serves WHERE org_id = ${orgId} AND lead_id = ${older.leadId}::uuid AND handed_at IS NOT NULL
    `)) as unknown as Array<{ n: number }>;
    expect(rounds[0].n).toBe(2);
    expect((await dateOf(older.leadId)).servedCount).toBe(2);
    const repoints = (await db.execute(sql`
      SELECT count(*)::int AS n FROM lead_campaign_run_repoints r JOIN leads_campaigns lc ON lc.id = r.lead_campaign_id
      WHERE lc.lead_id = ${older.leadId}::uuid AND r.cause = 'followup_due'
    `)) as unknown as Array<{ n: number }>;
    expect(repoints[0].n).toBe(2); // source row re-opened + follow-up row re-served
  });

  it("a find no longer owed at handover is set aside and its date pushed out; never handed", async () => {
    await db.execute(sql`UPDATE lead_followup_dates SET next_followup_at = now() + interval '300 days' WHERE org_id = ${orgId} AND basis <> 'stopped'`);
    const later = await person("later");
    await fd.ensureLeadFollowupDates({ orgId, brandId });
    await setDue(later.leadId);
    await act(later.leadId);
    expect((await serveDue())?.leadId).toBe(later.leadId);
    queued.add(later.email!); // a sequence started meanwhile: not yet
    const t = await takeStock();
    expect(t.lead).toBeNull();
    expect(t.setAside.map((r) => r.leadId)).toEqual([later.leadId]);
    expect(await dateOf(later.leadId)).toMatchObject({ basis: "not_yet" });
    // Once due again and owed, served again.
    queued.clear();
    await setDue(later.leadId);
    expect((await serveDue())?.leadId).toBe(later.leadId);
  });

  it("never serves a lead who did nothing toward the brand (only emailed, or never contacted), until they act", async () => {
    await db.execute(sql`UPDATE lead_followup_dates SET next_followup_at = now() + interval '300 days' WHERE org_id = ${orgId} AND basis <> 'stopped'`);
    const emailedOnly = await person("emailedonly");
    const never = await person("nevercontacted");
    await fd.ensureLeadFollowupDates({ orgId, brandId });
    await fd.applySends([{ orgId, brandId, leadId: emailedOnly.leadId, sentAt: "2026-09-01T10:00:00Z", channel: "email" }]);
    await setDue(emailedOnly.leadId);
    await setDue(never.leadId);
    expect(await serveDue()).toBeNull();
    expect(await dateOf(emailedOnly.leadId)).toMatchObject({ actedTowardUs: false, lastSentChannel: "email" });
    // Untouched: their date stays, nothing set aside, nothing postponed.
    expect((await dateOf(never.leadId)).nextFollowupAt).toBe("2026-01-01T00:00:00.000Z");
    expect((await fd.dueVerdict({ orgId, brandId, leadId: emailedOnly.leadId }, {})).reason).toBe("no_action_toward_us");

    // LEADS-JUDGE-BRAND-1021: an out-of-office (judged automatic) and a message in a conversation crm-service judged NOT
    // about this brand are no act toward it. Both land on the person's Gmail point; nothing is served.
    const gmailPoint = `gmail:${emailedOnly.email}`;
    const ooo = randomUUID();
    const offBrand = randomUUID();
    const insertMessage = (factId: string, point: string, at: string, payload: Record<string, unknown>) =>
      db.execute(sql`
        INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
        -- Above every seq in the shared table: another suite's higher seq would carry the feed cursor past this fact.
        VALUES (${factId}, GREATEST(${nextSeq()}::bigint, (SELECT COALESCE(max(seq), 0) + 1 FROM crm_facts)), ${orgId}, ${brandId}, ${point}, ${point}, 'Emailed Only', ARRAY[${emailedOnly.email}]::text[], '{}',
          'message_in', ${at}::timestamptz, 'sent_at', ${point.split(":")[0]}, ${randomUUID()}, ${JSON.stringify(payload)}::jsonb, '{}'::jsonb)`);
    await insertMessage(ooo, gmailPoint, "2026-09-20T08:00:00Z", { channel: "email", subject: "Automatic reply: out of office", text: "I am out of the office." });
    await toBrandSubject(emailedOnly.humanId, [gmailPoint]);
    await judgedHuman(ooo, true);
    await fd.syncSendFeeds(30_000);
    await refreshActedAt({ orgId, brandId });
    expect(await dateOf(emailedOnly.leadId)).toMatchObject({ actedTowardUs: false });
    expect(await serveDue()).toBeNull();
    const otherPoint = `gmail:other-${randomUUID().slice(0, 6)}@distribute.you`;
    await insertMessage(offBrand, otherPoint, "2026-09-21T08:00:00Z", { channel: "email", text: "How do you handle these dinner events?" });
    await toBrandSubject(emailedOnly.humanId, [gmailPoint, otherPoint]);
    await judgedHuman(offBrand);
    await notAboutBrand(otherPoint);
    await fd.syncSendFeeds(30_000);
    await refreshActedAt({ orgId, brandId });
    expect(await dateOf(emailedOnly.leadId)).toMatchObject({ actedTowardUs: false });
    expect(await serveDue()).toBeNull();

    // ONE-AI-CONVERSES-1029-LEADFACTS: our server tying a newsletter link to them (mail scanners fire it too) is our own
    // instrumentation, never an act of theirs, even on a point of the brand.
    const waPoint = `email:${emailedOnly.email}`;
    const identified = randomUUID();
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${identified}, GREATEST(${nextSeq()}::bigint, (SELECT COALESCE(max(seq), 0) + 1 FROM crm_facts)), ${orgId}, ${brandId}, ${waPoint}, ${waPoint}, 'Emailed Only', ARRAY[${emailedOnly.email}]::text[], '{}',
        'product_event', '2026-09-22T08:00:00Z'::timestamptz, 'created_at', 'posthog', ${randomUUID()},
        ${JSON.stringify({ event: "newsletter_link_identified", text: "Newsletter link identified", properties: { source: "server" } })}::jsonb, '{}'::jsonb)`);
    await toBrandSubject(emailedOnly.humanId, [gmailPoint, otherPoint, waPoint]);
    await fd.syncSendFeeds(30_000);
    await refreshActedAt({ orgId, brandId });
    expect(await dateOf(emailedOnly.leadId)).toMatchObject({ actedTowardUs: false });
    expect(await serveDue()).toBeNull();

    // They write to us once on WhatsApp (matched by email here), a person's words on a point of the brand: served.
    const written = randomUUID();
    await insertMessage(written, waPoint, "2026-10-02T08:00:00Z", { channel: "whatsapp" });
    await toBrandSubject(emailedOnly.humanId, [gmailPoint, otherPoint, waPoint]);
    await fd.syncSendFeeds(30_000);
    await refreshActedAt({ orgId, brandId });
    // Not judged yet = not counted (fail closed), then judged a person's words = counted.
    expect(await dateOf(emailedOnly.leadId)).toMatchObject({ actedTowardUs: false });
    await judgedHuman(written);
    await refreshActedAt({ orgId, brandId });
    expect(await dateOf(emailedOnly.leadId)).toMatchObject({ actedTowardUs: true, lastActionAt: "2026-10-02T08:00:00.000Z" });
    // The worker's fleet pass (BOX-OVERLOAD-1026) walks the scopes one by one and lands on the same answer.
    await db.execute(sql`UPDATE lead_followup_dates SET last_action_at = NULL WHERE org_id = ${orgId} AND brand_id = ${brandId}`);
    await refreshActedAt(null);
    expect(await dateOf(emailedOnly.leadId)).toMatchObject({ actedTowardUs: true, lastActionAt: "2026-10-02T08:00:00.000Z" });
    // The relationship sweep's scope list (a skip scan) is the DISTINCT it replaced, in the same order.
    await db.execute(sql`
      INSERT INTO crm_registry_facts (fact_id, seq, org_id, brand_id, person_key, emails, phones, type, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${nextSeq()}::bigint, ${orgId}, ${brandId}, ${`itest:${randomUUID()}`}, '{}', '{}', 'relation', 'none', 'crm', ${randomUUID()},
        ${JSON.stringify({ relationKey: randomUUID() })}::jsonb, '{}'::jsonb)`);
    const distinct = (await db.execute(sql`
      SELECT DISTINCT org_id, brand_id FROM crm_registry_facts WHERE type = 'relation' ORDER BY org_id, brand_id
    `)) as unknown as Array<{ org_id: string; brand_id: string }>;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    expect(await listScopes()).toEqual(
      distinct.filter((r) => UUID.test(r.org_id) && UUID.test(r.brand_id)).map((r) => ({ orgId: r.org_id, brandId: r.brand_id })),
    );
    expect((await listScopes()).some((x) => x.orgId === orgId && x.brandId === brandId)).toBe(true);
    expect((await serveDue())?.leadId).toBe(emailedOnly.leadId);
    // The never-contacted one: an open, an auto-reply and an Instantly-reported click prove nothing (machines).
    const machine = async (label: string, sourceRef: string) =>
      db.execute(sql`
        INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, label, source, source_ref, occurred_at, attribution_basis)
        VALUES (${`itest:${randomUUID()}`}, ${orgId}, ${brandId}, ${never.leadId}::uuid, ${label}, 'outreach', ${sourceRef}, now(), 'reaction_to_our_email')`);
    await machine("opened", randomUUID());
    await machine("auto_reply", randomUUID());
    const unverified = `ievt:${randomUUID()}`;
    await db.execute(sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, brand_ids, raw)
      VALUES (${nextSeq()}::bigint, ${unverified}, 'link_clicked', now(), ${never.email}, ${orgId}, ARRAY[${brandId}]::text[], '{"transport":"instantly"}'::jsonb)`);
    await machine("website_visit", unverified);
    expect(await serveDue()).toBeNull();
    // A click our own tracker classified human counts.
    const human = `ievt:${randomUUID()}`;
    await db.execute(sql`
      INSERT INTO outreach_facts (seq, subject_key, type, occurred_at, lead_email, org_id, brand_ids, raw)
      VALUES (${nextSeq()}::bigint, ${human}, 'link_clicked', now(), ${never.email}, ${orgId}, ARRAY[${brandId}]::text[], '{"transport":"smtp"}'::jsonb)`);
    await machine("website_visit", human);
    expect((await serveDue())?.leadId).toBe(never.leadId);
  });
});
