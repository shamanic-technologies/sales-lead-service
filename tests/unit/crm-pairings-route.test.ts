import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const fetchCrmConnection = vi.fn();
const fetchCrmContactsPage = vi.fn();
const streamCrmContacts = vi.fn();
const fetchCrmOpportunitiesByContact = vi.fn();
const matchesForContacts = vi.fn();

const loadJudgments = vi.fn();
const loadRulings = vi.fn();
const upsertRuling = vi.fn();
const withdrawRuling = vi.fn();
const countLeadsNoCrmContactPointsAt = vi.fn();

const fetchPairedLeadFacts = vi.fn();
const resolveStandingsForLeads = vi.fn();

vi.mock("../../src/config.js", () => ({
  LEAD_SERVICE_API_KEY: "test-api-key",
  CRM_SERVICE_URL: "http://crm:3016",
  CRM_SERVICE_API_KEY: "test-crm-key",
  CHAT_SERVICE_URL: "http://chat:3011",
  CHAT_SERVICE_API_KEY: "test-chat-key",
}));

vi.mock("../../src/lib/crm-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    fetchCrmConnection: (...a: unknown[]) => fetchCrmConnection(...a),
    fetchCrmContactsPage: (...a: unknown[]) => fetchCrmContactsPage(...a),
    streamCrmContacts: (...a: unknown[]) => streamCrmContacts(...a),
    fetchCrmOpportunitiesByContact: (...a: unknown[]) => fetchCrmOpportunitiesByContact(...a),
  };
});

// "Same human?" is human-service's answer: the route reads it through matchesForContacts.
vi.mock("../../src/lib/crm-matching.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, matchesForContacts: (...a: unknown[]) => matchesForContacts(...a) };
});

vi.mock("../../src/lib/crm-pairing-store.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadJudgments: (...a: unknown[]) => loadJudgments(...a),
    loadRulings: (...a: unknown[]) => loadRulings(...a),
    upsertRuling: (...a: unknown[]) => upsertRuling(...a),
    withdrawRuling: (...a: unknown[]) => withdrawRuling(...a),
    countLeadsNoCrmContactPointsAt: (...a: unknown[]) => countLeadsNoCrmContactPointsAt(...a),
  };
});

vi.mock("../../src/lib/crm-pairing-view.js", () => ({
  fetchPairedLeadFacts: (...a: unknown[]) => fetchPairedLeadFacts(...a),
  resolveStandingsForLeads: (...a: unknown[]) => resolveStandingsForLeads(...a),
}));

vi.mock("../../src/lib/lead-standing-resolver.js", () => ({
  createLeadStandingResolver: () => ({ resolve: async () => new Map() }),
}));

const BRAND = "b0000000-0000-0000-0000-000000000001";
const LEAD = "a0000000-0000-0000-0000-000000000001";
const RUN = "c0000000-0000-0000-0000-000000000009";
const auth = { "x-api-key": "test-api-key", "x-org-id": "org-1", "x-user-id": "u1", "x-run-id": RUN };

const CONNECTION = {
  id: "conn-1",
  brandId: BRAND,
  locationId: "loc-1",
  status: "active",
  synced: true,
  lastSyncedAt: null,
  lastError: null,
};

function contact(over: Record<string, unknown> = {}) {
  return {
    id: "crm-1",
    brandId: BRAND,
    externalId: "ghl-1",
    primaryEmail: null,
    phoneE164: "+15550001111",
    fullName: "Dana Jones",
    firstName: "Dana",
    lastName: "Jones",
    unsubscribed: false,
    ...over,
  };
}

function leadFacts() {
  return new Map([
    [
      LEAD,
      {
        leadId: LEAD,
        leadCampaignId: "lc-1",
        campaignId: "camp-1",
        brandIds: [BRAND],
        status: "served",
        firstName: "Dana",
        lastName: "Jones",
        fullName: "Dana Jones",
        email: "dana@acme.com",
        jobTitle: "Head of Ops",
        company: "Acme",
        companyDomain: "acme.com",
        location: "Austin, TX, US",
      },
    ],
  ]);
}

/** What matchesForContacts answers: a contact human-service ties to a lead, or nothing. */
function humanMatch(crmContactId: string, leadId: string | null) {
  return leadId
    ? {
        crmContactId,
        matchedLeadId: leadId,
        matchMethod: "human",
        matchConfidence: "deterministic",
        candidateCount: 1,
        matchedAt: null,
      }
    : {
        crmContactId,
        matchedLeadId: null,
        matchMethod: null,
        matchConfidence: "unmatched",
        candidateCount: 0,
        matchedAt: null,
      };
}

/** human-service ties exactly these contacts to these leads; every other contact is unmatched. */
function humansPair(leadByContact: Record<string, string>) {
  matchesForContacts.mockImplementation(
    async (_org: string, _brand: string, contacts: Array<{ id: string }>) =>
      new Map(contacts.map((c) => [c.id, humanMatch(c.id, leadByContact[c.id] ?? null)])),
  );
}

function rejection(crmContactId: string, note = "different person") {
  return [
    `${crmContactId}:${LEAD}`,
    { ruling: "rejected", note, statedByUserId: "u1", statedAt: "2026-09-22T01:00:00.000Z" },
  ] as const;
}

let app: express.Express;

beforeAll(async () => {
  const { default: route } = await import("../../src/routes/crm-pairings.js");
  app = express();
  app.use(express.json());
  app.use(route);
}, 30_000);

beforeEach(() => {
  for (const m of [
    fetchCrmConnection,
    fetchCrmContactsPage,
    streamCrmContacts,
    fetchCrmOpportunitiesByContact,
    matchesForContacts,
    loadJudgments,
    loadRulings,
    upsertRuling,
    withdrawRuling,
    countLeadsNoCrmContactPointsAt,
    fetchPairedLeadFacts,
    resolveStandingsForLeads,
  ]) {
    m.mockReset();
  }
  humansPair({});
  fetchCrmOpportunitiesByContact.mockResolvedValue(new Map());
  loadJudgments.mockResolvedValue(new Map());
  loadRulings.mockResolvedValue(new Map());
  fetchPairedLeadFacts.mockResolvedValue(new Map());
  resolveStandingsForLeads.mockResolvedValue(new Map());
});

describe("GET /orgs/leads/crm-pairings", () => {
  const url = `/orgs/leads/crm-pairings?brandId=${BRAND}`;

  it("401 without the api key", async () => {
    expect((await request(app).get(url)).status).toBe(401);
  });

  it("400 without a brand", async () => {
    const res = await request(app).get("/orgs/leads/crm-pairings").set(auth);
    expect(res.status).toBe(400);
  });

  it("400 on an unparseable bound rather than a silent clamp", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    expect((await request(app).get(`${url}&limit=0`).set(auth)).status).toBe(400);
    expect((await request(app).get(`${url}&limit=9999`).set(auth)).status).toBe(400);
    expect((await request(app).get(`${url}&offset=-1`).set(auth)).status).toBe(400);
  });

  // A brand with no mirrored CRM answers correctly rather than erroring.
  it("answers crmConnected:false for a brand with no mirrored CRM and no person from any tool", async () => {
    fetchCrmConnection.mockResolvedValue(null);
    fetchCrmContactsPage.mockResolvedValue([]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.crmConnected).toBe(false);
    expect(res.body.pairings).toEqual([]);
    expect(fetchCrmContactsPage).toHaveBeenCalledTimes(1);
  });

  // PostHog / Stripe / a CSV import, no GoHighLevel: their people are paired all the same.
  it("serves a brand whose people come from tools other than GoHighLevel", async () => {
    fetchCrmConnection.mockResolvedValue(null);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.crmConnected).toBe(true);
    expect(res.body.connection).toBeNull();
    expect(res.body.pairings).toHaveLength(1);
  });

  it("serves a contact human-service ties to no lead as unpaired", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);

    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.pairings).toHaveLength(1);
    expect(res.body.pairings[0].pairing.state).toBe("unpaired");
    expect(res.body.pairings[0].pairing.decidedBy).toBeNull();
    expect(res.body.pairings[0].pairing.lead).toBeNull();
    expect(matchesForContacts).toHaveBeenCalledWith("org-1", BRAND, [expect.objectContaining({ id: "crm-1" })]);
  });

  // The pairing is human-service's answer, nothing else: a shared NAME pairs nobody.
  it("pairs a contact human-service ties to a lead, decided by that signal, with no judgment", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    humansPair({ "crm-1": LEAD });
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());

    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    const row = res.body.pairings[0];
    expect(row.pairing.state).toBe("paired");
    expect(row.pairing.decidedBy).toBe("signal");
    expect(row.pairing.toConfirm).toBe(false);
    expect(row.pairing.lead.leadId).toBe(LEAD);
    expect(row.pairing.evidence).toEqual({
      matchMethod: "human",
      matchConfidence: "deterministic",
      candidateCount: 1,
      matchedAt: null,
    });
    expect(row.pairing.judgment.status).toBe("not_needed");
    expect(fetchPairedLeadFacts).toHaveBeenCalledWith(BRAND, [LEAD]);
  });

  // Stability: the same contact reads the same pairing twice.
  it("re-reads a pairing byte-identically", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    humansPair({ "crm-1": LEAD });
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());

    const first = await request(app).get(url).set(auth);
    const second = await request(app).get(url).set(auth);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(first.body.pairings[0].pairing.state).toBe("paired");
  });

  // A person's ruling outranks human-service's pairing.
  it("a person's rejection outranks a human-service pairing", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    humansPair({ "crm-1": LEAD });
    loadRulings.mockResolvedValue(new Map([rejection("crm-1")]));
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());

    const res = await request(app).get(url).set(auth);
    const row = res.body.pairings[0];
    expect(row.pairing.state).toBe("rejected");
    expect(row.pairing.decidedBy).toBe("human");
    expect(row.pairing.ruling.note).toBe("different person");
  });

  it("serves their opportunities as a SET and never maps their stage names", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact({ primaryEmail: "dana@acme.com" })]);
    humansPair({ "crm-1": LEAD });
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());
    fetchCrmOpportunitiesByContact.mockResolvedValue(
      new Map([
        [
          "crm-1",
          [
            {
              id: "o1",
              externalId: "go1",
              name: "Retainer",
              state: "won",
              stateRaw: "won",
              monetaryValue: 4200,
              pipelineName: "Sales",
              stageName: "ACTIVE CLIENT - DWD + EMAIL + SEO",
              createdAt: null,
              updatedAt: null,
            },
            {
              id: "o2",
              externalId: "go2",
              name: "Trial",
              state: "open",
              stateRaw: "open",
              monetaryValue: null,
              pipelineName: "Onboarding",
              stageName: "Free Trail Client",
              createdAt: null,
              updatedAt: null,
            },
          ],
        ],
      ]),
    );

    const res = await request(app).get(url).set(auth);
    const row = res.body.pairings[0];
    expect(row.pairing.state).toBe("paired");
    expect(row.pairing.decidedBy).toBe("signal");
    expect(row.pairing.judgment.status).toBe("not_needed");
    expect(row.theirStatus.opportunities).toHaveLength(2);
    expect(row.theirStatus.states.sort()).toEqual(["open", "won"]);
    expect(row.theirStatus.stageNamesComparable).toBe(false);
    expect(row.theirStatus.stageComparabilityReason).toBe("stage_names_are_free_text_per_customer");
  });

  it("502s rather than pretending their CRM is empty", async () => {
    const { CrmServiceError } = await import("../../src/lib/crm-client.js");
    fetchCrmConnection.mockRejectedValue(new CrmServiceError("crm-service 503"));
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(502);
  });
});

/**
 * Six of their contacts, in their list order:
 *   crm-a paired (human)   crm-b unpaired   crm-c rejected (human-service paired it, a person denied it)
 *   crm-d paired (human)   crm-e unpaired   crm-f rejected
 */
function sixContactFixture() {
  const ids = ["crm-a", "crm-b", "crm-c", "crm-d", "crm-e", "crm-f"];
  fetchCrmConnection.mockResolvedValue(CONNECTION);
  // The walk honours its start position, exactly like crm-service's offset.
  streamCrmContacts.mockImplementation(async function* (_b: string, _c: unknown, start = 0) {
    yield ids.slice(start).map((id) => contact({ id }));
  });
  humansPair({ "crm-a": LEAD, "crm-c": LEAD, "crm-d": LEAD, "crm-f": LEAD });
  loadRulings.mockResolvedValue(new Map([rejection("crm-c"), rejection("crm-f")]));
  fetchPairedLeadFacts.mockResolvedValue(leadFacts());
  return ids;
}

const idsOf = (body: { pairings: Array<{ crmContact: { id: string } }> }) =>
  body.pairings.map((p) => p.crmContact.id);

describe("GET /orgs/leads/crm-pairings?state=", () => {
  const url = `/orgs/leads/crm-pairings?brandId=${BRAND}`;

  it("400s on a state it does not know, or an empty set, rather than ignoring the filter", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    expect((await request(app).get(`${url}&state=merged`).set(auth)).status).toBe(400);
    expect((await request(app).get(`${url}&state=paired,maybe`).set(auth)).status).toBe(400);
    expect((await request(app).get(`${url}&state=`).set(auth)).status).toBe(400);
    expect((await request(app).get(`${url}&state=,`).set(auth)).status).toBe(400);
    expect(streamCrmContacts).not.toHaveBeenCalled();
  });

  it("serves only the paired rows and says there is no more", async () => {
    sixContactFixture();
    const res = await request(app).get(`${url}&state=paired`).set(auth);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual(["crm-a", "crm-d"]);
    expect(res.body.pairings.every((p: { pairing: { state: string } }) => p.pairing.state === "paired")).toBe(true);
    expect(res.body.nextOffset).toBeNull();
    expect(fetchCrmContactsPage).not.toHaveBeenCalled();
  });

  it("serves only the unpaired rows", async () => {
    sixContactFixture();
    const res = await request(app).get(`${url}&state=unpaired`).set(auth);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual(["crm-b", "crm-e"]);
  });

  it("serves only the rows a person rejected, decided by that person", async () => {
    sixContactFixture();
    const res = await request(app).get(`${url}&state=rejected`).set(auth);
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual(["crm-c", "crm-f"]);
    expect(res.body.pairings.every((p: { pairing: { decidedBy: string } }) => p.pairing.decidedBy === "human")).toBe(
      true,
    );
  });

  // The acceptance criterion: paging the filter visits exactly the set the counts report.
  it("pages the filtered set by position in their list, and the pages add up to the counts", async () => {
    sixContactFixture();
    const seen: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    while (offset !== null) {
      const page = await request(app).get(`${url}&state=paired,unpaired&limit=1&offset=${offset}`).set(auth);
      expect(page.status).toBe(200);
      seen.push(...idsOf(page.body));
      offset = page.body.nextOffset;
      pages += 1;
      expect(pages).toBeLessThan(10);
    }
    expect(seen).toEqual(["crm-a", "crm-b", "crm-d", "crm-e"]);

    const counts = await request(app).get(`/orgs/leads/crm-pairing-counts?brandId=${BRAND}`).set(auth);
    expect(counts.body.counts.byState.paired + counts.body.counts.byState.unpaired).toBe(seen.length);
    expect(counts.body.counts.byState.rejected).toBe(2);
  });

  it("nextOffset is the position of the next matching contact, so a row ruled on meanwhile skips nobody", async () => {
    sixContactFixture();
    const first = await request(app).get(`${url}&state=paired&limit=1`).set(auth);
    expect(idsOf(first.body)).toEqual(["crm-a"]);
    // crm-d sits at position 3 in their list.
    expect(first.body.nextOffset).toBe(3);
    const second = await request(app).get(`${url}&state=paired&limit=1&offset=3`).set(auth);
    expect(idsOf(second.body)).toEqual(["crm-d"]);
    expect(second.body.nextOffset).toBeNull();
  });

  // A pairing human-service decided is never "to confirm": nothing waits on a person.
  it("a to-confirm read serves nothing; toConfirm=false serves the paired rows", async () => {
    sixContactFixture();
    const toConfirm = await request(app).get(`${url}&toConfirm=true`).set(auth);
    expect(toConfirm.status).toBe(200);
    expect(toConfirm.body.pairings).toEqual([]);
    const settled = await request(app).get(`${url}&toConfirm=false`).set(auth);
    expect(idsOf(settled.body)).toEqual(["crm-a", "crm-d"]);
  });

  it("an unconfirmed read serves nothing: human-service pairs or does not", async () => {
    sixContactFixture();
    const res = await request(app).get(`${url}&state=unconfirmed`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.pairings).toEqual([]);
  });

  it("toConfirm must be true or false", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    const res = await request(app).get(`${url}&toConfirm=yes`).set(auth);
    expect(res.status).toBe(400);
  });

  it("502s rather than serving a partial filtered page when their CRM cannot be read", async () => {
    const { CrmServiceError } = await import("../../src/lib/crm-client.js");
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    streamCrmContacts.mockImplementation(async function* () {
      throw new CrmServiceError("crm-service 503");
    });
    const res = await request(app).get(`${url}&state=paired`).set(auth);
    expect(res.status).toBe(502);
  });
});

describe("GET /orgs/leads/crm-pairings — where their record came from", () => {
  const url = `/orgs/leads/crm-pairings?brandId=${BRAND}`;

  it("carries each contact's provenance in their own words, and nulls when their CRM holds none", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    const { normalizeCrmContact } = await import("../../src/lib/crm-client.js");
    fetchCrmContactsPage.mockResolvedValue([
      normalizeCrmContact({
        ...contact({ id: "crm-1" }),
        company: { name: "Acme Chiro", website: "https://acmechiro.com" },
        record: {
          type: "lead",
          leadSource: "Meta Ads",
          tags: ["funnel form submitted", "appt scheduled"],
          createdAt: "2026-09-19T21:07:55.341Z",
          updatedAt: "2026-09-20T08:00:00.000Z",
          origin: { medium: "form", url: null, referrer: null },
        },
      } as never),
      normalizeCrmContact(contact({ id: "crm-2" }) as never),
    ]);

    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    const [withRecord, without] = res.body.pairings;
    expect(withRecord.crmContact.company).toBe("Acme Chiro");
    expect(withRecord.crmContact.record).toEqual({
      type: "lead",
      leadSource: "Meta Ads",
      tags: ["funnel form submitted", "appt scheduled"],
      createdAt: "2026-09-19T21:07:55.341Z",
      updatedAt: "2026-09-20T08:00:00.000Z",
      origin: { medium: "form", url: null, referrer: null },
    });
    expect(without.crmContact.record).toEqual({
      type: null,
      leadSource: null,
      tags: null,
      createdAt: null,
      updatedAt: null,
      origin: { medium: null, url: null, referrer: null },
    });
  });
});

describe("GET /orgs/leads/crm-pairing-counts", () => {
  const url = `/orgs/leads/crm-pairing-counts?brandId=${BRAND}`;

  it("answers zeroes for a brand with no mirrored CRM", async () => {
    fetchCrmConnection.mockResolvedValue(null);
    fetchCrmContactsPage.mockResolvedValue([]);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.crmConnected).toBe(false);
    expect(res.body.counts.crmContacts).toBe(0);
    expect(res.body.ourLeadsNoCrmContactPointsAt).toBe(0);
  });

  it("walks their contacts and partitions them by human-service's pairing", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    streamCrmContacts.mockImplementation(async function* () {
      yield [
        contact({ id: "crm-1", primaryEmail: "dana@acme.com" }),
        contact({ id: "crm-2", primaryEmail: null }),
      ];
    });
    humansPair({ "crm-1": LEAD });
    fetchCrmOpportunitiesByContact.mockResolvedValue(
      new Map([
        [
          "crm-1",
          [
            {
              id: "o1",
              externalId: null,
              name: null,
              state: "won",
              stateRaw: "won",
              monetaryValue: null,
              pipelineName: null,
              stageName: "BOOKED - NO BUY",
              createdAt: null,
              updatedAt: null,
            },
          ],
        ],
      ]),
    );
    countLeadsNoCrmContactPointsAt.mockResolvedValue(53_212);

    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.counts.crmContacts).toBe(2);
    expect(res.body.counts.crmContactsWithEmail).toBe(1);
    expect(res.body.counts.byState.paired).toBe(1);
    expect(res.body.counts.byState.unpaired).toBe(1);
    expect(res.body.counts.byState.unconfirmed).toBe(0);
    expect(res.body.counts.opportunitiesByState.won).toBe(1);
    expect(res.body.counts.opportunitiesWithUncomparableStage).toBe(1);
    expect(res.body.ourLeadsNoCrmContactPointsAt).toBe(53_212);
    expect(matchesForContacts).toHaveBeenCalledTimes(1);
  });
});

describe("rulings", () => {
  it("records what a person stated", async () => {
    upsertRuling.mockResolvedValue(undefined);
    const res = await request(app)
      .post("/orgs/leads/crm-pairings/rulings")
      .set(auth)
      .send({ brandId: BRAND, crmContactId: "crm-1", leadId: LEAD, ruling: "rejected", note: "namesake" });
    expect(res.status).toBe(201);
    expect(upsertRuling).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: BRAND,
        crmContactId: "crm-1",
        leadId: LEAD,
        ruling: "rejected",
        note: "namesake",
        statedByUserId: "u1",
      }),
    );
  });

  it("400s on a ruling word it does not know rather than storing it", async () => {
    const res = await request(app)
      .post("/orgs/leads/crm-pairings/rulings")
      .set(auth)
      .send({ brandId: BRAND, crmContactId: "crm-1", leadId: LEAD, ruling: "maybe" });
    expect(res.status).toBe(400);
    expect(upsertRuling).not.toHaveBeenCalled();
  });

  it("400s on a missing lead rather than writing a statement about nobody", async () => {
    const res = await request(app)
      .post("/orgs/leads/crm-pairings/rulings")
      .set(auth)
      .send({ brandId: BRAND, crmContactId: "crm-1", ruling: "accepted" });
    expect(res.status).toBe(400);
  });

  it("withdraws a statement without deleting it", async () => {
    withdrawRuling.mockResolvedValue({ existed: true, alreadyWithdrawn: false });
    const res = await request(app)
      .delete(`/orgs/leads/crm-pairings/rulings?brandId=${BRAND}&crmContactId=crm-1&leadId=${LEAD}`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.withdrawn).toBe(true);
    expect(res.body.alreadyWithdrawn).toBe(false);
  });

  it("is idempotent", async () => {
    withdrawRuling.mockResolvedValue({ existed: true, alreadyWithdrawn: true });
    const res = await request(app)
      .delete(`/orgs/leads/crm-pairings/rulings?brandId=${BRAND}&crmContactId=crm-1&leadId=${LEAD}`)
      .set(auth);
    expect(res.status).toBe(200);
    expect(res.body.alreadyWithdrawn).toBe(true);
  });

  it("409s when nobody ever stated anything", async () => {
    withdrawRuling.mockResolvedValue({ existed: false, alreadyWithdrawn: false });
    const res = await request(app)
      .delete(`/orgs/leads/crm-pairings/rulings?brandId=${BRAND}&crmContactId=crm-1&leadId=${LEAD}`)
      .set(auth);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("nothing_stated");
  });
});
