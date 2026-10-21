/**
 * UNIBOX-SIX-TAGS-1017 against a REAL database: the brand's Unibox rows = the people crm-service tags professional to
 * the brand (nobody else), each with its six dimensions read off their owners, the Lifecycle ranked on
 * features-service's ladder (a failed charge reaches no rung), the list filtered on the dimensions and paged, and the
 * lead card naming every campaign with the furthest step in it.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const catalogue = {
  object: "step",
  lifecycleLadder: [
    { key: "lead_found", rank: 1, label: "Lead found" },
    { key: "contacted", rank: 2, label: "Contacted" },
    { key: "engaged", rank: 3, label: "Engaged" },
    { key: "signup_or_form", rank: 4, label: "Signed up" },
    { key: "meeting_booked", rank: 5, label: "Meeting booked" },
    { key: "meeting_attended", rank: 6, label: "Meeting attended" },
    { key: "paid_client", rank: 7, label: "Paid client" },
  ],
  rows: [
    ["lead_found", 1], ["email_sent", 2], ["conversation", 3], ["website_visit", 3], ["signup", 4], ["form_submitted", 4],
    ["meeting_booked", 5], ["meeting_attended", 6], ["paid_client", 7], ["purchase", 7],
  ].map(([key, lifecycleRank]) => ({ key, lifecycleRank })),
};
/** crm-service's latest message per relation, keyed by the human the relation key names (set by the test). */
const latestByHuman = new Map<string, Record<string, unknown>>();
const latestAsked: string[][] = [];
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string, init?: { body?: string }) => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    const u = String(url);
    if (u.endsWith("/public/catalogue/steps")) return json(catalogue);
    if (u.endsWith("/internal/people/relations/latest-messages")) {
      const { relationKeys } = JSON.parse(String(init?.body)) as { relationKeys: string[] };
      latestAsked.push(relationKeys);
      return json({
        relations: relationKeys.map((relationKey) => {
          const message = [...latestByHuman.entries()].find(([h]) => relationKey.includes(h))?.[1] ?? null;
          return { relationKey, status: message ? "message" : "no_message", reason: null, message, gaps: [] };
        }),
      });
    }
    // campaign-service: the cold pipe is a unit of a sales funnel campaign the customer named; the webinar is not.
    if (u.includes("/sales-funnel-campaigns?")) {
      return json({ salesFunnelCampaigns: [{ id: "sfc-1", salesFunnelName: "Cold email to meeting", units: [{ campaignId: "camp-cold" }] }] });
    }
    // GET /campaigns (org-scoped, DEALS-LIFECYCLE-1021 scope): the cold pipe sells offer-1, the webinar offer-2.
    if (u.endsWith("/campaigns")) {
      return json({ campaigns: [
        { id: "camp-cold", offerId: "offer-1" },
        { id: "camp-webinar", offerId: "offer-2" },
      ] });
    }
    if (u.includes("/campaigns?")) return json({ campaigns: [{ id: "camp-cold", name: "pipe: cold email" }, { id: "camp-webinar", name: "Webinar" }] });
    throw new Error(`unexpected fetch ${u}`);
  },
}));
vi.mock("../../src/lib/company-client.js", () => ({
  MAX_COMPANIES_PER_REQUEST: 1000,
  getCompanies: async (ids: string[]) => ids.map((brandId) => ({ brandId, name: "Acme", domain: "acme.com" })),
  CompanyServiceError: class extends Error {},
}));

const { db } = await import("../../src/db/index.js");
const { clearRegistry, connectionTag, organizationLink, relation } = await import("../helpers/crm-registry.js");
const { readThread, toSubject } = await import("../../src/lib/relationship-subjects.js");
const { refreshSubjects } = await import("../../src/lib/relationship-subjects.js");
const { writeEvidence } = await import("../../src/lib/relationship-judge.js");
const { refreshUniboxRows, readUniboxPage, readUniboxLead, readUniboxLifecycleCounts, resetLifecycleCatalogueCache } = await import("../../src/lib/unibox-model.js");
const { resolveUniboxScope } = await import("../../src/lib/unibox-scope.js");

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

describe.skipIf(!hasRealDatabase)("unibox read model", () => {
  const orgId = randomUUID();
  const brandId = randomUUID();
  const scope = { orgId, brandId };
  const ana = randomUUID(); // cold-emailed lead: sent, visited, replied interested; wrong person
  const ben = randomUUID(); // CRM person: signed up, a FAILED charge, wrote to us
  const friend = randomUUID(); // personal only: never a Unibox lead
  const createdLeads: string[] = [];
  const createdOrgs: string[] = [];
  let seq = BigInt(Date.now()) * 1000n + 900_000_000n;

  async function crmFact(personKey: string, human: string, type: string, at: string, payload: Record<string, unknown> = {}): Promise<void> {
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, ${personKey}, ${personKey}, 'Ben', ARRAY['ben@acme.io']::text[], '{}'::text[], ${type},
        ${at}::timestamptz, 'event', 'stripe', ${randomUUID()}, ${JSON.stringify(payload)}::jsonb, ${JSON.stringify({ humanId: human })}::jsonb)
    `);
  }

  afterAll(async () => {
    await clearRegistry(orgId);
    await db.execute(sql`DELETE FROM leads_campaigns WHERE org_id = ${orgId}`);
    await db.execute(sql`DELETE FROM leads WHERE id = ANY(${sql.param(createdLeads)}::uuid[])`);
    await db.execute(sql`DELETE FROM organizations WHERE id = ANY(${sql.param(createdOrgs)}::uuid[])`);
    for (const t of ["crm_facts", "relationship_subjects", "relationship_evidence", "lead_timeline_facts", "lead_disqualification_marks", "unibox_rows"]) {
      await db.execute(sql`DELETE FROM ${sql.raw(t)} WHERE org_id = ${orgId}`);
    }
  });

  it("builds one row per professional person with the six dimensions; a failed charge is no paid client", async () => {
    resetLifecycleCatalogueCache();
    await connectionTag({ orgId, brandId, human: ana, personKey: "email:ana@x.io", name: "Ana", emails: ["ana@x.io"] });
    await connectionTag({ orgId, brandId, human: ben, personKey: "email:ben@acme.io", name: "Ben", emails: ["ben@acme.io"] });
    await connectionTag({ orgId, brandId, human: friend, personKey: "matrix:f", name: "Friend", tag: "personal_to_user" });
    const anaCompany = randomUUID();
    await organizationLink({ orgId, brandId, human: ana, personKey: "email:ana@x.io", companyId: anaCompany });

    // Sourced with her name and title (UNIBOX-PERSON-NAME-1021): the row names her, never her address.
    const [lead] = (await db.execute(sql`
      INSERT INTO leads (first_name, last_name, name, human_id) VALUES ('Ana', 'Lopez', 'Ana Lopez', ${ana}::uuid) RETURNING id::text`)) as unknown as Array<{ id: string }>;
    createdLeads.push(lead.id);
    const [employer] = (await db.execute(sql`INSERT INTO organizations (name) VALUES ('Acme') RETURNING id::text`)) as unknown as Array<{ id: string }>;
    createdOrgs.push(employer.id);
    await db.execute(sql`INSERT INTO leads_organizations (lead_id, organization_id, title, current) VALUES (${lead.id}::uuid, ${employer.id}::uuid, 'Head of Sales', true)`);
    // The relation's leads are the ones on ITS addresses (PERSON-RELATIONS-1017).
    await db.execute(sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${lead.id}::uuid, 'email', 'ana@x.io', 'itest')`);
    await db.execute(sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, served_at)
      VALUES (${lead.id}::uuid, 'camp-cold', ${orgId}, ${sql.param([brandId])}::text[], 'served', '2026-10-01T09:00:00Z'),
             (${lead.id}::uuid, 'camp-webinar', ${orgId}, ${sql.param([brandId])}::text[], 'served', '2026-10-05T09:00:00Z'),
             (${lead.id}::uuid, ${`signups:${brandId}`}, ${orgId}, ${sql.param([brandId])}::text[], 'served', '2026-10-06T09:00:00Z')`);
    for (const [label, at, campaign] of [
      ["initial_email", "2026-10-01T10:00:00Z", "camp-cold"],
      ["website_visit", "2026-10-02T10:00:00Z", "camp-cold"],
      ["interested", "2026-10-03T10:00:00Z", "camp-cold"],
    ] as const) {
      await db.execute(sql`
        INSERT INTO lead_timeline_facts (id, org_id, brand_id, lead_id, campaign_id, label, source, source_ref, occurred_at)
        VALUES (${`itest:${randomUUID()}`}, ${orgId}, ${brandId}, ${lead.id}::uuid, ${campaign}, ${label}, 'outreach', ${randomUUID()}, ${at}::timestamptz)`);
    }
    await db.execute(sql`
      INSERT INTO lead_disqualification_marks (org_id, brand_id, lead_id, offer_key, source, note, stated_by_user_id)
      VALUES (${orgId}, ${brandId}, ${lead.id}::uuid, '', 'manual', 'left the company', 'itest')`);

    await crmFact("email:ben@acme.io", ben, "signup", "2026-10-04T10:00:00Z");
    await crmFact("email:ben@acme.io", ben, "payment", "2026-10-05T10:00:00Z", { status: "failed", amountMinor: 9900, amountRefunded: 0 });
    await crmFact("email:ben@acme.io", ben, "message_in", "2026-10-06T10:00:00Z", { text: "any news?" });

    // UNIBOX-LAST-MESSAGE-PREVIEW-1021: our latest email to Ana (quoted history below it), Ben's own WhatsApp.
    const msg = (over: Record<string, unknown>) => ({
      source: "instantly", channel: "email", direction: "outbound", sentBy: "automation", subject: null, textBasis: "original",
      textCleanStatus: null, textTruncated: false, from: null, ref: {}, ...over,
    });
    latestByHuman.set(ana, msg({
      at: "2026-10-03T12:00:00.000Z", subject: "Re: Data, not docs",
      text: "Last note from me, Ana.\n\nIf a call feels like too much right now, there's a lighter option.\n\nOn Fri, Oct 3, 2026 at 10:00 AM Ana <ana@x.io> wrote:\n> interested",
    }));
    latestByHuman.set(ben, msg({ at: "2026-10-06T10:00:00.000Z", source: "matrix", channel: "whatsapp", direction: "inbound", sentBy: null, text: "any news?", textBasis: "as_written" }));

    await refreshSubjects(scope);
    await writeEvidence(scope);
    const built = await refreshUniboxRows(scope);
    expect(built.rows).toBe(2);

    const page = await readUniboxPage(scope, {}, { limit: 10, cursor: null });
    expect(page.total).toBe(2);
    expect(page.rows.map((r) => r.humanId)).toEqual([ben, ana]); // most recent activity first
    const [benRow, anaRow] = page.rows;
    expect(benRow).toMatchObject({
      status: "prospect",
      roles: [],
      types: ["prospect"], // a signup is prospect evidence; the failed charge makes no customer
      lifecycle: { key: "signup_or_form", rank: 4 },
      conversation: "waiting_on_us",
      contactability: "contactable",
      fit: "fit",
    });
    expect(benRow.steps.map((s) => s.step)).toEqual(["signup"]);
    expect(benRow.personKeys).toEqual(["email:ben@acme.io"]);
    expect(benRow.company).toBeNull();
    expect(anaRow).toMatchObject({ lifecycle: { key: "engaged", rank: 3 }, fit: "wrong_person", fitNote: "left the company", conversation: "waiting_on_us" }); // replied after our email
    // "Ana @ Acme": the relation's company, named by brand-service.
    expect(anaRow.company).toMatchObject({ name: "Acme", domain: "acme.com" });
    // Her name and title as sourced, not crm's "Ana" nor her address; Ben has no lead: crm's name.
    expect(anaRow).toMatchObject({ name: "Ana Lopez", firstName: "Ana", lastName: "Lopez", title: "Head of Sales" });
    expect(benRow).toMatchObject({ name: "Ben", firstName: null, lastName: null, title: null });
    expect(anaRow.steps.map((s) => s.step)).toEqual(["lead_found", "email_sent", "conversation", "website_visit"]);
    // DEALS-LIFECYCLE-1021: each row names the campaigns that reached the person, as the card names them, most recent first;
    // the signup filing is no campaign; Ben (a CRM person) is a lead of none.
    expect(anaRow.campaigns).toEqual([
      { campaignId: "camp-webinar", name: "Webinar", pipeCampaignIds: ["camp-webinar"], servedAt: "2026-10-05T09:00:00.000Z" },
      { campaignId: "sfc-1", name: "Cold email to meeting", pipeCampaignIds: ["camp-cold"], servedAt: "2026-10-01T09:00:00.000Z" },
    ]);
    expect(anaRow.campaignsReason).toBeNull();
    expect(benRow).toMatchObject({ campaigns: [], campaignsReason: null });
    // The first words of each thread's last message, who wrote it, by which channel (crm-service's thread).
    expect(anaRow.lastMessage).toEqual({
      at: "2026-10-03T12:00:00.000Z", side: "ours", sentBy: "automation", channel: "email", source: "instantly", subject: "Re: Data, not docs",
      preview: "Last note from me, Ana. If a call feels like too much right now, there's a lighter option.",
    });
    expect(benRow).toMatchObject({ lastMessage: { side: "theirs", sentBy: null, channel: "whatsapp", preview: "any news?" }, lastMessageReason: null });

    // Settled rows are not asked again on the next pass; their preview stays served.
    latestAsked.length = 0;
    await refreshUniboxRows(scope);
    expect(latestAsked.flat()).toEqual([]);
    expect((await readUniboxPage(scope, {}, { limit: 10, cursor: null })).rows[1].lastMessage?.preview).toMatch(/^Last note from me, Ana\./);
  });

  it("filters on any dimension, pages with a cursor, and refuses nothing it served", async () => {
    expect((await readUniboxPage(scope, { lifecycle: ["engaged"] }, { limit: 10, cursor: null })).rows.map((r) => r.humanId)).toEqual([ana]);
    expect((await readUniboxPage(scope, { status: ["prospect", "churned"] }, { limit: 10, cursor: null })).total).toBe(2);
    expect((await readUniboxPage(scope, { status: ["customer"] }, { limit: 10, cursor: null })).total).toBe(0);
    expect((await readUniboxPage(scope, { fit: ["fit"], conversation: ["waiting_on_us"] }, { limit: 10, cursor: null })).total).toBe(1);
    expect((await readUniboxPage(scope, { lifecycle: ["none", "paid_client"] }, { limit: 10, cursor: null })).total).toBe(0);
    expect((await readUniboxPage(scope, { q: "BEN@acme" }, { limit: 10, cursor: null })).rows.map((r) => r.humanId)).toEqual([ben]);
    const first = await readUniboxPage(scope, {}, { limit: 1, cursor: null });
    expect(first.nextCursor).not.toBeNull();
    const second = await readUniboxPage(scope, {}, { limit: 1, cursor: first.nextCursor });
    expect(second.rows.map((r) => r.humanId)).toEqual([ana]);
    expect(second.nextCursor).toBeNull();
  });

  it("an offer / campaign scope keeps only its leads; counts per rung sum to the scoped total and narrow with the filters (DEALS-LIFECYCLE-1021)", async () => {
    const sum = (c: { byLifecycle: Record<string, number> }) => Object.values(c.byLifecycle).reduce((a, b) => a + b, 0);
    const all = await readUniboxLifecycleCounts(scope, {});
    expect(all.total).toBe(2);
    expect(sum(all)).toBe(all.total);
    expect(all.byLifecycle).toEqual({ lead_found: 0, contacted: 0, engaged: 1, signup_or_form: 1, meeting_booked: 0, meeting_attended: 0, paid_client: 0, none: 0 });

    const ctx = { orgId, brandId };
    const offer1 = await resolveUniboxScope(ctx, { offerId: "offer-1" });
    expect(offer1).toEqual(["camp-cold"]);
    expect(await resolveUniboxScope(ctx, { campaignId: "sfc-1" })).toEqual(["camp-cold", "sfc-1"]);
    expect(await resolveUniboxScope(ctx, {})).toBeUndefined();
    // Ana was served under the cold pipe (offer-1); Ben is a CRM person, no lead of any campaign.
    const scoped = await readUniboxPage(scope, { campaignIds: offer1 }, { limit: 10, cursor: null });
    expect(scoped.rows.map((r) => r.humanId)).toEqual([ana]);
    expect(scoped.total).toBe(1);
    // Her Lifecycle stays the brand's.
    expect(scoped.rows[0].lifecycle?.key).toBe("engaged");
    // Her campaigns narrow to the scope's (the webinar sells another offer); same name as on her card.
    expect(scoped.rows[0].campaigns?.map((c) => [c.campaignId, c.name])).toEqual([["sfc-1", "Cold email to meeting"]]);
    const card = await readUniboxLead(scope, ana);
    for (const rowCampaign of (await readUniboxPage(scope, {}, { limit: 10, cursor: null })).rows.find((r) => r.humanId === ana)!.campaigns!) {
      expect(card!.campaigns.find((c) => c.campaignId === rowCampaign.campaignId)).toMatchObject({ name: rowCampaign.name, pipeCampaignIds: rowCampaign.pipeCampaignIds, servedAt: rowCampaign.servedAt });
    }
    const scopedCounts = await readUniboxLifecycleCounts(scope, { campaignIds: offer1 });
    expect(scopedCounts).toMatchObject({ total: 1, byLifecycle: { engaged: 1, signup_or_form: 0, none: 0 } });
    expect(sum(scopedCounts)).toBe(scoped.total);
    // An offer no campaign sells = nobody (never the brand).
    expect(await resolveUniboxScope(ctx, { offerId: "offer-3" })).toEqual([]);
    expect((await readUniboxLifecycleCounts(scope, { campaignIds: [] })).total).toBe(0);
    expect((await readUniboxPage(scope, { campaignIds: [] }, { limit: 10, cursor: null })).total).toBe(0);

    // Filters narrow the counts exactly as they narrow the list.
    for (const f of [{ fit: ["fit"] }, { fit: ["wrong_person"] }, { interest: ["interested"] }, { conversation: ["waiting_on_us"] }, { contactability: ["bounced"] }]) {
      const c = await readUniboxLifecycleCounts(scope, f);
      const p = await readUniboxPage(scope, f, { limit: 50, cursor: null });
      expect(c.total).toBe(p.total);
      expect(sum(c)).toBe(p.total);
      for (const [key, n] of Object.entries(c.byLifecycle)) expect(p.rows.filter((r) => (r.lifecycle?.key ?? "none") === key)).toHaveLength(n);
    }
    expect((await readUniboxLifecycleCounts(scope, { fit: ["fit"] })).byLifecycle).toMatchObject({ signup_or_form: 1, engaged: 0 });
    // A board column = the list filtered on its rung.
    expect((await readUniboxPage(scope, { campaignIds: offer1, lifecycle: ["engaged"] }, { limit: 10, cursor: null })).rows.map((r) => r.humanId)).toEqual([ana]);
  });

  it("the lead card names every campaign with its furthest step; a non-lead has no card", async () => {
    const card = await readUniboxLead(scope, ana);
    // At the grain the customer knows (the funnel campaign, named); a signup filing is no campaign.
    expect(card!.campaigns.map((c) => [c.campaignId, c.name, c.pipeCampaignIds, c.furthest?.key])).toEqual([
      ["sfc-1", "Cold email to meeting", ["camp-cold"], "engaged"],
      ["camp-webinar", "Webinar", ["camp-webinar"], "lead_found"],
    ]);
    expect(await readUniboxLead(scope, friend)).toBeNull();
  });

  it("a CRM former client reads churned; a later client stage reads customer again (owner 2026-10-17)", async () => {
    await crmFact("email:ben@acme.io", ben, "client", "2026-10-07T10:00:00Z");
    await crmFact("email:ben@acme.io", ben, "former_client", "2026-10-07T10:00:00Z");
    await refreshUniboxRows(scope);
    expect((await readUniboxPage(scope, { status: ["churned"] }, { limit: 10, cursor: null })).rows.map((r) => r.humanId)).toEqual([ben]);
    await crmFact("email:ben@acme.io", ben, "client", "2026-10-09T10:00:00Z");
    await refreshUniboxRows(scope);
    expect((await readUniboxPage(scope, { status: ["customer"] }, { limit: 10, cursor: null })).rows.map((r) => r.humanId)).toEqual([ben]);
  });

  it("a person crm stops tagging professional leaves the Unibox", async () => {
    const tagFact = (await db.execute(sql`
      SELECT fact_id FROM crm_registry_facts WHERE org_id = ${orgId} AND raw->>'humanId' = ${ben} AND type = 'connection_tag'`)) as unknown as Array<{ fact_id: string }>;
    const { withdrawRegistryFact } = await import("../helpers/crm-registry.js");
    await withdrawRegistryFact({ orgId, brandId, factId: tagFact[0].fact_id });
    await refreshSubjects(scope);
    const r = await refreshUniboxRows(scope);
    expect(r).toMatchObject({ rows: 1, removed: 1 });
  });

  it("a friend with a personal chat and a work address = ONE row, the work relation, whose thread holds no personal message (PERSON-RELATIONS-1017)", async () => {
    const adam = randomUUID();
    const cifacom = randomUUID();
    // crm reads Adam's points one by one: his WhatsApp chat with the founder is personal, his work address professional.
    await relation({ orgId, brandId, human: adam, personKey: "email:adam@cifacom.com", capacity: "personal", tags: ["personal_to_user"], companyId: null, contactPoints: ["matrix:@adam"], name: "Adam" });
    await relation({ orgId, brandId, human: adam, personKey: "email:adam@cifacom.com", capacity: "professional", tags: ["professional_to_brand"], companyId: cifacom, contactPoints: ["clerk:user_adam"], emails: ["adam@cifacom.com"], name: "Adam Nasri" });
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, 'email:adam@cifacom.com', 'matrix:@adam', 'Adam', '{}'::text[], '{}'::text[], 'message_in',
        '2026-10-10T10:00:00Z', 'sent_at', 'matrix', ${randomUUID()}, '{"text":"dinner tonight?"}'::jsonb, ${JSON.stringify({ humanId: adam })}::jsonb)`);
    seq += 1n;
    await db.execute(sql`
      INSERT INTO crm_facts (fact_id, seq, org_id, brand_id, person_key, contact_point, full_name, emails, phones, type, occurred_at, date_basis, source, source_ref, payload, raw)
      VALUES (${randomUUID()}, ${seq.toString()}::bigint, ${orgId}, ${brandId}, 'email:adam@cifacom.com', 'clerk:user_adam', 'Adam Nasri', ARRAY['adam@cifacom.com']::text[], '{}'::text[], 'signup',
        '2026-10-09T10:00:00Z', 'created_at', 'clerk', ${randomUUID()}, '{}'::jsonb, ${JSON.stringify({ humanId: adam })}::jsonb)`);
    await refreshSubjects(scope);
    await refreshUniboxRows(scope);
    const rows = (await readUniboxPage(scope, {}, { limit: 50, cursor: null })).rows.filter((r) => r.humanId === adam);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ companyKey: cifacom, relationKey: `rel:${adam}:org:${cifacom}`, emails: ["adam@cifacom.com"], lastTheirsAt: "2026-10-09T10:00:00.000Z" });
    expect(rows[0].connectionTags).toEqual(["professional_to_brand"]);
    expect(rows[0].steps.map((x) => x.step)).toEqual(["signup"]);
    const subject = (await db.execute(sql`SELECT * FROM relationship_subjects WHERE org_id = ${orgId} AND human_id = ${adam}::uuid`)) as unknown as Array<Record<string, unknown>>;
    expect(subject).toHaveLength(1);
    const thread = await readThread(toSubject(subject[0]));
    expect(thread.map((l) => l.kind)).toEqual(["signup"]); // "dinner tonight?" is the personal relation's, never here
    expect((await readUniboxLead(scope, null, `rel:${adam}:org:${cifacom}`))!.lead.humanId).toBe(adam);
    expect(await readUniboxLead(scope, null, `rel:${adam}:pro`)).toBeNull();
  });
});
