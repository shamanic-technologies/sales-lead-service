import { describe, expect, it } from "vitest";
import {
  CRM_FORM_SUBMITTED_EVENT,
  evidenceFromEvents,
  formSubmissionsFrom,
  positiveReplyEvidence,
} from "../../src/lib/crm-evidence.js";
import { bucketsForRow } from "../../src/lib/lead-buckets.js";
import { DEFAULT_STATUS } from "../../src/lib/delivery-flatten.js";

const FIRST_EMAIL = "2026-05-11T00:00:00.000Z";
const form = (occurredAt: string | null) => ({
  step: "form_submitted",
  occurredAt,
  dateBasis: "submitted_at",
  source: "form_submission",
  sourceId: occurredAt,
});

describe("a form submitted in their CRM, read as a positive reply", () => {
  it("reads crm-service's own token, verbatim", () => {
    expect(CRM_FORM_SUBMITTED_EVENT).toBe("form_submitted");
    expect(evidenceFromEvents([form("2026-05-20T00:00:00.000Z")])[0]).toMatchObject({
      kind: "outcome",
      step: "positive_reply",
      crmStep: "form_submitted",
    });
  });

  it("is the earliest submission AFTER our first delivered email", () => {
    const subs = formSubmissionsFrom([
      form("2026-05-01T00:00:00.000Z"),
      form("2026-05-25T00:00:00.000Z"),
      form("2026-05-15T00:00:00.000Z"),
      { step: "sale", occurredAt: "2026-05-12T00:00:00.000Z", dateBasis: null, source: null, sourceId: null },
    ]);
    expect(subs).toHaveLength(3);
    expect(positiveReplyEvidence(subs, FIRST_EMAIL)?.occurredAt).toBe("2026-05-15T00:00:00.000Z");
  });

  it("is nothing when every form predates our first email, is undated, or we never delivered", () => {
    expect(positiveReplyEvidence(formSubmissionsFrom([form("2026-05-01T00:00:00.000Z")]), FIRST_EMAIL)).toBeNull();
    expect(positiveReplyEvidence(formSubmissionsFrom([form(FIRST_EMAIL)]), FIRST_EMAIL)).toBeNull();
    expect(positiveReplyEvidence(formSubmissionsFrom([form(null)]), FIRST_EMAIL)).toBeNull();
    expect(positiveReplyEvidence(formSubmissionsFrom([form("2026-05-20T00:00:00.000Z")]), null)).toBeNull();
  });

  it("puts the lead in the positive-reply bucket beside the delivery layer's own positive reply", () => {
    const none = new Set<never>();
    expect(bucketsForRow({ ...DEFAULT_STATUS, contacted: true }, none).has("positive_reply")).toBe(false);
    expect(bucketsForRow({ ...DEFAULT_STATUS, contacted: true }, none, true).has("positive_reply")).toBe(true);
  });
});
