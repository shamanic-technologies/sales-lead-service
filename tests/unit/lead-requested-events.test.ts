import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";

// lead_requested TRIGGER EVENTS (src/lib/lead-requested-events.ts): every answered serve is recorded at
// campaign-service exactly once; recording never blocks or fails the serve; a failed delivery waits in
// trigger_event_outbox and is redelivered.

vi.mock("../../src/config.js", () => ({
  CAMPAIGN_SERVICE_URL: "http://campaign",
  CAMPAIGN_SERVICE_API_KEY: "campaign-key",
  LEAD_SERVICE_API_KEY: "test-api-key",
  PULL_NEXT_TIMEOUT_MS: 60_000,
}));

// ── db: idempotency cache (route) + outbox (recorder) ──────────────────────────────────────────
type OutboxRow = {
  idempotencyKey: string;
  orgId: string;
  event: unknown;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date;
  refusedAt: Date | null;
};
const outbox: OutboxRow[] = [];
const cacheInserts: unknown[] = [];
const findFirst = vi.fn();

vi.mock("../../src/db/schema.js", () => ({
  idempotencyCache: { __table: "idempotency_cache", idempotencyKey: "idempotency_key", createdAt: "created_at" },
  triggerEventOutbox: {
    __table: "trigger_event_outbox",
    idempotencyKey: "idempotency_key",
    refusedAt: "refused_at",
    nextAttemptAt: "next_attempt_at",
  },
}));

vi.mock("drizzle-orm", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    // The outbox mock filters itself; `eq` only needs to carry the key it names.
    eq: (_col: unknown, value: unknown) => ({ __eq: value }),
  };
});

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: { idempotencyCache: { findFirst: (...a: unknown[]) => findFirst(...a) } },
    insert: (table: { __table: string }) => ({
      values: (v: Record<string, unknown>) => {
        if (table.__table === "idempotency_cache") {
          cacheInserts.push(v);
          return Promise.resolve(undefined);
        }
        return {
          onConflictDoNothing: async () => {
            if (!outbox.some((r) => r.idempotencyKey === v.idempotencyKey)) outbox.push({ ...(v as OutboxRow) });
          },
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => outbox.filter((r) => !r.refusedAt && r.nextAttemptAt.getTime() <= Date.now()).map((r) => ({ ...r })),
          }),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<OutboxRow>) => ({
        where: async (w: { __eq: string }) => {
          const row = outbox.find((r) => r.idempotencyKey === w.__eq);
          if (row) Object.assign(row, patch);
        },
      }),
    }),
    delete: () => ({
      where: async (w: { __eq: string }) => {
        const i = outbox.findIndex((r) => r.idempotencyKey === w.__eq);
        if (i >= 0) outbox.splice(i, 1);
        return [];
      },
    }),
  },
}));

const fetchCampaign = vi.fn();
vi.mock("../../src/lib/campaign-client.js", () => ({
  fetchCampaign: (...a: unknown[]) => fetchCampaign(...a),
}));

// ── route deps (the real recorder is NOT mocked) ──────────────────────────────────────────────
const pullNext = vi.fn();
vi.mock("../../src/lib/buffer.js", () => ({ pullNext: (...a: unknown[]) => pullNext(...a) }));
vi.mock("../../src/lib/runs-client.js", () => ({
  createRun: vi.fn(async () => ({ id: "serve-run-1" })),
  updateRun: vi.fn(async () => undefined),
}));
vi.mock("../../src/lib/trace-event.js", () => ({ traceEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/lib/inflight-guard.js", () => ({ checkConcurrentBufferNext: vi.fn(async () => ({ blocked: false })) }));
vi.mock("../../src/lib/people-client.js", () => ({
  AUDIENCE_NOT_SERVEABLE_REASON: "audience_not_serveable",
  isAudienceNotServeableError: () => false,
}));
vi.mock("../../src/lib/sourcing-origin.js", () => ({ resolveSourcingOriginSlug: vi.fn(async () => "sourcing-apollo-cold-filters") }));
const resolveServeSource = vi.fn();
vi.mock("../../src/lib/source-campaign.js", () => ({ resolveServeSource: (...a: unknown[]) => resolveServeSource(...a) }));

const ORG = "30000000-0000-0000-0000-000000000001";
const BRAND = "20000000-0000-0000-0000-000000000001";
const RUN = "10000000-0000-0000-0000-000000000001";
const CAMPAIGN = "40000000-0000-0000-0000-000000000001";
const SOURCE = "60000000-0000-0000-0000-000000000001";
const OFFER = "70000000-0000-0000-0000-000000000001";
const AUDIENCE = "50000000-0000-0000-0000-000000000001";

function connRefused(): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
}

function event(overrides: Record<string, unknown> = {}) {
  return {
    orgId: ORG,
    brandId: BRAND,
    offerId: OFFER as string | null,
    requestedByCampaignId: CAMPAIGN,
    callerRunId: RUN,
    leadId: "lead-1" as string | null,
    occurredAt: "2026-10-09T12:00:00.000Z",
    performed: { outcome: "ran" as const, campaignId: SOURCE },
    ...overrides,
  };
}

async function settle(predicate: () => boolean) {
  for (let i = 0; i < 400 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
}

describe("lead_requested trigger events", () => {
  beforeEach(() => {
    outbox.length = 0;
    cacheInserts.length = 0;
    vi.clearAllMocks();
    findFirst.mockResolvedValue(undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts ONE already-performed event to campaign-service, keyed on the caller's run", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ replayed: false }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const { deliverLeadRequested } = await import("../../src/lib/lead-requested-events.js");

    expect(await deliverLeadRequested(event())).toEqual({ kind: "delivered" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://campaign/internal/trigger-events");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "x-api-key": "campaign-key", "x-org-id": ORG });
    expect(JSON.parse(init.body as string)).toEqual({
      triggerId: "lead_requested",
      brandId: BRAND,
      offerId: OFFER,
      leadId: "lead-1",
      requestedByCampaignId: CAMPAIGN,
      idempotencyKey: `lead_requested:${RUN}`,
      occurredAt: "2026-10-09T12:00:00.000Z",
      performed: { outcome: "ran", campaignId: SOURCE },
    });
  });

  it("reads the offer off the outreach campaign when the serve did not know it; a skip carries no leadId", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    fetchCampaign.mockResolvedValueOnce({ id: CAMPAIGN, offerId: OFFER });
    const { deliverLeadRequested } = await import("../../src/lib/lead-requested-events.js");

    await deliverLeadRequested(event({ offerId: null, leadId: null, performed: { outcome: "skipped", reason: "audience_exhausted" } }));

    expect(fetchCampaign).toHaveBeenCalledWith(CAMPAIGN, ORG);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.offerId).toBe(OFFER);
    expect(body).not.toHaveProperty("leadId");
    expect(body.performed).toEqual({ outcome: "skipped", reason: "audience_exhausted" });
  });

  it("campaign-service unreachable: recordLeadRequested returns at once, never throws, keeps the event in the outbox", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw connRefused(); }));
    const { recordLeadRequested } = await import("../../src/lib/lead-requested-events.js");

    expect(recordLeadRequested(event())).toBeUndefined();
    expect(outbox).toHaveLength(0); // nothing awaited by the caller
    await settle(() => outbox.length === 1);

    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ idempotencyKey: `lead_requested:${RUN}`, orgId: ORG, attempts: 1, refusedAt: null });
    expect(outbox[0].lastError).toContain("fetch failed");
  });

  it("a 400 is a refusal: kept with refused_at, never redelivered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ reason: "unknown_campaign" }), { status: 400 })));
    const { recordLeadRequested, drainTriggerEventOutbox } = await import("../../src/lib/lead-requested-events.js");

    recordLeadRequested(event());
    await settle(() => outbox.length === 1);
    expect(outbox[0].refusedAt).toBeInstanceOf(Date);
    expect(outbox[0].lastError).toContain("unknown_campaign");

    outbox[0].nextAttemptAt = new Date(0);
    expect(await drainTriggerEventOutbox()).toEqual({ delivered: 0, retried: 0, refused: 0 });
  });

  it("the drain redelivers a due event with the SAME idempotency key and deletes it once recorded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw connRefused(); }));
    const { recordLeadRequested, drainTriggerEventOutbox } = await import("../../src/lib/lead-requested-events.js");
    recordLeadRequested(event());
    await settle(() => outbox.length === 1);

    // Not due yet: nothing sent.
    const fetchOk = vi.fn(async () => new Response(JSON.stringify({ replayed: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchOk);
    expect(await drainTriggerEventOutbox()).toEqual({ delivered: 0, retried: 0, refused: 0 });
    expect(fetchOk).not.toHaveBeenCalled();

    outbox[0].nextAttemptAt = new Date(0);
    expect(await drainTriggerEventOutbox()).toEqual({ delivered: 1, retried: 0, refused: 0 });
    expect(JSON.parse((fetchOk.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).idempotencyKey).toBe(`lead_requested:${RUN}`);
    expect(outbox).toHaveLength(0);
  });

  it("a redelivery that fails again backs off and counts the attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("down", { status: 503 })));
    const { recordLeadRequested, drainTriggerEventOutbox } = await import("../../src/lib/lead-requested-events.js");
    recordLeadRequested(event());
    await settle(() => outbox.length === 1);
    outbox[0].nextAttemptAt = new Date(0);

    expect(await drainTriggerEventOutbox()).toEqual({ delivered: 0, retried: 1, refused: 0 });
    expect(outbox[0].attempts).toBe(2);
    expect(outbox[0].nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 60_000);
    expect(outbox[0].refusedAt).toBeNull();
  });

  it("a campaign stating no offer cannot be recorded: refused, visible in the outbox", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    fetchCampaign.mockResolvedValueOnce({ id: CAMPAIGN, offerId: null });
    const { recordLeadRequested } = await import("../../src/lib/lead-requested-events.js");

    recordLeadRequested(event({ offerId: null }));
    await settle(() => outbox.length === 1);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outbox[0].refusedAt).toBeInstanceOf(Date);
    expect(outbox[0].lastError).toContain("states no offer");
  });

  describe("POST /orgs/buffer/next with campaign-service unreachable", () => {
    let app: express.Express;
    beforeAll(async () => {
      const { default: route } = await import("../../src/routes/buffer.js");
      app = express();
      app.use(express.json());
      app.use(route);
    }, 30_000);

    it("still serves the lead; the ask waits in the outbox", async () => {
      vi.stubGlobal("fetch", vi.fn(async () => { throw connRefused(); }));
      resolveServeSource.mockResolvedValueOnce({ kind: "source", campaignId: SOURCE, originSlug: "sourcing-apollo-cold-filters", offerId: OFFER });
      pullNext.mockResolvedValueOnce({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });

      const res = await request(app)
        .post("/orgs/buffer/next")
        .set("x-api-key", "test-api-key")
        .set("x-org-id", ORG)
        .set("x-run-id", RUN)
        .set("x-campaign-id", CAMPAIGN)
        .set("x-brand-id", BRAND)
        .set("x-audience-id", AUDIENCE)
        .set("x-feature-slug", "sales-cold-email-outreach")
        .send({});

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ found: true, lead: { leadId: "lead-1", email: "a@b.co" } });
      await settle(() => outbox.length === 1);
      expect(outbox).toHaveLength(1);
      expect(outbox[0].event).toMatchObject({ leadId: "lead-1", offerId: OFFER, performed: { outcome: "ran", campaignId: SOURCE } });
    });
  });
});
