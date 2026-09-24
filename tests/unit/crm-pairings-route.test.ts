import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const fetchCrmConnection = vi.fn();
const fetchCrmContactsPage = vi.fn();
const streamCrmContacts = vi.fn();
const fetchCrmOpportunitiesByContact = vi.fn();
const matchConversion = vi.fn();
const judgeSamePerson = vi.fn();

const loadFrozenMatches = vi.fn();
const freezeMatches = vi.fn();
const loadJudgments = vi.fn();
const saveJudgment = vi.fn();
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

vi.mock("../../src/lib/conversions.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, matchConversion: (...a: unknown[]) => matchConversion(...a) };
});

vi.mock("../../src/lib/judgment-client.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, judgeSamePerson: (...a: unknown[]) => judgeSamePerson(...a) };
});

vi.mock("../../src/lib/crm-pairing-store.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    loadFrozenMatches: (...a: unknown[]) => loadFrozenMatches(...a),
    freezeMatches: (...a: unknown[]) => freezeMatches(...a),
    loadJudgments: (...a: unknown[]) => loadJudgments(...a),
    saveJudgment: (...a: unknown[]) => saveJudgment(...a),
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
    matchConversion,
    judgeSamePerson,
    loadFrozenMatches,
    freezeMatches,
    loadJudgments,
    saveJudgment,
    loadRulings,
    upsertRuling,
    withdrawRuling,
    countLeadsNoCrmContactPointsAt,
    fetchPairedLeadFacts,
    resolveStandingsForLeads,
  ]) {
    m.mockReset();
  }
  fetchCrmOpportunitiesByContact.mockResolvedValue(new Map());
  loadFrozenMatches.mockResolvedValue(new Map());
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
  it("answers crmConnected:false for a brand with no mirrored CRM", async () => {
    fetchCrmConnection.mockResolvedValue(null);
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.crmConnected).toBe(false);
    expect(res.body.pairings).toEqual([]);
    expect(fetchCrmContactsPage).not.toHaveBeenCalled();
  });

  it("answers an empty page for a CRM whose contacts nothing pairs", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    matchConversion.mockResolvedValue({
      matchedLeadId: null,
      matchMethod: null,
      matchConfidence: "unmatched",
      attributionStatus: "unmatched",
      candidateCount: 0,
      candidates: [],
    });
    freezeMatches.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            crmContactId: "crm-1",
            matchedLeadId: null,
            matchMethod: null,
            matchConfidence: "unmatched",
            candidateCount: 0,
            matchedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      ]),
    );

    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.pairings).toHaveLength(1);
    expect(res.body.pairings[0].pairing.state).toBe("unpaired");
    expect(res.body.pairings[0].pairing.lead).toBeNull();
    expect(judgeSamePerson).not.toHaveBeenCalled();
  });

  it("serves a name-only pairing as unconfirmed and asks a judgment about it", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    matchConversion.mockResolvedValue({
      matchedLeadId: LEAD,
      matchMethod: "last_name",
      matchConfidence: "probabilistic",
      attributionStatus: "attributed",
      candidateCount: 12,
      candidates: [{ leadId: LEAD }],
    });
    const frozen = new Map([
      [
        "crm-1",
        {
          crmContactId: "crm-1",
          matchedLeadId: LEAD,
          matchMethod: "last_name",
          matchConfidence: "probabilistic",
          candidateCount: 12,
          matchedAt: "2026-09-22T00:00:00.000Z",
        },
      ],
    ]);
    freezeMatches.mockResolvedValue(frozen);
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());
    judgeSamePerson.mockResolvedValue({ probability: 0.93, model: "jev-1.13.0" });

    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(judgeSamePerson).toHaveBeenCalledTimes(1);
    expect(saveJudgment).toHaveBeenCalledTimes(1);

    const row = res.body.pairings[0];
    expect(row.pairing.state).toBe("paired");
    expect(row.pairing.decidedBy).toBe("judgment");
    expect(row.pairing.judgment.model).toBe("jev-1.13.0");
    expect(row.pairing.judgment.samePersonProbability).toBeCloseTo(0.93);
    expect(row.pairing.evidence.matchMethod).toBe("last_name");
    expect(row.pairing.evidence.candidateCount).toBe(12);
  });

  // The acceptance criterion: the vendor being unreachable can never merge or reject.
  it("degrades to unconfirmed and says so when the judgment vendor is unreachable", async () => {
    const { JudgmentUnavailableError } = await import("../../src/lib/judgment-client.js");
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    matchConversion.mockResolvedValue({
      matchedLeadId: LEAD,
      matchMethod: "last_name",
      matchConfidence: "probabilistic",
      attributionStatus: "attributed",
      candidateCount: 12,
      candidates: [{ leadId: LEAD }],
    });
    freezeMatches.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            crmContactId: "crm-1",
            matchedLeadId: LEAD,
            matchMethod: "last_name",
            matchConfidence: "probabilistic",
            candidateCount: 12,
            matchedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      ]),
    );
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());
    judgeSamePerson.mockRejectedValue(
      new JudgmentUnavailableError("judgment_service_unavailable", "chat-service unreachable"),
    );

    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    const row = res.body.pairings[0];
    expect(row.pairing.state).toBe("unconfirmed");
    expect(row.pairing.decidedBy).toBeNull();
    expect(row.pairing.judgment.status).toBe("unavailable");
    expect(row.pairing.judgment.unavailableReason).toBe("judgment_service_unavailable");
    expect(saveJudgment).not.toHaveBeenCalled();
  });

  // Stability: a frozen match is never recomputed, so a second read is byte-identical.
  it("re-reads a frozen pairing without re-matching or re-judging it", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    loadFrozenMatches.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            crmContactId: "crm-1",
            matchedLeadId: LEAD,
            matchMethod: "last_name",
            matchConfidence: "probabilistic",
            candidateCount: 12,
            matchedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      ]),
    );
    loadJudgments.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            leadId: LEAD,
            samePersonProbability: 0.93,
            model: "jev-1.13.0",
            judgedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      ]),
    );
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());

    const first = await request(app).get(url).set(auth);
    const second = await request(app).get(url).set(auth);
    expect(first.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(matchConversion).not.toHaveBeenCalled();
    expect(freezeMatches).not.toHaveBeenCalled();
    expect(judgeSamePerson).not.toHaveBeenCalled();
    expect(first.body.pairings[0].pairing.state).toBe("paired");
  });

  // A human ruling survives the matcher proposing the same pairing again.
  it("a human rejection outranks a confident judgment and a re-run of the matcher", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact()]);
    loadFrozenMatches.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            crmContactId: "crm-1",
            matchedLeadId: LEAD,
            matchMethod: "last_name",
            matchConfidence: "probabilistic",
            candidateCount: 12,
            matchedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      ]),
    );
    loadJudgments.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            leadId: LEAD,
            samePersonProbability: 0.97,
            model: "jev-1.13.0",
            judgedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      ]),
    );
    loadRulings.mockResolvedValue(
      new Map([
        [
          `crm-1:${LEAD}`,
          {
            ruling: "rejected",
            note: "different person",
            statedByUserId: "u1",
            statedAt: "2026-09-22T01:00:00.000Z",
          },
        ],
      ]),
    );
    fetchPairedLeadFacts.mockResolvedValue(leadFacts());

    const res = await request(app).get(url).set(auth);
    const row = res.body.pairings[0];
    expect(row.pairing.state).toBe("rejected");
    expect(row.pairing.decidedBy).toBe("human");
    expect(row.pairing.ruling.note).toBe("different person");
    // The judgment is still reported — the human overrode it, they did not erase it.
    expect(row.pairing.judgment.samePersonProbability).toBeCloseTo(0.97);
  });

  it("serves their opportunities as a SET and never maps their stage names", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    fetchCrmContactsPage.mockResolvedValue([contact({ primaryEmail: "dana@acme.com" })]);
    loadFrozenMatches.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            crmContactId: "crm-1",
            matchedLeadId: LEAD,
            matchMethod: "email",
            matchConfidence: "deterministic",
            candidateCount: 1,
            matchedAt: "2026-09-22T00:00:00.000Z",
          },
        ],
      ]),
    );
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
    expect(judgeSamePerson).not.toHaveBeenCalled();
  });

  it("502s rather than pretending their CRM is empty", async () => {
    const { CrmServiceError } = await import("../../src/lib/crm-client.js");
    fetchCrmConnection.mockRejectedValue(new CrmServiceError("crm-service 503"));
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(502);
  });
});

function frozen(id: string, over: Record<string, unknown> = {}) {
  return {
    crmContactId: id,
    matchedLeadId: LEAD,
    matchMethod: "email",
    matchConfidence: "deterministic",
    candidateCount: 1,
    matchedAt: null,
    ...over,
  };
}

/**
 * Six of their contacts, in their list order:
 *   crm-a paired (email)   crm-b unpaired   crm-c unconfirmed (last name)
 *   crm-d paired (email)   crm-e unpaired   crm-f unconfirmed (last name)
 */
function sixContactFixture() {
  const ids = ["crm-a", "crm-b", "crm-c", "crm-d", "crm-e", "crm-f"];
  const matches = new Map<string, ReturnType<typeof frozen>>([
    ["crm-a", frozen("crm-a")],
    ["crm-b", frozen("crm-b", { matchedLeadId: null, matchMethod: null, matchConfidence: "unmatched", candidateCount: 0 })],
    ["crm-c", frozen("crm-c", { matchMethod: "last_name", matchConfidence: "probabilistic", candidateCount: 9 })],
    ["crm-d", frozen("crm-d")],
    ["crm-e", frozen("crm-e", { matchedLeadId: null, matchMethod: null, matchConfidence: "unmatched", candidateCount: 0 })],
    ["crm-f", frozen("crm-f", { matchMethod: "last_name", matchConfidence: "probabilistic", candidateCount: 9 })],
  ]);
  fetchCrmConnection.mockResolvedValue(CONNECTION);
  // The walk honours its start position, exactly like crm-service's offset.
  streamCrmContacts.mockImplementation(async function* (_b: string, _c: unknown, start = 0) {
    yield ids.slice(start).map((id) => contact({ id }));
  });
  loadFrozenMatches.mockImplementation(async (_b: string, wanted: string[]) =>
    new Map(wanted.filter((id) => matches.has(id)).map((id) => [id, matches.get(id)!])),
  );
  fetchPairedLeadFacts.mockResolvedValue(leadFacts());
  return ids;
}

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

  it("serves only the paired rows, never buys a judgment for rows it will not serve, and says there is no more", async () => {
    sixContactFixture();
    const res = await request(app).get(`${url}&state=paired`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.pairings.map((p: { crmContact: { id: string } }) => p.crmContact.id)).toEqual(["crm-a", "crm-d"]);
    expect(res.body.pairings.every((p: { pairing: { state: string } }) => p.pairing.state === "paired")).toBe(true);
    expect(res.body.nextOffset).toBeNull();
    expect(judgeSamePerson).not.toHaveBeenCalled();
    expect(fetchCrmContactsPage).not.toHaveBeenCalled();
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
      seen.push(...page.body.pairings.map((p: { crmContact: { id: string } }) => p.crmContact.id));
      offset = page.body.nextOffset;
      pages += 1;
      expect(pages).toBeLessThan(10);
    }
    expect(seen).toEqual(["crm-a", "crm-b", "crm-d", "crm-e"]);

    const counts = await request(app).get(`/orgs/leads/crm-pairing-counts?brandId=${BRAND}`).set(auth);
    expect(counts.body.counts.byState.paired + counts.body.counts.byState.unpaired).toBe(seen.length);
  });

  it("nextOffset is the position of the next matching contact, so a row ruled on meanwhile skips nobody", async () => {
    sixContactFixture();
    const first = await request(app).get(`${url}&state=paired&limit=1`).set(auth);
    expect(first.body.pairings.map((p: { crmContact: { id: string } }) => p.crmContact.id)).toEqual(["crm-a"]);
    // crm-d sits at position 3 in their list.
    expect(first.body.nextOffset).toBe(3);
    const second = await request(app).get(`${url}&state=paired&limit=1&offset=3`).set(auth);
    expect(second.body.pairings.map((p: { crmContact: { id: string } }) => p.crmContact.id)).toEqual(["crm-d"]);
    expect(second.body.nextOffset).toBeNull();
  });

  it("an unconfirmed read judges what it walks and serves a row by the state it ends in", async () => {
    sixContactFixture();
    // crm-c is judged the same person; crm-f stays hesitant.
    judgeSamePerson
      .mockResolvedValueOnce({ probability: 0.95, model: "jev-1.13.0" })
      .mockResolvedValueOnce({ probability: 0.5, model: "jev-1.13.0" });
    const res = await request(app).get(`${url}&state=unconfirmed`).set(auth);
    expect(res.status).toBe(200);
    expect(judgeSamePerson).toHaveBeenCalledTimes(2);
    expect(saveJudgment).toHaveBeenCalledTimes(2);
    expect(res.body.pairings.map((p: { crmContact: { id: string } }) => p.crmContact.id)).toEqual(["crm-f"]);
    expect(res.body.pairings[0].pairing.state).toBe("unconfirmed");
    expect(res.body.pairings[0].pairing.judgment.status).toBe("undecided");
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
    loadFrozenMatches.mockResolvedValue(
      new Map([
        ["crm-1", frozen("crm-1", { matchedLeadId: null, matchMethod: null, matchConfidence: "unmatched", candidateCount: 0 })],
        ["crm-2", frozen("crm-2", { matchedLeadId: null, matchMethod: null, matchConfidence: "unmatched", candidateCount: 0 })],
      ]),
    );

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
    const res = await request(app).get(url).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.crmConnected).toBe(false);
    expect(res.body.counts.crmContacts).toBe(0);
    expect(res.body.ourLeadsNoCrmContactPointsAt).toBe(0);
  });

  it("walks their contacts, partitions them, and never buys a judgment", async () => {
    fetchCrmConnection.mockResolvedValue(CONNECTION);
    streamCrmContacts.mockImplementation(async function* () {
      yield [
        contact({ id: "crm-1", primaryEmail: "dana@acme.com" }),
        contact({ id: "crm-2", primaryEmail: null }),
      ];
    });
    loadFrozenMatches.mockResolvedValue(
      new Map([
        [
          "crm-1",
          {
            crmContactId: "crm-1",
            matchedLeadId: LEAD,
            matchMethod: "email",
            matchConfidence: "deterministic",
            candidateCount: 1,
            matchedAt: null,
          },
        ],
        [
          "crm-2",
          {
            crmContactId: "crm-2",
            matchedLeadId: LEAD,
            matchMethod: "last_name",
            matchConfidence: "probabilistic",
            candidateCount: 40,
            matchedAt: null,
          },
        ],
      ]),
    );
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
    expect(res.body.counts.byState.unconfirmed).toBe(1);
    expect(res.body.counts.opportunitiesByState.won).toBe(1);
    expect(res.body.counts.opportunitiesWithUncomparableStage).toBe(1);
    expect(res.body.ourLeadsNoCrmContactPointsAt).toBe(53_212);
    expect(judgeSamePerson).not.toHaveBeenCalled();
    expect(matchConversion).not.toHaveBeenCalled();
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
