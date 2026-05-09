import { describe, it, expect } from "vitest";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../../src/schemas.js";

interface SchemaDef {
  description?: string;
  example?: unknown;
  properties?: Record<string, { description?: string; example?: unknown }>;
}

const generator = new OpenApiGeneratorV3(registry.definitions);
const doc = generator.generateDocument({
  openapi: "3.0.0",
  info: { title: "test", version: "1.0.0" },
  servers: [],
});
const components = (doc.components as { schemas: Record<string, SchemaDef> }).schemas;

describe("OpenAPI generated document", () => {
  it("registers FullLead schema", () => {
    expect(components.FullLead).toBeDefined();
  });

  it("registers OrganizationView schema", () => {
    expect(components.OrganizationView).toBeDefined();
  });

  it("registers ContactMethodView schema", () => {
    expect(components.ContactMethodView).toBeDefined();
  });

  it("registers EmploymentEntryView schema", () => {
    expect(components.EmploymentEntryView).toBeDefined();
  });

  it("FullLead has description and example", () => {
    expect(components.FullLead.description).toBeTruthy();
    expect(components.FullLead.example).toBeTruthy();
  });

  it("OrganizationView has description and example", () => {
    expect(components.OrganizationView.description).toBeTruthy();
    expect(components.OrganizationView.example).toBeTruthy();
  });

  it("ContactMethodView has description and example", () => {
    expect(components.ContactMethodView.description).toBeTruthy();
    expect(components.ContactMethodView.example).toBeTruthy();
  });

  it("EmploymentEntryView has description and example", () => {
    expect(components.EmploymentEntryView.description).toBeTruthy();
    expect(components.EmploymentEntryView.example).toBeTruthy();
  });

  it("does not expose ApolloPersonData (legacy schema dropped)", () => {
    expect(components.ApolloPersonData).toBeUndefined();
  });

  it("FullLead has no metadata or raw property in public contract", () => {
    const props = components.FullLead.properties ?? {};
    expect(props.metadata).toBeUndefined();
    expect(props.raw).toBeUndefined();
  });

  it("every primitive FullLead property has a description (nested $refs documented on their own schema)", () => {
    const props = components.FullLead.properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      const isRef = (prop as Record<string, unknown>).$ref !== undefined;
      const isArrayOfRef =
        (prop as Record<string, unknown>).type === "array" &&
        ((prop as Record<string, unknown>).items as Record<string, unknown> | undefined)?.$ref !==
          undefined;
      if (isRef || isArrayOfRef) continue;
      expect(prop.description, `FullLead.${name} missing description`).toBeTruthy();
    }
  });

  it("every OrganizationView property has a description", () => {
    const props = components.OrganizationView.properties ?? {};
    for (const [name, prop] of Object.entries(props)) {
      expect(
        prop.description,
        `OrganizationView.${name} missing description`,
      ).toBeTruthy();
    }
  });
});
