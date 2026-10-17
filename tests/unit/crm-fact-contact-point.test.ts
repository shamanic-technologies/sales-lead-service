/**
 * PERSON-RELATIONS-1017: each copied crm fact names the contact point it happened on, the key a relation's
 * `contactPoints[].id` uses, so a relation's thread holds only its own points' facts.
 */
import { describe, expect, it } from "vitest";
import { contactPointOf, parseCrmFact } from "../../src/lib/crm-fact-feed.js";

const base = {
  factId: "f1",
  seq: "1",
  orgId: "o",
  brandId: "b",
  personKey: "email:a@x.io",
  sourceContactId: "@whatsapp_lid-1:matrix.distribute.you",
  crmContactId: null,
  fullName: null,
  emails: [],
  phones: [],
  type: "message_in",
  occurredAt: null,
  dateBasis: "sent_at",
  source: "matrix",
  sourceRef: "$evt",
  payload: {},
};

describe("contact point of a crm fact", () => {
  it("is crm-service's contactPoint when served", () => {
    expect(parseCrmFact({ ...base, source: "gmail", sourceContactId: null, contactPoint: "gmail:jo@acme.io" }).contactPoint).toBe("gmail:jo@acme.io");
  });
  it("falls back to source:sourceContactId for a fact served before crm named one", () => {
    expect(parseCrmFact(base).contactPoint).toBe("matrix:@whatsapp_lid-1:matrix.distribute.you");
  });
  it("is null when nothing names a point (a registry fact, a CSV row)", () => {
    expect(contactPointOf({ contactPoint: null }, "crm", null)).toBeNull();
    expect(contactPointOf({}, "csv", "")).toBeNull();
  });
});
