/**
 * FACTORY-P2-CONTENT-OUTCOMES + OUTCOME-FINEST-1106: which Unit a link names (`dy_unit=<outcome>:<service>:<id>`, legacy
 * `dy_post=<service>:<id>`), what one visit is, and the declaration a touch makes (src/lib/post-touch.ts). Pure; the SQL
 * and the ledger read are covered in tests/integration/post-touch-sql.test.ts.
 */
import { describe, expect, it } from "vitest";

const { parsePostTouch, postVisitVerdict, earliestTouches, postTouchDeclaration, unitOutcomeFrom } = await import("../../src/lib/post-touch.js");

const ID = "cb162cb2-b4f1-4a62-aab0-08697e630fb7";
const LEGACY = { subjectService: "meta-service", subjectId: ID, outcomeKey: null };

describe("parsePostTouch: the legacy dy_post marker", () => {
  it("reads the post's subject off the param, the colon plain or URL-encoded; the outcome is left to the ledger", () => {
    expect(parsePostTouch(`https://distribute.you/?dy_post=meta-service:${ID}`)).toEqual(LEGACY);
    expect(parsePostTouch(`https://distribute.you/pricing?utm_source=threads&dy_post=meta-service%3A${ID}#how`)).toEqual(LEGACY);
    // The id is everything after the FIRST colon, verbatim.
    expect(parsePostTouch("https://x.io/?dy_post=social-service:a:b")).toEqual({ subjectService: "social-service", subjectId: "a:b", outcomeKey: null });
    // The same value twice is one post.
    expect(parsePostTouch(`https://x.io/?dy_post=meta-service:${ID}&dy_post=meta-service:${ID}`)).toEqual(LEGACY);
  });

  it("is no touch without a valid marker", () => {
    for (const url of [
      null,
      undefined,
      "",
      "not a url",
      "https://distribute.you/",
      "https://distribute.you/?utm_source=threads",
      "https://distribute.you/?dy_sub=abc",
      "https://distribute.you/?dy_post=",
      "https://distribute.you/?dy_post=meta-service",
      `https://distribute.you/?dy_post=:${ID}`,
      "https://distribute.you/?dy_post=meta-service:",
      `https://distribute.you/?dy_post=Meta-Service:${ID}`,
      `https://distribute.you/?dy_post=9meta:${ID}`,
      `https://distribute.you/?dy_post=meta_service:${ID}`,
      `https://distribute.you/?dy_post=meta-service:%20${ID}`,
      `https://distribute.you/?dy_post=meta-service:${"x".repeat(257)}`,
      `https://distribute.you/?dy_post=meta-service:${ID}&dy_post=meta-service:other`,
      `https://distribute.you/?DY_POST=meta-service:${ID}`,
      // dy_unit malformed: no outcome, bad outcome key, bad subject, several values.
      "https://distribute.you/?dy_unit=",
      `https://distribute.you/?dy_unit=transactional-email-service:${ID}`,
      `https://distribute.you/?dy_unit=Newsletter_Email_Sent:transactional-email-service:${ID}`,
      `https://distribute.you/?dy_unit=x:transactional-email-service:${ID}`,
      `https://distribute.you/?dy_unit=newsletter_email_sent:Transactional:${ID}`,
      "https://distribute.you/?dy_unit=newsletter_email_sent:transactional-email-service:",
      `https://distribute.you/?dy_unit=newsletter_email_sent:transactional-email-service:${ID}&dy_unit=newsletter_email_sent:transactional-email-service:other`,
      // A malformed marker beside a valid one, or two markers naming different subjects: no touch.
      `https://distribute.you/?dy_unit=bad&dy_post=meta-service:${ID}`,
      `https://distribute.you/?dy_unit=threads_post_published:meta-service:${ID}&dy_post=meta-service:other`,
      `https://distribute.you/?dy_unit=threads_post_published:meta-service:${ID}&dy_post=bad`,
    ]) {
      expect(parsePostTouch(url), String(url)).toBeNull();
    }
    expect(parsePostTouch(`https://distribute.you/?dy_post=meta-service:${"x".repeat(256)}`)).not.toBeNull();
  });
});

describe("parsePostTouch: the generic dy_unit marker", () => {
  it("reads the Unit's outcome and subject, the colons plain or URL-encoded", () => {
    expect(parsePostTouch(`https://distribute.you/?dy_sub=abc&dy_unit=newsletter_email_sent:transactional-email-service:${ID}`)).toEqual({
      outcomeKey: "newsletter_email_sent",
      subjectService: "transactional-email-service",
      subjectId: ID,
    });
    expect(parsePostTouch("https://distribute.you/blog?dy_unit=x_post_published%3Ax-service%3Aa%3Ab#top")).toEqual({
      outcomeKey: "x_post_published",
      subjectService: "x-service",
      subjectId: "a:b",
    });
  });

  it("a dy_post naming the same subject agrees: the dy_unit outcome wins", () => {
    expect(parsePostTouch(`https://distribute.you/?dy_post=meta-service:${ID}&dy_unit=threads_post_published:meta-service:${ID}`)).toEqual({
      outcomeKey: "threads_post_published",
      subjectService: "meta-service",
      subjectId: ID,
    });
  });
});

describe("unitOutcomeFrom", () => {
  it("one produced outcome = the Unit's; none = not on the ledger yet; several = ambiguous, never a pick", () => {
    expect(unitOutcomeFrom(["threads_post_published", "threads_post_published"])).toEqual({ kind: "resolved", outcomeKey: "threads_post_published" });
    expect(unitOutcomeFrom(["post_published"])).toEqual({ kind: "resolved", outcomeKey: "post_published" });
    expect(unitOutcomeFrom([])).toEqual({ kind: "not_on_ledger" });
    expect(unitOutcomeFrom(["post_published", "post_drafted"])).toEqual({ kind: "ambiguous", outcomeKeys: ["post_drafted", "post_published"] });
  });
});

describe("postVisitVerdict", () => {
  const row = { factId: "f1", orgId: "o", brandId: "b", firstUrl: `https://distribute.you/?dy_post=meta-service:${ID}`, occurredAt: "2026-10-28T10:00:00.000Z", leadIds: ["l1"], emails: ["a@x.io"], fullName: null };

  it("credits one lead of the brand", () => {
    expect(postVisitVerdict(row)).toEqual({
      kind: "touch",
      touch: { orgId: "o", brandId: "b", leadId: "l1", post: LEGACY, visitFactId: "f1", occurredAt: "2026-10-28T10:00:00.000Z" },
    });
  });

  it("skips no marker, no lead, several leads", () => {
    expect(postVisitVerdict({ ...row, firstUrl: "https://distribute.you/" })).toEqual({ kind: "not_a_post_touch" });
    expect(postVisitVerdict({ ...row, leadIds: [] })).toEqual({ kind: "no_lead", fileEmail: null });
    expect(postVisitVerdict({ ...row, leadIds: ["l2", "l1", "l2"] })).toEqual({ kind: "ambiguous_lead", leadIds: ["l1", "l2"] });
  });
});

describe("postVisitVerdict: a clicker who is no lead yet", () => {
  const unitUrl = `https://distribute.you/?dy_unit=newsletter_email_sent:transactional-email-service:${ID}`;
  const row = { factId: "f1", orgId: "o", brandId: "b", firstUrl: unitUrl, occurredAt: "2026-10-28T10:00:00.000Z", leadIds: [], emails: ["sub@x.io"], fullName: null };

  it("a link naming its Unit, one identified address: that person is filed", () => {
    expect(postVisitVerdict(row)).toEqual({ kind: "no_lead", fileEmail: "sub@x.io" });
  });

  it("nobody is filed: no address, several addresses, a legacy post link", () => {
    expect(postVisitVerdict({ ...row, emails: [] })).toEqual({ kind: "no_lead", fileEmail: null });
    expect(postVisitVerdict({ ...row, emails: ["a@x.io", "b@x.io"] })).toEqual({ kind: "no_lead", fileEmail: null });
    expect(postVisitVerdict({ ...row, firstUrl: `https://distribute.you/?dy_post=meta-service:${ID}` })).toEqual({ kind: "no_lead", fileEmail: null });
  });
});

describe("earliestTouches", () => {
  it("keeps the earliest visit per (org, brand, lead, Unit), an undated one only when none is dated", () => {
    const t = (visitFactId: string, occurredAt: string | null, leadId = "l1") => ({ orgId: "o", brandId: "b", leadId, post: LEGACY, visitFactId, occurredAt });
    const out = earliestTouches([t("late", "2026-10-28T12:00:00.000Z"), t("undated", null), t("early", "2026-10-28T09:00:00.000Z"), t("other", null, "l2")]);
    expect(out.map((x) => x.visitFactId).sort()).toEqual(["early", "other"]);
  });

  it("a later visit whose link STATES the outcome settles it for the earliest visit of the same Unit", () => {
    const base = { orgId: "o", brandId: "b", leadId: "l1" };
    const stated = { ...LEGACY, outcomeKey: "threads_post_published" };
    const out = earliestTouches([
      { ...base, post: LEGACY, visitFactId: "early", occurredAt: "2026-10-28T09:00:00.000Z" },
      { ...base, post: stated, visitFactId: "late", occurredAt: "2026-10-28T12:00:00.000Z" },
    ]);
    expect(out).toEqual([{ ...base, post: stated, visitFactId: "early", occurredAt: "2026-10-28T09:00:00.000Z" }]);
  });
});

describe("postTouchDeclaration", () => {
  it("produces the lead's website_visit, consumes the Unit's own outcome (never a fixed one), dated at the visit", () => {
    for (const outcomeKey of ["post_published", "threads_post_published", "newsletter_email_sent"]) {
      expect(
        postTouchDeclaration({ orgId: "o", runId: "r", leadId: "l1", unit: { outcomeKey, subjectService: "svc", subjectId: ID }, occurredAt: "2026-10-28T10:00:00.000Z" }),
      ).toEqual({
        orgId: "o",
        runId: "r",
        produced: [{ outcomeKey: "website_visit", subjectService: "lead-service", subjectId: "l1", performer: { kind: "tracker" } }],
        consumed: [{ outcomeKey, subjectService: "svc", subjectId: ID }],
        occurredAt: "2026-10-28T10:00:00.000Z",
      });
    }
  });
});
