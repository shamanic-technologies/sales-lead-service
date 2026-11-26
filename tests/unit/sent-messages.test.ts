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
    sendingRunId: null,
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
    llmAlias: null,
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
      llmAlias: null,
      llmAliasReason: "no_recorded_act",
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
      llmAlias: null, llmAliasReason: "no_recorded_act",
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

  it("BEST-TPL-LLM-1022-LS: names the LLM the act's run STATED; an act stating none reads not_stated, never guessed from the version", () => {
    const out = attributeSentMessages(
      [rec({ id: "wa", kind: "message_out", source: "crm", channel: "whatsapp", campaignId: null })],
      [
        act({ id: "stated", llmAlias: "gemini-3-flash" }),
        act({ id: "old", runId: "run-old", llmAlias: null, occurredAt: "2026-10-18T10:00:00.000Z" }),
      ],
    );
    expect(out.find((m) => m.id === "wa")!.writtenBy).toMatchObject({
      basis: "recorded_act", workflowSlug: "ai-follow-up-email-algenib-v11", llmAlias: "gemini-3-flash", llmAliasReason: null,
    });
    // The unpaired act recorded before the field: same workflow version, LLM unknown with a reason.
    expect(out.find((m) => m.id === "old")!.writtenBy).toMatchObject({
      basis: "recorded_act", workflowSlug: "ai-follow-up-email-algenib-v11", llmAlias: null, llmAliasReason: "not_stated",
    });
  });

  it("an unknown writer carries no LLM, with the reason", () => {
    const [m] = attributeSentMessages([rec({ campaignId: "c-x" })], []);
    expect(m.writtenBy).toMatchObject({ by: "unknown", llmAlias: null, llmAliasReason: "no_recorded_act" });
  });

  describe("the sender's record names the run (MODEL-TAG-EVERY-AI-MESSAGE-1126-LEADS)", () => {
    it("credits an automation reply_sent to the run its copy names, with no ledger act anywhere near", () => {
      const [m] = attributeSentMessages(
        [rec({ kind: "reply_sent", sentBy: "automation", sendingRunId: "run-answer", campaignId: "c-ans" })],
        [],
      );
      expect(m.writtenBy).toEqual({
        by: "workflow",
        basis: "sender_record",
        runId: "run-answer",
        workflowSlug: null,
        campaignId: "c-ans",
        workflowSource: null,
        reason: null,
        llmAlias: null,
        llmAliasReason: "no_recorded_act",
      });
    });

    it("credits a crm message_out (any channel) to the run its fact names, beats a nearer act of another run", () => {
      const out = attributeSentMessages(
        [rec({ kind: "message_out", source: "crm", channel: "whatsapp", campaignId: null, sendingRunId: "run-wa" })],
        [act({ id: "a-other", runId: "run-other", occurredAt: "2026-10-19T10:00:00.000Z" })],
      );
      expect(out.find((x) => x.id === "m1")?.writtenBy).toMatchObject({ by: "workflow", basis: "sender_record", runId: "run-wa" });
      // the other run's act is not this message: it stays listed on its own
      expect(out.find((x) => x.id === "a-other")?.kind).toBe("followup_act");
    });

    it("pairs a ledger act of the SAME run by identity, whatever its time, carrying its slug and LLM alias", () => {
      const out = attributeSentMessages(
        [rec({ kind: "reply_sent", sentBy: "automation", sendingRunId: "run-fu", campaignId: null })],
        [act({ occurredAt: "2026-10-19T13:00:00.000Z", llmAlias: "claude-opus-5-5" })],
      );
      expect(out).toHaveLength(1);
      expect(out[0].writtenBy).toMatchObject({
        basis: "sender_record",
        runId: "run-fu",
        workflowSlug: "ai-follow-up-email-algenib-v11",
        campaignId: "c-fu",
        llmAlias: "claude-opus-5-5",
        llmAliasReason: null,
      });
    });

    it("a person's reply stays a person's even if a run is named", () => {
      const [m] = attributeSentMessages([rec({ kind: "reply_sent", sentBy: "human", sendingRunId: "run-x" })], []);
      expect(m.writtenBy).toMatchObject({ by: "person", basis: "person", runId: null });
    });

    it("a record naming no run keeps today's answer", () => {
      const [m] = attributeSentMessages([rec({ kind: "reply_sent", sentBy: "automation" })], []);
      expect(m.writtenBy).toMatchObject({ by: "unknown", reason: "no_recorded_run" });
    });
  });
});
