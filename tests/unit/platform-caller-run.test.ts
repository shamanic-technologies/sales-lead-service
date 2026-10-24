/**
 * PLATFORM-CALLER-RUN-1024: every call lead-service makes to chat-service's PLATFORM judgments door states whose work
 * it is, exactly one of: the run of this service doing the work (`x-run-id`) or a declared support function (body
 * `support`). Pinned per call site: the relationship sweep's tag and wants-business judgments ride their run (the
 * sweep's `relationship-sweep` run, or a follow-up claim's judgment run), the "person or machine?" pass is support.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const questions = Object.keys((JSON.parse(init.body) as { questions: Record<string, unknown> }).questions);
    return new Response(JSON.stringify({ judge: "jev", model: "jev-1.13.0", answers: Object.fromEntries(questions.map((q) => [q, { noul: 0.1 }])) }), { status: 200 });
  },
}));

const executed: unknown[] = [];
const dbRows: unknown[][] = [];
vi.mock("../../src/db/index.js", () => ({
  db: { execute: async (q: unknown) => (executed.push(q), dbRows.shift() ?? []) },
}));
vi.mock("../../src/lib/brand-client.js", () => ({ getActiveOffers: async () => [], getOfferText: async () => ({ name: "x" }) }));
vi.mock("../../src/lib/company-client.js", () => ({ getCompanies: async () => [{ name: "Reed", domain: "reed.test" }] }));
vi.mock("../../src/lib/relationship-subjects.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/relationship-subjects.js")>()),
  readThread: async () => [],
}));

const { judgeYesNo, platformCallerWire } = await import("../../src/lib/qualification-judge.js");
const { AUTOMATED_ACT_SUPPORT, judgeAutomatedActs } = await import("../../src/lib/their-acts.js");
const { SUPPORT_FUNCTIONS } = await import("../../src/lib/run-tasks.js");

const RUN = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  sent.length = 0;
  executed.length = 0;
  dbRows.length = 0;
});

describe("platform caller on the wire", () => {
  it("a caller run rides as x-run-id, no support in the body", async () => {
    await judgeYesNo("state", { q: { instructions: "?" } }, { platform: { runId: RUN } });
    expect(sent[0].url).toMatch(/\/internal\/platform-judgments$/);
    expect(sent[0].headers["x-run-id"]).toBe(RUN);
    expect(sent[0].body.support).toBeUndefined();
  });

  it("a support function rides in the body, no x-run-id", async () => {
    const support = { kind: "platform_llm" as const, reason: "A pass no run stands behind." };
    await judgeYesNo("state", { q: { instructions: "?" } }, { platform: { support } });
    expect(sent[0].headers["x-run-id"]).toBeUndefined();
    expect(sent[0].body.support).toEqual(support);
  });

  it("an empty run id is refused before anything is sent (never a caller stating neither)", () => {
    expect(() => platformCallerWire({ runId: "" })).toThrow(/run id/);
  });

  it("the org door is unchanged: identity headers, no support", async () => {
    await judgeYesNo("state", { q: { instructions: "?" } }, { orgId: "o", userId: "u", runId: RUN });
    expect(sent[0].url).toMatch(/\/orgs\/judgments$/);
    expect(sent[0].body.support).toBeUndefined();
  });
});

describe("each call site's choice", () => {
  it("person-or-machine pass (their-acts): support platform_llm, no run", async () => {
    dbRows.push([{ fact_id: "f1", subject: "Hi", text: "Hello", channel: "email", source: "gmail" }]);
    await judgeAutomatedActs(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].headers["x-run-id"]).toBeUndefined();
    expect(sent[0].body.support).toEqual(AUTOMATED_ACT_SUPPORT);
    expect(SUPPORT_FUNCTIONS).toContain(AUTOMATED_ACT_SUPPORT.kind);
  });

  it("no source file calls the platform door without stating its caller", () => {
    const files = (function walk(dir: string): string[] {
      return readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
      });
    })(join(__dirname, "../../src"));
    const offenders: string[] = [];
    const sites: Record<string, string> = {};
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (/judge(?:YesNo|ImageYesNo|Choice)\([^;]*,\s*"platform"\s*[,)]/s.test(text)) offenders.push(f);
      for (const m of text.matchAll(/\{ platform: \{ (runId|support)/g)) sites[f.split("/src/")[1]] = m[1];
      if (!f.endsWith("qualification-judge.ts") && /platform-(judgments|complete|images|transcriptions)/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    expect(sites).toEqual({
      "lib/relationship-judge.ts": "runId",
      "lib/relationship-intent-judge.ts": "runId",
      "lib/their-acts.ts": "support",
    });
  });
});

describe("relationship judgments ride their run", () => {
  const subject = {
    orgId: "o",
    brandId: "b",
    humanId: "33333333-3333-4333-8333-333333333333",
    companyKey: "",
    name: "Ana",
    emails: ["ana@x.test"],
    phones: [],
    channels: [],
    threadSeq: "1",
    lastInboundAt: null,
  };

  it("relationship tags (judgeSubject): x-run-id = the run it is given", async () => {
    const { judgeSubject } = await import("../../src/lib/relationship-judge.js");
    await judgeSubject(subject as never, RUN);
    const call = sent.find((s) => s.url.endsWith("/internal/platform-judgments"));
    expect(call?.headers["x-run-id"]).toBe(RUN);
    expect(call?.body.support).toBeUndefined();
  });

  it("wants business (judgeIntent): x-run-id = the run it is given", async () => {
    const { judgeIntent } = await import("../../src/lib/relationship-intent-judge.js");
    await judgeIntent(subject as never, RUN);
    const call = sent.find((s) => s.url.endsWith("/internal/platform-judgments"));
    expect(call?.headers["x-run-id"]).toBe(RUN);
    expect(call?.body.support).toBeUndefined();
  });
});
