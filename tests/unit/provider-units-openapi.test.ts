/**
 * ENGINE-GET-ASK-1123: a Script learns from the SERVED OpenAPI alone (1) where each outcome's Units are read (tag
 * `provider:<outcome key>` + operationId) and (2) every input the lead serve accepts. Checked on the document the
 * registry generates AND on the committed openapi.json (what the box serves).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { BufferNextRequestSchema, SERVE_EMPTY_REASON_MEANINGS, registry } from "../../src/schemas.js";
import { PROVIDER_UNIT_READS, UNIT_QUERY_PARAMS } from "../../src/lib/provider-units-query.js";
import { SERVE_EMPTY_REASONS } from "../../src/lib/serve-reasons.js";

type Operation = {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; description?: string }>;
  requestBody?: { content: Record<string, { schema: { $ref?: string } }> };
  responses: Record<string, unknown>;
};
type Doc = { paths: Record<string, Record<string, Operation>>; components: { schemas: Record<string, { properties?: Record<string, { description?: string }> }> } };

const generated = new OpenApiGeneratorV3(registry.definitions).generateDocument({
  openapi: "3.0.0",
  info: { title: "test", version: "1.0.0" },
  servers: [],
}) as unknown as Doc;
const committed = JSON.parse(readFileSync(fileURLToPath(new URL("../../openapi.json", import.meta.url)), "utf8")) as Doc;

const SERVE_BODY_FIELDS = Object.keys(BufferNextRequestSchema.shape);
const SERVE_400_CODES = [
  "step_filter_needs_audience_serve",
  "named_lead_excludes_population",
  "due_followup_only_excludes",
  "due_followup_only_needs_outreach_campaign",
  "relation_population_needs_target_campaign",
  "population_needs_source_unit",
  "step_filter_refused",
];

for (const [name, doc] of [["generated document", generated], ["committed openapi.json", committed]] as const) {
  describe(`Provider reads in the ${name}`, () => {
    for (const read of PROVIDER_UNIT_READS) {
      it(`${read.path} carries ${read.tag} and ${read.operationId}`, () => {
        const op = doc.paths[read.path]?.get;
        expect(op, read.path).toBeDefined();
        expect(op.operationId).toBe(read.operationId);
        expect(op.tags).toEqual([read.tag]);
        const query = (op.parameters ?? []).filter((p) => p.in === "query");
        expect(query.map((p) => p.name).sort()).toEqual([...UNIT_QUERY_PARAMS[read.kind]].sort());
        for (const p of query) expect(p.description, `${read.path} ${p.name}`).toBeTruthy();
        expect(op.description).toContain("person_or_brand_filter_required");
        expect(op.description).toContain("**Indexes read.**");
        expect(op.description).toContain("**Examples.**");
        expect(Object.keys(op.responses).sort()).toEqual(["200", "400", "401", "500"]);
      });
    }

    it("exactly ONE operation carries each provider tag (a second one makes workflow-service ask which)", () => {
      const byTag = new Map<string, string[]>();
      for (const [path, item] of Object.entries(doc.paths)) {
        for (const [method, op] of Object.entries(item)) {
          for (const tag of op.tags ?? []) if (tag.startsWith("provider:")) byTag.set(tag, [...(byTag.get(tag) ?? []), `${method} ${path}`]);
        }
      }
      expect([...byTag.keys()].sort()).toEqual(PROVIDER_UNIT_READS.map((r) => r.tag).sort());
      for (const read of PROVIDER_UNIT_READS) expect(byTag.get(read.tag)).toEqual([`get ${read.path}`]);
    });

    it("operationIds are unique", () => {
      const ids = Object.values(doc.paths).flatMap((item) => Object.values(item).map((op) => op.operationId).filter(Boolean));
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("lead_found documents notServedTo in plain words", () => {
      const p = doc.paths["/orgs/units/lead-found"].get.parameters!.find((x) => x.name === "notServedTo")!;
      expect(p.description).toContain("any_campaign");
      expect(p.description).toContain("not yet served for sales outreach");
      expect(doc.paths["/orgs/units/lead-found"].get.description).toContain("notServedTo=any_campaign");
    });
  });

  describe(`the lead serve's inputs in the ${name}`, () => {
    const op = doc.paths["/orgs/buffer/next"].post;

    it("has its operationId and no provider tag (it spends: never reachable as a read)", () => {
      expect(op.operationId).toBe("askLeadFound");
      expect((op.tags ?? []).some((t) => t.startsWith("provider:"))).toBe(false);
    });

    it("names every body field, in the operation and on the field itself", () => {
      expect(SERVE_BODY_FIELDS.sort()).toEqual(
        ["acceptedEmails", "dueFollowupOnly", "excludeEmailedWithin", "namedLead", "population", "reachableBy", "reachableOn", "relationships", "stepFilter"].sort(),
      );
      const properties = doc.components.schemas.BufferNextRequest.properties!;
      for (const field of SERVE_BODY_FIELDS) {
        expect(op.description, field).toContain(`\`${field}\``);
        expect(properties[field]?.description, field).toBeTruthy();
      }
    });

    it("names every population value, every refused combination and every empty-answer reason", () => {
      for (const value of ["contacted_pure_prospects", "lead_followup_due", "investors", "industry_peers"]) expect(op.description).toContain(value);
      for (const code of SERVE_400_CODES) expect(op.description, code).toContain(`\`${code}\``);
      for (const reason of SERVE_EMPTY_REASONS) {
        expect(op.description, reason).toContain(`\`${reason}\``);
        expect(SERVE_EMPTY_REASON_MEANINGS[reason]).toBeTruthy();
      }
    });

    it("documents the headers it reads, the audience and the absent channel included", () => {
      const headers = new Map((op.parameters ?? []).filter((p) => p.in === "header").map((p) => [p.name, p]));
      for (const required of ["x-api-key", "x-org-id", "x-run-id", "x-campaign-id", "x-brand-id"]) expect(headers.get(required)?.required, required).toBe(true);
      expect(headers.get("x-audience-id")?.description).toContain("no_audience");
      expect(headers.get("x-feature-slug")?.description).toContain("ABSENT");
      for (const header of ["x-audience-id", "x-feature-slug", "x-campaign-id", "x-brand-id", "x-run-id"]) expect(op.description).toContain(`\`${header}\``);
    });
  });
}

describe("documenting the serve changed nothing it accepts (BufferNextRequestSchema)", () => {
  const accepted: unknown[] = [
    {},
    { acceptedEmails: "valid_only" },
    { acceptedEmails: "valid_catch_all_and_unknown", reachableBy: ["email", "phone"], reachableOn: ["whatsapp"] },
    { relationships: "business_only" },
    { stepFilter: { reached: ["signup"], notReached: ["sale"], anythingElse: 1 } },
    { excludeEmailedWithin: "never" },
    { population: "contacted_pure_prospects" },
    { population: "lead_followup_due" },
    { population: "investors" },
    { population: "industry_peers" },
    { dueFollowupOnly: true },
    { namedLead: { leadId: "3946e857-0000-4000-8000-000000000000", triggerEventId: "evt-1" } },
    // Combinations are refused by the ROUTE with their own code, never by the schema.
    { stepFilter: {}, population: "lead_followup_due", dueFollowupOnly: true },
    { unknownField: 1 },
  ];
  const refused: unknown[] = [
    { acceptedEmails: "anything" },
    { reachableBy: [] },
    { reachableBy: ["linkedin"] },
    { reachableOn: [] },
    { reachableOn: [""] },
    { relationships: "pure_prospect" },
    { stepFilter: { reached: "signup" } },
    { excludeEmailedWithin: "1_month" },
    { population: "buyers" },
    { dueFollowupOnly: false },
    { namedLead: { leadId: "not-a-uuid", triggerEventId: "e" } },
    { namedLead: { leadId: "3946e857-0000-4000-8000-000000000000" } },
    { namedLead: { leadId: "3946e857-0000-4000-8000-000000000000", triggerEventId: "e", extra: 1 } },
  ];

  it.each(accepted.map((body) => [JSON.stringify(body), body]))("accepts %s", (_label, body) => {
    expect(BufferNextRequestSchema.safeParse(body).success).toBe(true);
  });
  it.each(refused.map((body) => [JSON.stringify(body), body]))("refuses %s", (_label, body) => {
    expect(BufferNextRequestSchema.safeParse(body).success).toBe(false);
  });

  it("parsing adds nothing: no default, an empty body stays empty", () => {
    expect(BufferNextRequestSchema.parse({})).toEqual({});
    expect(BufferNextRequestSchema.parse({ unknownField: 1 })).toEqual({});
  });
});
