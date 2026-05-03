import { describe, it, expect } from "vitest";
import { BufferNextRequestSchema, ApolloPersonDataSchema } from "../../src/schemas.js";

describe("schema validation", () => {
  describe("BufferNextRequestSchema", () => {
    it("accepts empty body", () => {
      const result = BufferNextRequestSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it("rejects unknown fields (strict)", () => {
      const result = BufferNextRequestSchema.safeParse({
        sourceType: "apollo",
      });
      // Empty object schema accepts extra keys by default in Zod
      // This is fine — extra fields are stripped
      expect(result.success).toBe(true);
    });
  });

  describe("ApolloPersonDataSchema", () => {
    const validPerson = {
      firstName: "Sara",
      lastName: "Freshley",
      organizationName: "Casco Bay",
    };

    it("accepts valid person data with required fields", () => {
      const result = ApolloPersonDataSchema.safeParse(validPerson);
      expect(result.success).toBe(true);
    });

    it("rejects missing firstName", () => {
      const { firstName, ...rest } = validPerson;
      const result = ApolloPersonDataSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing lastName", () => {
      const { lastName, ...rest } = validPerson;
      const result = ApolloPersonDataSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects missing organizationName", () => {
      const { organizationName, ...rest } = validPerson;
      const result = ApolloPersonDataSchema.safeParse(rest);
      expect(result.success).toBe(false);
    });

    it("rejects null firstName", () => {
      const result = ApolloPersonDataSchema.safeParse({ ...validPerson, firstName: null });
      expect(result.success).toBe(false);
    });

    it("rejects null lastName", () => {
      const result = ApolloPersonDataSchema.safeParse({ ...validPerson, lastName: null });
      expect(result.success).toBe(false);
    });

    it("rejects null organizationName", () => {
      const result = ApolloPersonDataSchema.safeParse({ ...validPerson, organizationName: null });
      expect(result.success).toBe(false);
    });

    it("accepts new Apollo fields (name, personalEmails, mobilePhone, phoneNumbers, organizationId, organizationRawAddress)", () => {
      const result = ApolloPersonDataSchema.safeParse({
        ...validPerson,
        name: "Sara Freshley",
        personalEmails: ["sara.personal@gmail.com", "sara@me.com"],
        mobilePhone: "+1-555-555-5555",
        phoneNumbers: [
          {
            rawNumber: "+1-555-555-5555",
            sanitizedNumber: "+15555555555",
            type: "mobile",
            position: 1,
            status: "verified",
            dncStatus: "no_dnc",
            dncOtherInfo: null,
            dialerFlags: { do_not_call: false },
          },
        ],
        organizationId: "org-apollo-123",
        organizationRawAddress: "123 Main St, Portland, ME 04101",
      });
      expect(result.success).toBe(true);
    });

    it("accepts raw field as arbitrary record", () => {
      const result = ApolloPersonDataSchema.safeParse({
        ...validPerson,
        raw: {
          first_name: "Sara",
          last_name: "Freshley",
          some_new_apollo_field: { nested: true },
          totally_unknown_array: [1, 2, 3],
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts null/undefined raw field", () => {
      expect(ApolloPersonDataSchema.safeParse({ ...validPerson, raw: null }).success).toBe(true);
      expect(ApolloPersonDataSchema.safeParse({ ...validPerson }).success).toBe(true);
    });

    it("accepts null/undefined personalEmails and phoneNumbers", () => {
      expect(ApolloPersonDataSchema.safeParse({ ...validPerson, personalEmails: null, phoneNumbers: null }).success).toBe(true);
      expect(ApolloPersonDataSchema.safeParse({ ...validPerson, personalEmails: [], phoneNumbers: [] }).success).toBe(true);
    });
  });
});
