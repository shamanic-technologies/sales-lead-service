/**
 * Provider reads of our Units against a REAL database (ENGINE-GET-ASK-1123): GET /orgs/units/<outcome>.
 *
 * Seeds its own rows under its own org. Proves, through the routes: each read returns the seeded Units and nothing
 * else (never a re-hand, a journalist, another org); brand / person / since / until / campaign filters; `notServedTo`;
 * paging to the last page; an unknown person = 200 empty; and that a read writes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";

const { sql } = await import("../../src/db/index.js");
const router = (await import("../../src/routes/provider-units.js")).default;

const PLACEHOLDER_DSN = "postgresql://test:test@localhost:5432/test";
const hasRealDatabase = process.env.LEAD_SERVICE_DATABASE_URL !== PLACEHOLDER_DSN;

type Unit = Record<string, unknown> & { unitId: string; at: string; subject: { service: string; id: string } };

describe.skipIf(!hasRealDatabase)("provider units against a real database", () => {
  const tag = randomUUID().slice(0, 8);
  const orgId = `itest-units-org-${tag}`;
  const otherOrg = `itest-units-other-${tag}`;
  const brandA = `brand-a-${tag}`;
  const brandB = `brand-b-${tag}`;
  const SRC = `src-${tag}`;
  const SRC_B = `srcb-${tag}`;
  const OUT = `out-${tag}`;
  const acme = `acme-${tag}.com`;
  const app = express();
  app.use(router);
  const made: string[] = [];
  const orgRows: string[] = [];
  const lead: Record<string, string> = {};
  const run: Record<string, string> = {};
  const find: Record<string, string> = {};

  const get = (path: string, org = orgId) => request(app).get(path).set("x-api-key", "test-api-key").set("x-org-id", org);
  async function units(path: string): Promise<Unit[]> {
    const res = await get(path);
    expect(res.status, `${path} -> ${JSON.stringify(res.body)}`).toBe(200);
    expect(res.body.count).toBe(res.body.units.length);
    return res.body.units as Unit[];
  }
  const ids = (list: Unit[]) => list.map((u) => u.unitId);

  async function person(name: string, email: string | null): Promise<string> {
    const [row] = await sql`INSERT INTO leads (first_name, last_name) VALUES (${name}, 'Units') RETURNING id::text AS id`;
    made.push(row.id);
    lead[name] = row.id;
    if (email) await sql`INSERT INTO lead_contact_methods (lead_id, channel, value, source) VALUES (${row.id}::uuid, 'email', ${email}, 'itest')`;
    return row.id;
  }
  async function row(input: {
    key?: string; who: string; campaign: string; brand?: string; org?: string; reason: string; details: string; at: string; runId?: string;
    handedTo?: string; setAside?: string; retried?: boolean;
  }): Promise<string> {
    const runId = input.runId ?? randomUUID();
    const [r] = await sql`
      INSERT INTO leads_campaigns (lead_id, campaign_id, org_id, brand_ids, status, status_reason, status_details, served_at, created_at,
        run_id, parent_run_id, audience_id, workflow_slug, feature_slug,
        source_handed_at, source_handed_to_campaign_id, source_set_aside_at, source_set_aside_reason, retry_claimed_at)
      VALUES (${lead[input.who]}::uuid, ${input.campaign}, ${input.org ?? orgId}, ARRAY[${input.brand ?? brandA}]::text[], 'served', ${input.reason},
        ${input.details}, ${input.at}::timestamptz, ${input.at}::timestamptz, ${runId}, ${`parent-${runId}`}, ${`aud-${tag}`}, 'wf-v1', 'sourcing-apollo',
        ${input.handedTo ? input.at : null}::timestamptz, ${input.handedTo ?? null},
        ${input.setAside ? input.at : null}::timestamptz, ${input.setAside ?? null}, ${input.retried ? input.at : null}::timestamptz)
      RETURNING id::text AS id`;
    if (input.key) {
      find[input.key] = r.id;
      run[input.key] = runId;
    }
    return r.id;
  }
  const FOUND = (who: string) => `Served via audience aud-${tag}, email=${who}@x, leadId=x, campaign=x`;

  async function fact(who: string, outcome: string, opts: { brand?: string; org?: string; at?: string | null; reversedAt?: string; ours?: boolean; createdAt?: string }) {
    const runId = randomUUID();
    await sql`
      INSERT INTO outcome_fact_declarations (org_id, brand_id, lead_id, outcome_key, run_id, consumed_outcome_key, consumed_basis, dated,
        caused_by_outreach, occurred_at, performer, crm_fact_id, reversed_at, created_at)
      VALUES (${opts.org ?? orgId}, ${opts.brand ?? brandA}, ${lead[who]}::uuid, ${outcome}, ${runId}::uuid,
        ${opts.ours === false ? null : "conversation"}, ${opts.ours === false ? null : "positive_reply"}, true, ${opts.ours !== false},
        ${opts.at ?? null}::timestamptz, ${JSON.stringify(opts.ours === false ? { kind: "crm", name: "hubspot" } : { kind: "script", workflowSlug: "cold-email-v3" })}::jsonb,
        ${opts.ours === false ? `crm-fact-${who}` : null}, ${opts.reversedAt ?? null}::timestamptz, ${opts.createdAt ?? "2026-11-01T00:00:00Z"}::timestamptz)`;
    return `${runId}:${outcome}:${lead[who]}`;
  }

  async function check(input: { key: string; subject: string; domain: string; verdictRun: string | null; observationRun: string | null; charged: number; at: string; org?: string; brand?: string; runId?: string }) {
    const runId = input.runId ?? randomUUID();
    run[input.key] = runId;
    const [o] = await sql`
      INSERT INTO qualification_observations (probe_key, domain, status, vendor_cost_micro, run_id)
      VALUES (${`probe-${tag}-${input.key}`}, ${input.domain}, 'ok', ${input.charged}, ${input.observationRun === "self" ? runId : input.observationRun})
      RETURNING id::text AS id`;
    const [v] = await sql`
      INSERT INTO qualification_verdicts (criterion_key, domain, observation_id, verdict, run_id)
      VALUES (${`crit-${tag}-${input.key}`}, ${input.domain}, ${o.id}::uuid, 'yes', ${input.verdictRun === "self" ? runId : input.verdictRun})
      RETURNING id::text AS id`;
    await sql`
      INSERT INTO qualification_checks (criterion_id, org_id, brand_id, offer_id, subject, domain, verdict_id, run_id, checked_at)
      VALUES (${randomUUID()}::uuid, ${input.org ?? orgId}, ${input.brand ?? brandA}, ${`offer-${tag}`}, ${input.subject}, ${input.domain}, ${v.id}::uuid, ${runId}, ${input.at}::timestamptz)`;
    return `${runId}:${input.domain}`;
  }

  const factIds: Record<string, string> = {};
  const researchIds: Record<string, string> = {};

  beforeAll(async () => {
    await person("ann", `Ann-${tag}@${acme}`); // stored with capitals: matched case-insensitively
    await person("bob", `bob-${tag}@${acme}`);
    await person("cat", `cat-${tag}@elsewhere-${tag}.io`);
    await person("dan", `dan-${tag}@solo-${tag}.io`);
    await person("eve", `eve-${tag}@solo-${tag}.io`);
    await person("fay", `fay-${tag}@solo-${tag}.io`);
    await person("gus", `gus-${tag}@press-${tag}.io`);
    await person("hal", null);
    // cat's current employer is the company, her address is elsewhere.
    const [org] = await sql`INSERT INTO organizations (name, primary_domain) VALUES (${`Acme ${tag}`}, ${acme}) RETURNING id::text AS id`;
    orgRows.push(org.id);
    await sql`INSERT INTO leads_organizations (lead_id, organization_id, current) VALUES (${lead.cat}::uuid, ${org.id}::uuid, true)`;

    // FINDS (the serve's own text).
    await row({ key: "annSrc", who: "ann", campaign: SRC, reason: "source_found", details: FOUND("ann"), at: "2026-10-01T10:00:00.123456Z" });
    await row({ key: "bobSrc", who: "bob", campaign: SRC, reason: "source_found", details: FOUND("bob"), at: "2026-10-02T10:00:00Z", handedTo: OUT });
    await row({ key: "catOut", who: "cat", campaign: OUT, reason: "served", details: FOUND("cat"), at: "2026-10-03T10:00:00Z" });
    await row({ key: "danSrc", who: "dan", campaign: SRC, reason: "source_found", details: FOUND("dan"), at: "2026-10-04T10:00:00Z" });
    await row({ key: "annSrcB", who: "ann", campaign: SRC_B, brand: brandB, reason: "source_found", details: FOUND("ann"), at: "2026-10-05T10:00:00Z" });
    await row({ key: "fayOut", who: "fay", campaign: OUT, reason: "served", details: "Lead served, email=fay@x", at: "2026-10-06T10:00:00Z", retried: true });
    await row({ key: "halSrc", who: "hal", campaign: SRC, reason: "source_found", details: FOUND("hal"), at: "2026-10-07T10:00:00Z", setAside: "no longer fits" });
    // NOT finds: a stock hand-over, a named serve, an intake filing, a journalist's find, another org's find.
    await row({ who: "bob", campaign: OUT, reason: "served", details: `Handed from source ${SRC}`, at: "2026-10-02T12:00:00Z" });
    await row({ who: "eve", campaign: OUT, reason: "served", details: "Named lead served", at: "2026-10-03T12:00:00Z" });
    await row({ who: "dan", campaign: `signups:${brandA}`, reason: "crm_signup", details: "Signed up", at: "2026-10-04T12:00:00Z" });
    await row({ who: "gus", campaign: SRC, reason: "source_found", details: FOUND("gus"), at: "2026-10-08T10:00:00Z" });
    await sql`INSERT INTO brand_journalists (org_id, brand_id, lead_id, press_only, journalist) VALUES (${orgId}, ${brandA}, ${lead.gus}::uuid, true, true)`;
    await row({ who: "ann", campaign: `other-${tag}`, org: otherOrg, reason: "source_found", details: FOUND("ann"), at: "2026-10-09T10:00:00Z" });

    // FACT Units.
    factIds.annBooked = await fact("ann", "meeting_booked", { at: "2026-10-10T09:00:00Z" });
    factIds.bobBooked = await fact("bob", "meeting_booked", { at: "2026-10-11T09:00:00Z", reversedAt: "2026-10-20T00:00:00Z" });
    factIds.catBooked = await fact("cat", "meeting_booked", { at: null, ours: false, createdAt: "2026-10-12T09:00:00Z" });
    factIds.annBookedB = await fact("ann", "meeting_booked", { brand: brandB, at: "2026-10-13T09:00:00Z" });
    factIds.annSignup = await fact("ann", "signup", { at: "2026-10-09T09:00:00Z" });
    await fact("ann", "meeting_booked", { org: otherOrg, at: "2026-10-14T09:00:00Z" });

    // RESEARCH.
    researchIds.verdict = await check({ key: "verdict", subject: `lead:${lead.ann}`, domain: acme, verdictRun: "self", observationRun: "older-run", charged: 0, at: "2026-10-15T09:00:00Z" });
    researchIds.charged = await check({ key: "charged", subject: `company:beta-${tag}.com`, domain: `beta-${tag}.com`, verdictRun: "older-run", observationRun: "self", charged: 1200, at: "2026-10-16T09:00:00Z" });
    await check({ key: "reused", subject: `lead:${lead.bob}`, domain: `gamma-${tag}.com`, verdictRun: "older-run", observationRun: "older-run", charged: 900, at: "2026-10-17T09:00:00Z" });
    await check({ key: "gate", subject: `candidate:aud:${tag}`, domain: `delta-${tag}.com`, verdictRun: "self", observationRun: "self", charged: 900, at: "2026-10-18T09:00:00Z" });
    // Research a FINDING serve run paid itself: rode its lead_found.
    await check({ key: "finder", subject: `lead:${lead.cat}`, domain: `eps-${tag}.com`, verdictRun: "self", observationRun: "self", charged: 900, at: "2026-10-19T09:00:00Z", runId: run.catOut });
    await check({ key: "foreign", subject: `company:${acme}`, domain: acme, verdictRun: "self", observationRun: "self", charged: 5, at: "2026-10-20T09:00:00Z", org: otherOrg });
  });

  afterAll(async () => {
    for (const org of [orgId, otherOrg]) {
      await sql`DELETE FROM qualification_checks WHERE org_id = ${org}`;
      await sql`DELETE FROM outcome_fact_declarations WHERE org_id = ${org}`;
      await sql`DELETE FROM brand_journalists WHERE org_id = ${org}`;
      await sql`DELETE FROM leads_campaigns WHERE org_id = ${org}`;
    }
    await sql`DELETE FROM qualification_verdicts WHERE criterion_key LIKE ${`crit-${tag}-%`}`;
    await sql`DELETE FROM qualification_observations WHERE probe_key LIKE ${`probe-${tag}-%`}`;
    if (made.length) await sql`DELETE FROM leads WHERE id = ANY(${made}::uuid[])`;
    if (orgRows.length) await sql`DELETE FROM organizations WHERE id = ANY(${orgRows}::uuid[])`;
  });

  describe("lead_found", () => {
    it("a brand's finds, newest first: never a re-hand, an intake filing, a journalist or another org's", async () => {
      const list = await units(`/orgs/units/lead-found?brandId=${brandA}`);
      expect(ids(list)).toEqual([find.halSrc, find.fayOut, find.danSrc, find.catOut, find.bobSrc, find.annSrc]);
    });

    it("serves the Unit as the row holds it", async () => {
      const [ann] = await units(`/orgs/units/lead-found?leadIds=${lead.ann}&brandId=${brandA}`);
      expect(ann).toEqual({
        unitId: find.annSrc,
        outcome: "lead_found",
        subject: { service: "lead-service", id: lead.ann },
        at: "2026-10-01T10:00:00.123Z",
        email: `ann-${tag}@${acme}`,
        brandId: brandA,
        brandIds: [brandA],
        campaignId: SRC,
        runId: run.annSrc,
        madeBy: { kind: "source_find", audienceId: `aud-${tag}`, workflowSlug: "wf-v1", featureSlug: "sourcing-apollo", parentRunId: `parent-${run.annSrc}`, runRepointed: false },
        served: { handedToCampaignId: null, handedAt: null, setAsideAt: null, setAsideReason: null },
      });
      const [bob] = await units(`/orgs/units/lead-found?leadIds=${lead.bob}`);
      expect(bob.served).toEqual({ handedToCampaignId: OUT, handedAt: "2026-10-02T10:00:00.000Z", setAsideAt: null, setAsideReason: null });
      const [cat] = await units(`/orgs/units/lead-found?leadIds=${lead.cat}`);
      expect((cat.madeBy as { kind: string }).kind).toBe("serve");
      // A row handed out again since: its run ids are a later run's, never served as the finding run.
      const [fay] = await units(`/orgs/units/lead-found?leadIds=${lead.fay}`);
      expect(fay.runId).toBeNull();
      expect(fay.madeBy).toMatchObject({ parentRunId: null, runRepointed: true });
      // Known by no email: still a Unit.
      const [hal] = await units(`/orgs/units/lead-found?leadIds=${lead.hal}`);
      expect(hal.email).toBeNull();
      expect(hal.served).toMatchObject({ setAsideReason: "no longer fits" });
    });

    it("person filters: address (case-insensitive, every brand), lead id, company domain by address OR current employer; OR'ed", async () => {
      expect(ids(await units(`/orgs/units/lead-found?emails=ANN-${tag}@${acme}`))).toEqual([find.annSrcB, find.annSrc]);
      expect(ids(await units(`/orgs/units/lead-found?emails=ann-${tag}@${acme}&brandId=${brandA}`))).toEqual([find.annSrc]);
      expect(ids(await units(`/orgs/units/lead-found?leadIds=${lead.bob},${lead.dan}`))).toEqual([find.danSrc, find.bobSrc]);
      expect(ids(await units(`/orgs/units/lead-found?domains=${acme}`))).toEqual([find.annSrcB, find.catOut, find.bobSrc, find.annSrc]);
      expect(ids(await units(`/orgs/units/lead-found?emails=dan-${tag}@solo-${tag}.io&leadIds=${lead.bob}`))).toEqual([find.danSrc, find.bobSrc]);
    });

    it("since is inclusive, until exclusive, campaignId is the campaign the find is filed under", async () => {
      expect(ids(await units(`/orgs/units/lead-found?brandId=${brandA}&since=2026-10-03T10:00:00Z&until=2026-10-06T10:00:00Z`))).toEqual([find.danSrc, find.catOut]);
      expect(ids(await units(`/orgs/units/lead-found?brandId=${brandA}&campaignId=${OUT}`))).toEqual([find.fayOut, find.catOut]);
      expect(ids(await units(`/orgs/units/lead-found?campaignId=${SRC_B}&emails=ann-${tag}@${acme}`))).toEqual([find.annSrcB]);
    });

    it("notServedTo=any_campaign: a source's finds nobody took (a hand-over and a direct serve are out; an intake filing is not a serve)", async () => {
      expect(ids(await units(`/orgs/units/lead-found?brandId=${brandA}&notServedTo=any_campaign`))).toEqual([find.halSrc, find.danSrc, find.annSrc]);
      // The person gets a row under an outreach campaign of the brand after the find: served.
      const laterRow = await row({ who: "ann", campaign: `out2-${tag}`, reason: "served", details: "Lead follow-up due", at: "2026-10-21T10:00:00Z" });
      expect(ids(await units(`/orgs/units/lead-found?brandId=${brandA}&notServedTo=any_campaign`))).toEqual([find.halSrc, find.danSrc]);
      // ...her find under ANOTHER brand is untouched by it.
      expect(ids(await units(`/orgs/units/lead-found?leadIds=${lead.ann}&notServedTo=any_campaign`))).toEqual([find.annSrcB]);
      await sql`DELETE FROM leads_campaigns WHERE id = ${laterRow}::uuid`;
    });

    it("notServedTo=<campaign>: never found under it, handed to it, nor holding a row under it", async () => {
      expect(ids(await units(`/orgs/units/lead-found?brandId=${brandA}&notServedTo=${OUT}`))).toEqual([find.halSrc, find.danSrc, find.annSrc]);
      expect(ids(await units(`/orgs/units/lead-found?brandId=${brandA}&notServedTo=${SRC}`))).toEqual([find.fayOut, find.catOut]);
    });

    it("pages to the last page with the cursor, every Unit once", async () => {
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const res = await get(`/orgs/units/lead-found?brandId=${brandA}&limit=4${cursor ? `&cursor=${cursor}` : ""}`);
        expect(res.status).toBe(200);
        seen.push(...ids(res.body.units));
        cursor = res.body.nextCursor;
        pages++;
      } while (cursor && pages < 10);
      expect(pages).toBe(2);
      expect(seen).toEqual([find.halSrc, find.fayOut, find.danSrc, find.catOut, find.bobSrc, find.annSrc]);
      const exact = await get(`/orgs/units/lead-found?brandId=${brandA}&limit=6`);
      expect(exact.body.nextCursor).toBeNull();
    });

    it("an unknown person or brand = 200 empty; another org sees nothing of ours", async () => {
      expect(await units(`/orgs/units/lead-found?emails=nobody-${tag}@nowhere.io`)).toEqual([]);
      expect(await units(`/orgs/units/lead-found?leadIds=${randomUUID()}`)).toEqual([]);
      expect(await units(`/orgs/units/lead-found?brandId=unknown-${tag}`)).toEqual([]);
      const foreign = await get(`/orgs/units/lead-found?leadIds=${lead.bob}`, otherOrg);
      expect(foreign.body.units).toEqual([]);
      const theirs = await get(`/orgs/units/lead-found?leadIds=${lead.ann}`, otherOrg);
      expect(theirs.body.units).toHaveLength(1);
      expect(theirs.body.units[0].campaignId).toBe(`other-${tag}`);
    });

    it("a cursor of another read is refused, never a 500", async () => {
      const page = await get(`/orgs/units/meeting-booked?brandId=${brandA}&limit=1`);
      const res = await get(`/orgs/units/lead-found?brandId=${brandA}&cursor=${page.body.nextCursor}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_cursor");
    });
  });

  describe("fact outcomes", () => {
    it("a brand's Units of ONE outcome, newest first, reversed ones flagged, an undated one at its declaration", async () => {
      const list = await units(`/orgs/units/meeting-booked?brandId=${brandA}`);
      expect(ids(list)).toEqual([factIds.catBooked, factIds.bobBooked, factIds.annBooked]);
      const [cat, bob, ann] = list;
      expect(ann).toEqual({
        unitId: factIds.annBooked,
        outcome: "meeting_booked",
        subject: { service: "lead-service", id: lead.ann },
        at: "2026-10-10T09:00:00.000Z",
        email: `ann-${tag}@${acme}`,
        brandId: brandA,
        campaignId: null,
        runId: factIds.annBooked.split(":")[0],
        madeBy: {
          performer: { kind: "script", workflowSlug: "cold-email-v3" },
          causedByOutreach: true,
          consumedOutcome: "conversation",
          consumedBasis: "positive_reply",
          conversionEventId: null,
          crmFactId: null,
        },
        reversed: false,
        reversedAt: null,
      });
      expect(bob).toMatchObject({ reversed: true, reversedAt: "2026-10-20T00:00:00.000Z" });
      expect(cat).toMatchObject({ at: "2026-10-12T09:00:00.000Z", reversed: false });
      expect(cat.madeBy).toEqual({ performer: { kind: "crm", name: "hubspot" }, causedByOutreach: false, consumedOutcome: null, consumedBasis: null, conversionEventId: null, crmFactId: "crm-fact-cat" });
    });

    it("each outcome has its own read", async () => {
      expect(ids(await units(`/orgs/units/signup?brandId=${brandA}`))).toEqual([factIds.annSignup]);
      expect((await units(`/orgs/units/signup?brandId=${brandA}`))[0].outcome).toBe("signup");
      for (const empty of ["website-visit", "form-submitted", "purchase", "meeting-attended", "paid-client"]) {
        expect(await units(`/orgs/units/${empty}?brandId=${brandA}`), empty).toEqual([]);
      }
    });

    it("person, brand and window filters", async () => {
      expect(ids(await units(`/orgs/units/meeting-booked?emails=ann-${tag}@${acme}`))).toEqual([factIds.annBookedB, factIds.annBooked]);
      expect(ids(await units(`/orgs/units/meeting-booked?leadIds=${lead.ann}&brandId=${brandB}`))).toEqual([factIds.annBookedB]);
      expect(ids(await units(`/orgs/units/meeting-booked?domains=${acme}`))).toEqual([factIds.annBookedB, factIds.catBooked, factIds.bobBooked, factIds.annBooked]);
      expect(ids(await units(`/orgs/units/meeting-booked?brandId=${brandA}&since=2026-10-11T09:00:00Z&until=2026-10-12T09:00:00Z`))).toEqual([factIds.bobBooked]);
    });

    it("pages with the cursor; an unknown person = 200 empty", async () => {
      const first = await get(`/orgs/units/meeting-booked?domains=${acme}&limit=3`);
      expect(ids(first.body.units)).toEqual([factIds.annBookedB, factIds.catBooked, factIds.bobBooked]);
      const second = await get(`/orgs/units/meeting-booked?domains=${acme}&limit=3&cursor=${first.body.nextCursor}`);
      expect(ids(second.body.units)).toEqual([factIds.annBooked]);
      expect(second.body.nextCursor).toBeNull();
      expect(await units(`/orgs/units/meeting-booked?emails=nobody-${tag}@nowhere.io`)).toEqual([]);
      expect(await units(`/orgs/units/meeting-booked?leadIds=${lead.dan}`)).toEqual([]);
    });
  });

  describe("company_researched", () => {
    it("the companies a run paid NEW research on: a new verdict or a charged probe; never reused research, a candidate's gate, a finding run's", async () => {
      const list = await units(`/orgs/units/company-researched?brandId=${brandA}`);
      expect(ids(list)).toEqual([researchIds.charged, researchIds.verdict]);
      expect(list[1]).toMatchObject({
        unitId: `${run.verdict}:${acme}`,
        outcome: "company_researched",
        subject: { service: "lead-service", id: acme },
        at: "2026-10-15T09:00:00.000Z",
        brandId: brandA,
        campaignId: null,
        runId: run.verdict,
        madeBy: { kind: "qualification_check", offerIds: [`offer-${tag}`], checkedSubjects: [`lead:${lead.ann}`] },
      });
    });

    it("by domain, by window, paged; an unknown company = 200 empty; another org's research is its own", async () => {
      expect(ids(await units(`/orgs/units/company-researched?domains=${acme}`))).toEqual([researchIds.verdict]);
      expect(ids(await units(`/orgs/units/company-researched?brandId=${brandA}&since=2026-10-16T00:00:00Z`))).toEqual([researchIds.charged]);
      const first = await get(`/orgs/units/company-researched?brandId=${brandA}&limit=1`);
      expect(ids(first.body.units)).toEqual([researchIds.charged]);
      const second = await get(`/orgs/units/company-researched?brandId=${brandA}&limit=1&cursor=${first.body.nextCursor}`);
      expect(ids(second.body.units)).toEqual([researchIds.verdict]);
      expect(second.body.nextCursor).toBeNull();
      expect(await units(`/orgs/units/company-researched?domains=nowhere-${tag}.io`)).toEqual([]);
      const foreign = await get(`/orgs/units/company-researched?domains=${acme}`, otherOrg);
      expect(ids(foreign.body.units)).toEqual([`${run.foreign}:${acme}`]);
    });
  });

  it("a read writes nothing", async () => {
    const snapshot = async () =>
      JSON.stringify(
        await sql`
          SELECT (SELECT md5(string_agg(row_to_json(lc)::text, '|' ORDER BY lc.id)) FROM leads_campaigns lc WHERE lc.org_id = ${orgId}) AS rows,
                 (SELECT md5(string_agg(row_to_json(d)::text, '|' ORDER BY d.lead_id, d.brand_id, d.outcome_key)) FROM outcome_fact_declarations d WHERE d.org_id = ${orgId}) AS facts,
                 (SELECT md5(string_agg(row_to_json(c)::text, '|' ORDER BY c.id)) FROM qualification_checks c WHERE c.org_id = ${orgId}) AS checks`,
      );
    const before = await snapshot();
    await units(`/orgs/units/lead-found?brandId=${brandA}&notServedTo=any_campaign`);
    await units(`/orgs/units/meeting-booked?brandId=${brandA}`);
    await units(`/orgs/units/company-researched?brandId=${brandA}`);
    expect(await snapshot()).toBe(before);
  });
});
