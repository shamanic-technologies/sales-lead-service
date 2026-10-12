/**
 * The pure half of filing social engagers as leads: which identity a person is held by, and which
 * timeline row an engagement becomes (src/lib/social-identity.ts, src/lib/social-engagements.ts).
 */
import { describe, expect, it } from "vitest";
import { linkedinHandleOf, socialIdentityOf } from "../../src/lib/social-identity.js";
import { engagementLabel, engagementRow, SocialEngagementFactSchema } from "../../src/lib/social-engagements.js";

// The real shape social-service served on 2026-10-12 for Kevin's LinkedIn post.
const comment = {
  id: "c21fa59b-3cce-4e35-8016-f100cb56d216",
  sourceRef: "linkedin:7515354284419563520:comment:urn:li:comment:(ugcPost:7515354283031027712,7515378370516500480)",
  label: "industry_update_video", stepKey: "industry_update_video",
  campaignId: "camp-1", orgId: "org-1", brandId: "brand-1", socialPostId: null,
  platform: "linkedin", postId: "urn:li:activity:7515354284419563520", postUrl: null,
  kind: "comment", reactionType: null,
  person: {
    key: "linkedin:ACoAAA_z_HcBwWGcfaanDtTKRu0gaaPjTydP89k", name: "Cristian-George Farauanu", handle: "george-farauanu",
    profileUrl: "https://www.linkedin.com/in/george-farauanu", urn: "urn:li:fsd_profile:ACoAAA_z_HcBwWGcfaanDtTKRu0gaaPjTydP89k",
    headline: "Business Development @ Featherless.ai",
  },
  text: "Worth asking which model...", url: "https://www.linkedin.com/feed/update/x",
  occurredAt: "2026-10-12T11:50:32.510Z", firstSeenAt: "2026-10-12T16:16:53.879Z", lastSeenAt: "2026-10-12T16:16:53.879Z",
};
const reaction = {
  ...comment,
  sourceRef: "linkedin:7515354284419563520:reaction:ACoAAA_z_HcBwWGcfaanDtTKRu0gaaPjTydP89k",
  kind: "reaction", reactionType: "LIKE", text: null, url: null, occurredAt: null,
  person: { ...comment.person, handle: "ACoAAA_z_HcBwWGcfaanDtTKRu0gaaPjTydP89k",
    profileUrl: "https://www.linkedin.com/in/ACoAAA_z_HcBwWGcfaanDtTKRu0gaaPjTydP89k" },
};

describe("social identity", () => {
  it("reads the vanity handle off a LinkedIn URL, any spelling", () => {
    expect(linkedinHandleOf("http://www.linkedin.com/in/George-Farauanu/")).toBe("george-farauanu");
    expect(linkedinHandleOf("https://linkedin.com/in/jacob-funk-71918487?x=1")).toBe("jacob-funk-71918487");
    expect(linkedinHandleOf("https://x.com/jasonlk")).toBeNull();
    expect(linkedinHandleOf(null)).toBeNull();
  });

  it("a commenter shows the vanity handle: held by key AND handle", () => {
    const id = socialIdentityOf("linkedin", comment.person);
    expect(id).toEqual({
      socialKey: comment.person.key,
      linkedinHandle: "george-farauanu",
      xHandle: null,
      linkedinUrl: "https://www.linkedin.com/in/george-farauanu",
    });
  });

  it("a reactor shows only the member id: never taken for a vanity handle", () => {
    const id = socialIdentityOf("linkedin", reaction.person);
    expect(id.socialKey).toBe(comment.person.key);
    expect(id.linkedinHandle).toBeNull();
    expect(id.linkedinUrl).toBe(reaction.person.profileUrl);
  });

  it("an X engager is held by the lowercased handle", () => {
    const id = socialIdentityOf("x", { key: "x:JasonLK", name: "Jason", handle: "@JasonLK", profileUrl: null, urn: null, headline: null });
    expect(id).toMatchObject({ socialKey: "x:JasonLK", xHandle: "jasonlk", linkedinHandle: null });
  });
});

describe("engagement row", () => {
  it("parses the producer's shape", () => {
    expect(SocialEngagementFactSchema.safeParse(comment).success).toBe(true);
    expect(SocialEngagementFactSchema.safeParse(reaction).success).toBe(true);
  });

  it("the label is the step key the fact carries; a label outside the vocabulary is not placed", () => {
    expect(engagementLabel(SocialEngagementFactSchema.parse(comment))).toBe("industry_update_video");
    expect(engagementLabel(SocialEngagementFactSchema.parse({ ...comment, label: null }))).toBe("industry_update_video");
    expect(engagementLabel(SocialEngagementFactSchema.parse({ ...comment, label: null, stepKey: null }))).toBeNull();
    expect(engagementLabel(SocialEngagementFactSchema.parse({ ...comment, label: "some_future_step" }))).toBeNull();
  });

  it("is keyed on the sourceRef, attributable, on the campaign's offer", () => {
    const fact = SocialEngagementFactSchema.parse(comment);
    const row = engagementRow({ ...fact, orgId: "org-1", brandId: "brand-1" }, "industry_update_video", "lead-1", new Map([["camp-1", "offer-1"]]));
    expect(row).toMatchObject({
      id: `social:${comment.sourceRef}`, source: "social", source_ref: comment.sourceRef, label: "industry_update_video",
      lead_id: "lead-1", campaign_id: "camp-1", offer_id: "offer-1", attributable: true,
      attribution_basis: "reaction_to_our_post", occurred_at: comment.occurredAt, url: comment.url,
    });
    expect(row.detail).toMatchObject({ kind: "comment", dated: "occurred" });
  });

  it("an undated reaction is dated when social-service first saw it, and says so", () => {
    const fact = SocialEngagementFactSchema.parse(reaction);
    const row = engagementRow({ ...fact, orgId: "org-1", brandId: "brand-1" }, "industry_update_video", "lead-1", new Map());
    expect(row.occurred_at).toBe(reaction.firstSeenAt);
    expect(row.offer_id).toBeNull();
    expect(row.detail).toMatchObject({ dated: "first_seen", reactionType: "LIKE" });
  });
});
