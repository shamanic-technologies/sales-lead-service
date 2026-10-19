import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/db/index.js", () => ({ sql: () => Promise.resolve([]), db: {} }));

const { attributeSentMessages } = await import("../../src/lib/sent-messages.js");
type Records = Parameters<typeof attributeSentMessages>[0];
type Acts = Parameters<typeof attributeSentMessages>[1];

const B = "brand-1";

function rec(over: Partial<Records[number]>): Records[number] {
  return {
    id: "m1",
    kind: "email_sent",
    source: "outreach",
    channel: "email",
    campaignId: "c-cold",
    brandIds: [B],
    sentAt: "2026-10-19T10:00:00.000Z",
    sentBy: null,
    holding: null,
    ...over,
  };
}

function act(over: Partial<Acts[number]>): Acts[number] {
  return {
    id: "a1",
    actingCampaignId: "c-fu",
    heldByCampaignId: "c-cold",
    runId: "run-fu",
    workflowSlug: "ai-follow-up-email-algenib-v11",
    brandIds: [B],
    occurredAt: "2026-10-19T10:01:00.000Z",
    ...over,
  };
}

describe("attributeSentMessages (WRITTEN-BY-1019-SENDER)", () => {
  it("credits a sequence email to the run holding the row when it went out", () => {
    const [m] = attributeSentMessages(
      [rec({ holding: { runId: "run-seq", workflowSlug: "sales-cold-email-outreach-lithium-v6", workflowSource: "retry_claim" } })],
      [],
    );
    expect(m.writtenBy).toEqual({
      by: "workflow",
      basis: "holding_run",
      runId: "run-seq",
      workflowSlug: "sales-cold-email-outreach-lithium-v6",
      campaignId: "c-cold",
      workflowSource: "retry_claim",
      reason: null,
    });
  });

  it("credits a message to the act its run recorded within 10 min, of the message's own campaign, and does not list that act twice", () => {
    const out = attributeSentMessages(
      [rec({ id: "fu-email", campaignId: "c-fu" })],
      [act({}), act({ id: "a-other-campaign", actingCampaignId: "c-other", occurredAt: "2026-10-19T10:00:30.000Z" })],
    );
    const email = out.find((m) => m.id === "fu-email")!;
    expect(email.writtenBy).toMatchObject({ by: "workflow", basis: "recorded_act", runId: "run-fu", workflowSlug: "ai-follow-up-email-algenib-v11", campaignId: "c-fu" });
    // The act of another campaign was not paired: it stands as its own record.
    expect(out.map((m) => m.id)).toEqual(["fu-email", "a-other-campaign"]);
    expect(out[1]).toMatchObject({ kind: "followup_act", source: "followup_ledger", channel: null, campaignId: "c-other" });
  });

  it("pairs a crm message (no campaign) with the nearest act of a brand it names, never another brand's", () => {
    const out = attributeSentMessages(
      [rec({ id: "wa", kind: "message_out", source: "crm", channel: "whatsapp", campaignId: null })],
      [act({ id: "far", occurredAt: "2026-10-19T10:09:00.000Z" }), act({ id: "near", runId: "run-near", occurredAt: "2026-10-19T09:59:00.000Z" }), act({ id: "foreign", brandIds: ["brand-2"], occurredAt: "2026-10-19T10:00:00.000Z" })],
    );
    expect(out.find((m) => m.id === "wa")!.writtenBy.runId).toBe("run-near");
    expect(out.filter((m) => m.kind === "followup_act").map((m) => m.id).sort()).toEqual(["far", "foreign"]);
  });

  it("a reply a PERSON sent is a person's, even with an act nearby", () => {
    const out = attributeSentMessages([rec({ kind: "reply_sent", sentBy: "human", campaignId: "c-fu" })], [act({})]);
    expect(out.find((m) => m.id === "m1")!.writtenBy).toEqual({
      by: "person", basis: "person", runId: null, workflowSlug: null, campaignId: null, workflowSource: null, reason: null,
    });
    expect(out).toHaveLength(2);
  });

  it("serves unknown, never guessed: no act in the window and no holding row; undated never paired", () => {
    const out = attributeSentMessages(
      [
        rec({ id: "auto", kind: "reply_sent", sentBy: "automation", campaignId: "c-fu", sentAt: "2026-10-19T12:00:00.000Z" }),
        rec({ id: "undated", kind: "message_out", source: "crm", campaignId: null, sentAt: null }),
      ],
      [act({})],
    );
    expect(out.find((m) => m.id === "auto")!.writtenBy).toMatchObject({ by: "unknown", reason: "no_recorded_run", runId: null });
    expect(out.find((m) => m.id === "undated")!.writtenBy).toMatchObject({ by: "unknown", reason: "undated" });
    expect(out[out.length - 1].id).toBe("undated");
  });
});
