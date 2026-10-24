import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { readFileSync } from "node:fs";
import { bodyParserErrorHandler, mountJsonParsers } from "../../src/lib/body-limits.js";
import { LEAD_ID_BY_EMAIL_MAX_ITEMS, LEAD_ID_RESOLVE_MAX_ITEMS } from "../../src/schemas.js";

/** LEAD-ID-RESOLVE-413-1024: a documented maximum fits its route's body limit; a body over it is a NAMED 413, never a bare 500. */
function appEchoing() {
  const app = express();
  mountJsonParsers(app);
  app.use(bodyParserErrorHandler);
  app.post("*", (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  // Same last-resort handler as src/app.ts.
  app.use((_err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: "Internal server error" });
  });
  return app;
}

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("JSON body limits", () => {
  it("takes the documented maximum of /internal/leads/ids/resolve with every field filled", async () => {
    const people = Array.from({ length: LEAD_ID_RESOLVE_MAX_ITEMS }, (_, i) => ({
      orgId: uuid(i),
      brandIds: Array.from({ length: 50 }, (_, j) => uuid(j)),
      apolloPersonId: `5f${String(i).padStart(22, "0")}`,
      email: `first.last.${i}@some-long-company-domain.example.com`,
      humanId: uuid(i),
      phone: "+33612345678",
      linkedinUrl: `https://www.linkedin.com/in/first-last-${i}-abcdef123/`,
    }));
    const res = await request(appEchoing()).post("/internal/leads/ids/resolve").send({ people });
    expect(res.status).toBe(200);
    expect(res.body.bytes).toBeGreaterThan(2_000_000);
  });

  it("takes the documented maximum of /internal/leads/ids/by-email (1000 addresses of 320 chars)", async () => {
    const emails = Array.from({ length: LEAD_ID_BY_EMAIL_MAX_ITEMS }, (_, i) => `${String(i).padStart(4, "0")}${"a".repeat(300)}@example.com`.slice(0, 320));
    const res = await request(appEchoing()).post("/internal/leads/ids/by-email").send({ emails });
    expect(res.status).toBe(200);
  });

  it("takes 500 apollo-service items (the prod batch that 500'd on 2026-10-23)", async () => {
    const people = Array.from({ length: 500 }, (_, i) => ({
      orgId: uuid(i),
      brandIds: [uuid(1), uuid(2)],
      apolloPersonId: `5f${String(i).padStart(22, "0")}`,
      email: `first.last.${i}@company.example.com`,
      linkedinUrl: `http://www.linkedin.com/in/first-last-${i}`,
    }));
    const res = await request(appEchoing()).post("/internal/leads/ids/resolve").send({ people });
    expect(res.status).toBe(200);
    expect(res.body.bytes).toBeGreaterThan(100 * 1024);
  });

  it("takes 1000 addresses of 320 chars on /orgs/leads/evidence-changed", async () => {
    const emails = Array.from({ length: 1000 }, (_, i) => `${"a".repeat(300)}${i}@ex.com`.slice(0, 320));
    const res = await request(appEchoing()).post("/orgs/leads/evidence-changed").send({ emails });
    expect(res.status).toBe(200);
  });

  it("answers a body over a route's limit with a named 413", async () => {
    const res = await request(appEchoing()).post("/orgs/leads/search").send({ blob: "x".repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe("payload_too_large");
    expect(res.body.limitBytes).toBe(100 * 1024);
    expect(res.body.message).toContain("Send fewer items per call");
  });

  it("answers malformed JSON with a named 400, not a 500", async () => {
    const res = await request(appEchoing()).post("/orgs/leads/search").set("content-type", "application/json").send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_json");
  });

  it("src/app.ts mounts the parsers and the 4xx handler before every router", () => {
    const src = readFileSync(new URL("../../src/app.ts", import.meta.url), "utf8");
    const parsers = src.indexOf("mountJsonParsers(app);");
    const handler = src.indexOf("app.use(bodyParserErrorHandler);");
    expect(parsers).toBeGreaterThan(-1);
    expect(handler).toBeGreaterThan(parsers);
    expect(handler).toBeLessThan(src.indexOf("app.use(healthRoutes);"));
  });
});
