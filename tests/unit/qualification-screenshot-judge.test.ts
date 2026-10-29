/**
 * SCREENSHOT-CHECK-QUESTION-1021: a screenshot criterion is answered by ONE typed image judgment of its OWN question on
 * the stored screenshot; no generic description of the page is written; the evidence sentence is written from the image
 * for that question and answer. Text checks are untouched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const imageJudgments: Array<{ state: unknown; imageUrl: string; questions: Record<string, { instructions: string }>; judge: string | undefined }> = [];
const textJudgments: unknown[] = [];
const completes: Array<{ systemPrompt: string; message: string; imageUrl?: string }> = [];
const inserted: Array<Record<string, unknown>> = [];
const prices: string[] = [];
let imageAnswerable = 0.97;

vi.mock("../../src/db/index.js", () => {
  const query = () => {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "from", "where", "orderBy", "innerJoin"]) c[m] = () => c;
    c.limit = async () => [];
    return c;
  };
  return {
    db: {
      select: () => query(),
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          inserted.push(row);
          return { onConflictDoNothing: () => ({ returning: async () => [{ id: "verdict-1", ...row }] }), returning: async () => [{ id: "obs-1", observedAt: new Date(), ...row }] };
        },
      }),
    },
  };
});
vi.mock("../../src/lib/qualification-judge.js", async (orig) => ({
  ...((await orig()) as object),
  judgeImageYesNo: async (state: unknown, imageUrl: string, questions: Record<string, { instructions: string }>, _id: unknown, judge?: string) => {
    imageJudgments.push({ state, imageUrl, questions, judge });
    return { probabilities: { answerable: imageAnswerable, holds: 0.08 }, model: "jev-1.13.0" };
  },
  judgeYesNo: async (state: unknown) => {
    textJudgments.push(state);
    return { probabilities: { answerable: 0.9, holds: 0.9 }, model: "jev-1.13.0" };
  },
}));
vi.mock("../../src/lib/chat-complete-client.js", async (orig) => ({
  ...((await orig()) as object),
  complete: async (req: { systemPrompt: string; message: string; imageUrl?: string }) => {
    completes.push(req);
    return { content: "The header shows 615-208-2454 above the fold.", json: null, model: "flash-lite", tokensInput: 1, tokensOutput: 1 };
  },
}));
vi.mock("../../src/lib/image-store-client.js", () => ({ storeImage: async () => "https://r2.example/lead-qualification/underdog.png" }));
vi.mock("../../src/lib/price-client.js", () => ({
  priceCentsPerUnit: async (name: string) => {
    prices.push(name);
    return 0.00001;
  },
}));
vi.mock("../../src/lib/treg-catalog-client.js", () => ({ getCatalogEntry: async () => ({}) }));
vi.mock("../../src/lib/qualification-probes.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, catalogEntryToCall: () => ({ ok: true, vendorUsd: 0.01, call: {} }) };
});

const { judge, observe, estimateCostPerRow } = await import("../../src/lib/qualification.js");
const { BUILTIN_PROBES } = await import("../../src/lib/qualification-probes.js");

const shot = BUILTIN_PROBES.homepage_screenshot.spec;
const subject = { domain: "underdogroofing.com", websiteUrl: "https://underdogroofing.com", companyName: "Underdog Roofing", companyLinkedinUrl: null };
const identity = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const question = "Is there no clearly visible phone number in the header of the homepage above the fold?";
const observation = {
  id: "obs-1",
  probeKey: "k",
  domain: subject.domain,
  status: "ok",
  reason: null,
  endpointId: "branddev.brand.screenshot",
  content: null,
  imageUrl: "https://r2.example/lead-qualification/underdog.png",
  vendorCostMicro: 0,
  runId: "r",
  observedAt: new Date("2026-10-21T03:50:53Z"),
};

beforeEach(() => {
  imageJudgments.length = 0;
  textJudgments.length = 0;
  completes.length = 0;
  inserted.length = 0;
  prices.length = 0;
  imageAnswerable = 0.97;
});

describe("a screenshot check asks its own question of the image", () => {
  it("one image judgment carrying the criterion's question, the evidence written from the image for that answer", async () => {
    const { verdict } = await judge({ question, probe: shot }, observation as never, subject, { meter: {} as never, identity });
    expect(imageJudgments).toHaveLength(1);
    expect(imageJudgments[0].imageUrl).toBe(observation.imageUrl);
    expect(imageJudgments[0].questions.holds.instructions).toBe(question);
    expect(textJudgments).toHaveLength(0);
    expect(verdict.verdict).toBe("no");
    expect(completes).toHaveLength(1);
    expect(completes[0].imageUrl).toBe(observation.imageUrl);
    expect(completes[0].message).toContain(question);
    expect(completes[0].message).toContain("Answer: no");
    expect(verdict.evidence).toBe("The header shows 615-208-2454 above the fold.");
  });

  it("a screenshot observation without its image is unavailable, never judged", async () => {
    const { verdict } = await judge({ question, probe: shot }, { ...observation, imageUrl: null } as never, subject, { meter: {} as never, identity });
    expect(verdict.verdict).toBe("unavailable");
    expect(imageJudgments).toHaveLength(0);
  });

  it("an image the judge cannot read as this homepage is unavailable, no evidence written", async () => {
    imageAnswerable = 0.2;
    const { verdict } = await judge({ question, probe: shot }, observation as never, subject, { meter: {} as never, identity });
    expect(verdict.verdict).toBe("unavailable");
    expect(verdict.reason).toMatch(/^observation_cannot_answer/);
    expect(completes).toHaveLength(0);
  });

  it("observing a screenshot stores the image and writes NO description of it", async () => {
    const meter = { call: async () => ({ status: 200, body: { screenshot: "https://cdn.brand.dev/x/abc.png" }, chargedMicro: 10_000 }) };
    const { observation: row } = await observe(shot, subject, {} as never, { meter: meter as never, identity });
    expect(row.imageUrl).toBe("https://r2.example/lead-qualification/underdog.png");
    expect(row.content ?? null).toBeNull();
    expect(completes).toHaveLength(0);
  });

  it("text checks keep their two-question judgment of the observation", async () => {
    await judge({ question: "Is there a newsletter?", probe: BUILTIN_PROBES.homepage_text.spec }, { ...observation, content: "# Home\nSubscribe", imageUrl: null } as never, subject, {
      meter: {} as never,
      identity,
    });
    expect(textJudgments).toHaveLength(1);
    expect(imageJudgments).toHaveLength(0);
    expect(completes[0].imageUrl).toBeUndefined();
  });
});

describe("the estimate shown before a check is turned on matches the path", () => {
  it("a screenshot row prices the image judgment and the image evidence, not a page description nor a text judgment", async () => {
    await estimateCostPerRow(shot, "org-1");
    expect(prices).toContain("typesafe-jev-1.13-tokens-input");
    expect(prices).toContain("google-flash-lite-3.1-tokens-input");
    expect(prices).toContain("cloudflare-r2-class-a-operation");
  });
});
