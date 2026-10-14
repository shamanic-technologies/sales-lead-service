import { describe, expect, it } from "vitest";
import {
  ALL_CALLING_CODES,
  ALL_TABLE_ZONES,
  countryOfEmail,
  countryOfName,
  countryOfPhone,
  inferTimezone,
  isIanaTimezone,
} from "../../src/lib/timezone-inference.js";

describe("timezone inference (PUSHED-PERSON-TZ-1014)", () => {
  it("every zone the tables answer is a zone the runtime can schedule in", () => {
    for (const zone of ALL_TABLE_ZONES) expect(isIanaTimezone(zone), zone).toBe(true);
  });

  it("no calling code is a prefix of another (a number dials one country)", () => {
    for (const a of ALL_CALLING_CODES) {
      for (const b of ALL_CALLING_CODES) if (a !== b) expect(b.startsWith(a), `${a} prefixes ${b}`).toBe(false);
    }
  });

  it("reads the country of an international number, never of a national or shared one", () => {
    expect(countryOfPhone("+44 7700 900123")).toBe("GB");
    expect(countryOfPhone("0044 (0)20-7946-0958".replace("(0)", ""))).toBe("GB");
    expect(countryOfPhone("+33 6 12 34 56 78")).toBe("FR");
    expect(countryOfPhone("+353 87 123 4567")).toBe("IE");
    expect(countryOfPhone("07700 900123")).toBeNull();
    expect(countryOfPhone("+1 415 555 0100")).toBeNull();
    expect(countryOfPhone("+7 495 123 45 67")).toBeNull();
    expect(countryOfPhone("+44")).toBeNull();
    expect(countryOfPhone("")).toBeNull();
  });

  it("reads the country of a country-code domain, never of a generic one", () => {
    expect(countryOfEmail("jane@acme.co.uk")).toBe("GB");
    expect(countryOfEmail("jane@ACME.UK")).toBe("GB");
    expect(countryOfEmail("jean@societe.fr")).toBe("FR");
    expect(countryOfEmail("jane@acme.com")).toBeNull();
    expect(countryOfEmail("jane@startup.io")).toBeNull();
    expect(countryOfEmail("jane@startup.co")).toBeNull();
    expect(countryOfEmail("jane@fund.vc")).toBeNull();
    expect(countryOfEmail("not-an-address")).toBeNull();
  });

  it("reads country names the enrichment writes", () => {
    expect(countryOfName("United Kingdom")).toBe("GB");
    expect(countryOfName("united states")).toBe("US");
    expect(countryOfName("Czechia")).toBe("CZ");
    expect(countryOfName("Côte d'Ivoire")).toBe("CI");
    expect(countryOfName("Atlantis")).toBeNull();
    expect(countryOfName(null)).toBeNull();
  });

  it("a +44 phone or a .co.uk address alone reads Europe/London", () => {
    expect(inferTimezone({ phones: ["+447700900123"] })).toEqual({ timezone: "Europe/London", basis: "phone_country", country: "GB" });
    expect(inferTimezone({ emails: ["boss@employer.co.uk"] })).toEqual({ timezone: "Europe/London", basis: "email_domain", country: "GB" });
  });

  it("nothing to read = null, never a fabricated zone", () => {
    expect(inferTimezone({})).toBeNull();
    expect(inferTimezone({ emails: ["jane@gmail.com"], phones: ["07700 900123"] })).toBeNull();
  });

  it("a country of several clocks with nothing settling it stays unknown", () => {
    expect(inferTimezone({ leadCountry: "United States" })).toBeNull();
    expect(inferTimezone({ leadCountry: "Australia", phones: ["+61 2 9999 9999"] })).toBeNull();
  });

  it("a state settles a country of several clocks", () => {
    expect(inferTimezone({ leadCountry: "United States", leadState: "California" })?.timezone).toBe("America/Los_Angeles");
    expect(inferTimezone({ leadCountry: "United States", leadState: "NY" })?.timezone).toBe("America/New_York");
    expect(inferTimezone({ leadCountry: "Canada", leadState: "Ontario" })?.timezone).toBe("America/Toronto");
  });

  it("the strongest signal fixes the country; weaker ones only refine within it", () => {
    // The person lives in the US: a .co.uk address never moves them to London.
    expect(inferTimezone({ leadCountry: "United States", emails: ["jane@acme.co.uk"] })).toBeNull();
    // US with no state, employer in Texas: the employer's state settles it.
    expect(
      inferTimezone({ leadCountry: "United States", companyCountry: "United States", companyState: "Texas" }),
    ).toEqual({ timezone: "America/Chicago", basis: "company_location", country: "US" });
    // Location beats phone; phone beats company and email.
    expect(inferTimezone({ leadCountry: "France", phones: ["+447700900123"] })?.timezone).toBe("Europe/Paris");
    expect(inferTimezone({ phones: ["+447700900123"], companyCountry: "Germany", emails: ["x@y.fr"] })?.timezone).toBe(
      "Europe/London",
    );
  });

  it("validates a stated zone: IANA names only", () => {
    expect(isIanaTimezone("Europe/London")).toBe(true);
    expect(isIanaTimezone("America/Argentina/Buenos_Aires")).toBe(true);
    expect(isIanaTimezone("UTC")).toBe(true);
    expect(isIanaTimezone("Mars/Olympus")).toBe(false);
    expect(isIanaTimezone("+01:00")).toBe(false);
    expect(isIanaTimezone("GMT+1")).toBe(false);
    expect(isIanaTimezone("")).toBe(false);
  });
});
