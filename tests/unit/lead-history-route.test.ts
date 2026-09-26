import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

/**
 * The history read fans out over services that own each fact. Everything downstream is mocked;
 * what is under test is that the route asks with the right scope, keeps the org boundary IN the
 * lookup, and — the part that matters most — still ANSWERS when a source cannot be read, saying
 * which one is missing instead of rendering silence.
 */

interface Captured {
  text: string;
  values: unknown[];
}
let queries: Captured[] = [];
let leadRow: Record<string, unknown> | null = null;
let campaignRows: Array<Record<string, unknown>> = [];

vi.mock("../../src/db/index.js", () => ({
  sql: (strings: readonly string[], ...values: unknown[]) => {
    const text = strings.join(" ");
    return {
      then: (resolve: (rows: unknown[]) => void) => {
        // Bind-faithful: postgres.js throws on a raw Date param, and a plain mock would let a
        // handler that binds one ship green.
        for (const v of values) {
          if (v instanceof Date) {
            throw new TypeError(
              'The "string" argument must be of type string. Received an instance of Date',
            );
          }
        }
        queries.push({ text, values });
        if (/WHERE lc\.id =/.test(text)) {
          const [id, orgId] = values;
          const found = leadRow && leadRow.id === id && leadRow.org_id === orgId ? [leadRow] : [];
          return Promise.resolve(found).then(resolve);
        }
        if (/lc\.lead_id =/.test(text)) return Promise.resolve(campaignRows).then(resolve);
        return Promise.resolve([]).then(resolve);
      },
    };
  },
}));

const checkDeliveryStatus = vi.fn();
vi.mock("../../src/lib/email-gateway-client.js", () => ({
  checkDeliveryStatus: (...args: unknown[]) => checkDeliveryStatus(...args),
}));

const resolveCampaignFamily = vi.fn();
vi.mock("../../src/lib/campaign-identity-client.js", () => ({
  resolveCampaignFamily: (...args: unknown[]) => resolveCampaignFamily(...args),
}));

const fetchOutreachConversation = vi.fn();
const fetchOutreachReplyStatements = vi.fn();
const fetchOutreachOptOuts = vi.fn();
vi.mock("../../src/lib/outreach-client.js", () => ({
  fetchOutreachConversation: (...a: unknown[]) => fetchOutreachConversation(...a),
  fetchOutreachReplyStatements: (...a: unknown[]) => fetchOutreachReplyStatements(...a),
  fetchOutreachOptOuts: (...a: unknown[]) => fetchOutreachOptOuts(...a),
}));

const fetchMailboxConversation = vi.fn();
vi.mock("../../src/lib/mailbox-client.js", () => ({
  fetchMailboxConversation: (...a: unknown[]) => fetchMailboxConversation(...a),
}));

const fetchGeneratedEmail = vi.fn();
vi.mock("../../src/lib/generated-email-client.js", () => ({
  fetchGeneratedEmail: (...a: unknown[]) => fetchGeneratedEmail(...a),
}));

const fetchAnswerers = vi.fn();
vi.mock("../../src/lib/answerer-client.js", () => ({
  fetchAnswerers: (...a: unknown[]) => fetchAnswerers(...a),
}));

const { default: leadHistoryRoutes } = await import("../../src/routes/lead-history.js");

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const RUN = "33333333-3333-3333-3333-333333333333";
const ROW = "44444444-4444-4444-4444-444444444444";
const LEAD = "55555555-5555-5555-5555-555555555555";

function app() {
  const server = express();
  server.use(express.json());
  server.use(leadHistoryRoutes);
  return server;
}

function get(path: string) {
  return request(app())
    .get(path)
    .set("x-api-key", process.env.LEAD_SERVICE_API_KEY!)
    .set("x-org-id", ORG)
    .set("x-user-id", USER)
    .set("x-run-id", RUN);
}

beforeEach(() => {
  queries = [];
  leadRow = {
    id: ROW,
    org_id: ORG,
    lead_id: LEAD,
    campaign_id: "camp-1",
    brand_ids: ["brand-1"],
    email: "prospect@example.com",
  };
  campaignRows = [
    {
      id: ROW,
      campaign_id: "camp-1",
      brand_ids: ["brand-1"],
      status: "served",
      created_at: "2026-01-01 00:00:00+00",
      served_at: "2026-01-01 00:00:00+00",
      sent_at: null,
      followup_due_at: null,
      followup_count: 0,
      followup_last_action_at: null,
      followup_stopped_reason: null,
    },
    {
      id: "66666666-6666-6666-6666-666666666666",
      campaign_id: "camp-2",
      brand_ids: ["brand-1"],
      status: "served",
      created_at: "2026-02-01 00:00:00+00",
      served_at: "2026-02-01 00:00:00+00",
      sent_at: null,
      followup_due_at: null,
      followup_count: 0,
      followup_last_action_at: null,
      followup_stopped_reason: null,
    },
  ];
  checkDeliveryStatus.mockReset().mockResolvedValue({ results: [] });
  resolveCampaignFamily.mockReset().mockResolvedValue(["camp-1"]);
  fetchOutreachConversation.mockReset().mockResolvedValue({ ok: true, data: null });
  fetchOutreachReplyStatements.mockReset().mockResolvedValue({ ok: true, data: [] });
  fetchOutreachOptOuts.mockReset().mockResolvedValue({ ok: true, data: [] });
  fetchMailboxConversation.mockReset().mockResolvedValue({ ok: true, data: null });
  fetchGeneratedEmail.mockReset().mockResolvedValue({ ok: true, data: null });
  fetchAnswerers.mockReset().mockResolvedValue({ ok: true, data: new Map() });
});

describe("GET /orgs/leads/:id/history", () => {
  it("does not ask campaign-service when nothing in scope holds a scheduled follow-up", async () => {
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    expect(fetchAnswerers).not.toHaveBeenCalled();
    expect(res.body.sources.find((s: { source: string }) => s.source === "campaigns").status).toBe("not_asked");
  });

  it("asks who answers exactly the campaign holding a scheduled follow-up, and states the answer", async () => {
    campaignRows[0] = { ...campaignRows[0], followup_due_at: "2026-09-06 09:00:00+00" };
    // A stopped schedule on another campaign is not asked about.
    campaignRows[1] = {
      ...campaignRows[1],
      followup_due_at: "2026-09-07 09:00:00+00",
      followup_stopped_reason: "meeting booked",
    };
    resolveCampaignFamily.mockResolvedValue(["camp-1", "camp-2"]);
    fetchAnswerers.mockResolvedValue({
      ok: true,
      data: new Map([
        [
          "camp-1",
          {
            ok: true,
            campaignId: "camp-1",
            answeredBy: null,
            absence: "no_answering_campaign",
            startableFeatureSlugs: ["ai-meeting-booking"],
            candidate: null,
            candidateAnswersCampaignId: null,
          },
        ],
      ]),
    });
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    expect(fetchAnswerers).toHaveBeenCalledTimes(1);
    expect(fetchAnswerers).toHaveBeenCalledWith(["camp-1"]);
    const scheduled = res.body.events.find(
      (e: { type: string; state: string }) => e.type === "followup" && e.state === "scheduled",
    );
    expect(scheduled.answerer).toMatchObject({ state: "unanswered", absence: "no_answering_campaign" });
    const stopped = res.body.events.find(
      (e: { type: string; state: string }) => e.type === "followup" && e.state === "stopped",
    );
    expect(stopped).not.toHaveProperty("answerer");
  });

  it("an unreadable campaign-service leaves the read answering, the follow-up unknown, complete false", async () => {
    campaignRows[0] = { ...campaignRows[0], followup_due_at: "2026-09-06 09:00:00+00" };
    fetchAnswerers.mockResolvedValue({ ok: false, reason: "campaign-service unreachable: fetch failed" });
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(false);
    const scheduled = res.body.events.find((e: { type: string }) => e.type === "followup");
    expect(scheduled.answerer.state).toBe("unknown");
    expect(res.body.sources.find((s: { source: string }) => s.source === "campaigns").status).toBe("unavailable");
  });

  it("refuses an id that is not a uuid before doing any work", async () => {
    const res = await get("/orgs/leads/not-a-uuid/history");
    expect(res.status).toBe(400);
    expect(queries).toHaveLength(0);
  });

  it("refuses a scope it does not answer for, rather than silently answering another", async () => {
    const res = await get(`/orgs/leads/${ROW}/history?scope=everything`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("scope");
  });

  it("keeps the org boundary IN the lookup — a foreign row reads as absent", async () => {
    leadRow = { ...leadRow!, org_id: "99999999-9999-9999-9999-999999999999" };
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(404);
  });

  it("404s a brand scope the row is not part of, exactly as an absent row does", async () => {
    const res = await get(`/orgs/leads/${ROW}/history?brandId=brand-other`);
    expect(res.status).toBe(404);
  });

  it("defaults to the campaign's whole identity, not the single stored row", async () => {
    resolveCampaignFamily.mockResolvedValue(["camp-1", "camp-2"]);
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("campaign");
    expect(res.body.campaignIds.sort()).toEqual(["camp-1", "camp-2"]);
  });

  it("scope=brand rolls up every campaign of the brand this person is in", async () => {
    const res = await get(`/orgs/leads/${ROW}/history?scope=brand`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe("brand");
    expect(res.body.campaignIds.sort()).toEqual(["camp-1", "camp-2"]);
    // A brand read does not ask which campaigns share an identity — it takes them all.
    expect(resolveCampaignFamily).not.toHaveBeenCalled();
  });

  it("asks the delivery layer ONCE for the person, not once per campaign", async () => {
    resolveCampaignFamily.mockResolvedValue(["camp-1", "camp-2"]);
    await get(`/orgs/leads/${ROW}/history`);
    expect(checkDeliveryStatus).toHaveBeenCalledTimes(1);
  });

  it("still answers when a source cannot be read, and says which one is missing", async () => {
    fetchMailboxConversation.mockResolvedValue({
      ok: false,
      reason: "google-service unreachable: fetch failed",
    });
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(false);
    const mailbox = res.body.sources.find((s: { source: string }) => s.source === "mailbox");
    expect(mailbox.status).toBe("unavailable");
    expect(mailbox.reason).toContain("google-service unreachable");
  });

  it("does not fail the read when the delivery layer is down", async () => {
    checkDeliveryStatus.mockRejectedValue(new Error("boom"));
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    expect(res.body.sources.find((s: { source: string }) => s.source === "delivery").status).toBe(
      "unavailable",
    );
    expect(res.body.complete).toBe(false);
  });

  it("returns the ordered events with their words", async () => {
    fetchOutreachConversation.mockResolvedValue({
      ok: true,
      data: {
        campaignId: "camp-1",
        leadEmail: "prospect@example.com",
        accountEmail: "sender@ours.com",
        transport: "instantly",
        source: "mirror",
        messageCount: 1,
        messages: [
          {
            direction: "inbound",
            from: "prospect@example.com",
            to: "sender@ours.com",
            at: "2026-01-03T08:00:00.000Z",
            subject: "Re: intro",
            text: "interested, send times",
          },
        ],
      },
    });
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    const message = res.body.events.find((e: { type: string }) => e.type === "message");
    expect(message.bodyText).toBe("interested, send times");
    expect(message.evidence).toBe("observed");
    expect(message.copy).toBe("mirror");
    // Oldest first: the serve precedes the reply.
    expect(res.body.events[0].type).toBe("lifecycle");
  });

  it("a lead with no registered email states that, and never renders it as silence", async () => {
    leadRow = { ...leadRow!, email: null };
    const res = await get(`/orgs/leads/${ROW}/history`);
    expect(res.status).toBe(200);
    expect(res.body.email).toBeNull();
    const byName = Object.fromEntries(
      res.body.sources.map((s: { source: string }) => [s.source, s]),
    );
    expect(byName.delivery.status).toBe("unavailable");
    expect(byName.mailbox.status).toBe("unavailable");
    expect(res.body.complete).toBe(false);
    expect(fetchMailboxConversation).not.toHaveBeenCalled();
  });

  it("bounds the campaign fan-out and SAYS it did", async () => {
    campaignRows = Array.from({ length: 12 }, (_, i) => ({
      id: `${i}`.padStart(8, "0") + "-0000-0000-0000-000000000000",
      campaign_id: `camp-${i}`,
      brand_ids: ["brand-1"],
      status: "served",
      created_at: "2026-01-01 00:00:00+00",
      served_at: null,
      sent_at: null,
      followup_due_at: null,
      followup_count: 0,
      followup_last_action_at: null,
      followup_stopped_reason: null,
    }));
    const res = await get(`/orgs/leads/${ROW}/history?scope=brand`);
    expect(res.status).toBe(200);
    expect(res.body.campaignIds).toHaveLength(8);
    expect(res.body.campaignsTruncated).toBe(true);
    expect(res.body.complete).toBe(false);
  });
});
