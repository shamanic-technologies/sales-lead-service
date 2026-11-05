import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import request from "supertest";
import { acceptQuery, unknownQueryParams, UNKNOWN_QUERY_PARAMETER } from "../../src/lib/query-params.js";
import { READ_QUERY_PARAMS } from "../../src/lib/read-query-vocabulary.js";

// LEADS-UNKNOWN-FILTER-1105: prod 2026-11-04, an AI assistant asked the leads list for
// `replyClassification=positive`; the name was unknown, silently dropped, the whole brand came back
// and a prospect who never replied was told to the client as "replied positively".

function appFor(accepted: readonly string[]) {
  const app = express();
  app.get("/read", acceptQuery(accepted), (_req, res) => {
    res.json({ reached: true });
  });
  return app;
}

describe("a read refuses a query parameter it does not know (LEADS-UNKNOWN-FILTER-1105)", () => {
  it("the leads list refuses `replyClassification`, naming it and every accepted filter", async () => {
    const accepted = READ_QUERY_PARAMS["GET /orgs/leads"];
    const res = await request(appFor(accepted)).get("/read?brandId=b1&replyClassification=positive");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(UNKNOWN_QUERY_PARAMETER);
    expect(res.body.unknown).toEqual(["replyClassification"]);
    for (const name of accepted) expect(res.body.accepted).toContain(name);
    expect(res.body.error).toContain("replyClassification");
    expect(res.body.error).toContain("bucket");
    expect(res.body.reached).toBeUndefined();
  });

  it("names every unknown parameter at once, in request order", async () => {
    const res = await request(appFor(["brandId"])).get("/read?foo=1&brandId=b&bar=2");
    expect(res.status).toBe(400);
    expect(res.body.unknown).toEqual(["foo", "bar"]);
  });

  it("a request naming only accepted parameters (repeated ones included) reaches the handler", async () => {
    const res = await request(appFor(READ_QUERY_PARAMS["GET /orgs/leads"])).get(
      "/read?brandId=b&status=served&status=claimed&limit=20&include=campaigns",
    );
    expect(res.status).toBe(200);
    expect(res.body.reached).toBe(true);
  });

  it("no query at all reaches the handler", async () => {
    const res = await request(appFor([])).get("/read");
    expect(res.status).toBe(200);
  });

  it("a staff key's target org (`orgId`, appended by the MCP to every call) is accepted on every read", async () => {
    const res = await request(appFor([])).get("/read?orgId=o1");
    expect(res.status).toBe(200);
  });

  it("matching is exact: case and spelling variants are unknown, never aliased", () => {
    expect(unknownQueryParams({ BrandId: "x", brandid: "y", brand_id: "z" }, ["brandId"])).toEqual([
      "BrandId",
      "brandid",
      "brand_id",
    ]);
  });
});

describe("every read in the vocabulary is wired to its check", () => {
  const routesDir = fileURLToPath(new URL("../../src/routes", import.meta.url));
  const source = readdirSync(routesDir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => readFileSync(join(routesDir, f), "utf8"))
    .join("\n");

  for (const key of Object.keys(READ_QUERY_PARAMS)) {
    it(`${key} runs acceptQuery with its own list`, () => {
      const [, path] = key.split(" ");
      const wired = new RegExp(
        `router\\.get\\(\\s*"${path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}",\\s*apiKeyAuth,\\s*requireOrgId,\\s*acceptQuery\\(READ_QUERY_PARAMS\\["${key.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}"\\]\\)`,
      );
      expect(source).toMatch(wired);
    });
  }
});
