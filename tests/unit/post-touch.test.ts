/**
 * FACTORY-P2-CONTENT-OUTCOMES: what a post's link names (`dy_post=<subjectService>:<subjectId>`), what one visit is,
 * and the declaration a post touch makes (src/lib/post-touch.ts). Pure; the SQL is covered in
 * tests/integration/post-touch-sql.test.ts.
 */
import { describe, expect, it } from "vitest";

const { parsePostTouch, postVisitVerdict, earliestTouches, postTouchDeclaration } = await import("../../src/lib/post-touch.js");

const ID = "cb162cb2-b4f1-4a62-aab0-08697e630fb7";

describe("parsePostTouch", () => {
  it("reads the post's subject off the param, the colon plain or URL-encoded", () => {
    expect(parsePostTouch(`https://distribute.you/?dy_post=meta-service:${ID}`)).toEqual({ subjectService: "meta-service", subjectId: ID });
    expect(parsePostTouch(`https://distribute.you/pricing?utm_source=threads&dy_post=meta-service%3A${ID}#how`)).toEqual({ subjectService: "meta-service", subjectId: ID });
    // The id is everything after the FIRST colon, verbatim.
    expect(parsePostTouch("https://x.io/?dy_post=social-service:a:b")).toEqual({ subjectService: "social-service", subjectId: "a:b" });
    // The same value twice is one post.
    expect(parsePostTouch(`https://x.io/?dy_post=meta-service:${ID}&dy_post=meta-service:${ID}`)).toEqual({ subjectService: "meta-service", subjectId: ID });
  });

  it("is no post touch without a valid param", () => {
    for (const url of [
      null,
      undefined,
      "",
      "not a url",
      "https://distribute.you/",
      "https://distribute.you/?utm_source=threads",
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
    ]) {
      expect(parsePostTouch(url), String(url)).toBeNull();
    }
    expect(parsePostTouch(`https://distribute.you/?dy_post=meta-service:${"x".repeat(256)}`)).not.toBeNull();
  });
});

describe("postVisitVerdict", () => {
  const row = { factId: "f1", orgId: "o", brandId: "b", firstUrl: `https://distribute.you/?dy_post=meta-service:${ID}`, occurredAt: "2026-10-28T10:00:00.000Z", leadIds: ["l1"] };

  it("credits one lead of the brand", () => {
    expect(postVisitVerdict(row)).toEqual({
      kind: "touch",
      touch: { orgId: "o", brandId: "b", leadId: "l1", post: { subjectService: "meta-service", subjectId: ID }, visitFactId: "f1", occurredAt: "2026-10-28T10:00:00.000Z" },
    });
  });

  it("skips no param, no lead, several leads", () => {
    expect(postVisitVerdict({ ...row, firstUrl: "https://distribute.you/" })).toEqual({ kind: "not_a_post_touch" });
    expect(postVisitVerdict({ ...row, leadIds: [] })).toEqual({ kind: "no_lead" });
    expect(postVisitVerdict({ ...row, leadIds: ["l2", "l1", "l2"] })).toEqual({ kind: "ambiguous_lead", leadIds: ["l1", "l2"] });
  });
});

describe("earliestTouches", () => {
  it("keeps the earliest visit per (org, brand, lead, post), an undated one only when none is dated", () => {
    const post = { subjectService: "meta-service", subjectId: ID };
    const t = (visitFactId: string, occurredAt: string | null, leadId = "l1") => ({ orgId: "o", brandId: "b", leadId, post, visitFactId, occurredAt });
    const out = earliestTouches([t("late", "2026-10-28T12:00:00.000Z"), t("undated", null), t("early", "2026-10-28T09:00:00.000Z"), t("other", null, "l2")]);
    expect(out.map((x) => x.visitFactId).sort()).toEqual(["early", "other"]);
  });
});

describe("postTouchDeclaration", () => {
  it("produces the lead's website_visit, consumes the post's post_published, dated at the visit", () => {
    expect(postTouchDeclaration({ orgId: "o", runId: "r", leadId: "l1", post: { subjectService: "meta-service", subjectId: ID }, occurredAt: "2026-10-28T10:00:00.000Z" })).toEqual({
      orgId: "o",
      runId: "r",
      produced: [{ outcomeKey: "website_visit", subjectService: "lead-service", subjectId: "l1" }],
      consumed: [{ outcomeKey: "post_published", subjectService: "meta-service", subjectId: ID }],
      occurredAt: "2026-10-28T10:00:00.000Z",
    });
  });
});
