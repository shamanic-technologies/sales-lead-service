/** UNIBOX-PERSON-NAME-1021: a Unibox row names WHO it is, never an address. */
import { describe, expect, it } from "vitest";
import { personIdentityOf } from "../../src/lib/unibox-dimensions.js";

const lead = (over: Partial<Parameters<typeof personIdentityOf>[1][number]> = {}) => ({
  leadId: "a",
  firstName: null,
  lastName: null,
  name: null,
  titles: [],
  ...over,
});

describe("personIdentityOf", () => {
  it("serves the sourced name and title of the relation's lead (Andreas, cold-emailed, no crm name)", () => {
    expect(
      personIdentityOf(null, [lead({ firstName: "Andreas", lastName: "Oberleitner", name: "Andreas Oberleitner", titles: ["Head of Regulatory Affairs"] })]),
    ).toEqual({ name: "Andreas Oberleitner", firstName: "Andreas", lastName: "Oberleitner", title: "Head of Regulatory Affairs" });
  });

  it("falls back to crm's name, never an address", () => {
    expect(personIdentityOf("Ben Smith", [])).toMatchObject({ name: "Ben Smith", firstName: null, title: null });
    expect(personIdentityOf("andreas.oberleitner@platomics.com", [])).toEqual({ name: null, firstName: null, lastName: null, title: null });
    expect(personIdentityOf(null, [lead({ name: "ana@x.io" })]).name).toBeNull();
  });

  it("prefers the lead that has a name; a title from any lead when that one has none", () => {
    const got = personIdentityOf("Ana", [lead({ leadId: "a", titles: ["CTO @ Acme"] }), lead({ leadId: "b", firstName: "Ana", lastName: "Lopez" })]);
    expect(got).toEqual({ name: "Ana Lopez", firstName: "Ana", lastName: "Lopez", title: "CTO @ Acme" });
    expect(personIdentityOf(null, [lead({ lastName: "Lopez" })]).name).toBe("Lopez");
  });
});
