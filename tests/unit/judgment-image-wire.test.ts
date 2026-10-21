/**
 * The image judgment's wire shape against chat-service's judgments door (IMAGE-JUDGE-1021): the image rides as
 * `image.url`, the judge is NAMED, and a judge that takes no noul `criteria` (openai-luna) gets the yes/no boundaries
 * inside its instructions instead (chat-service refuses criteria for it with a 400).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
vi.mock("../../src/lib/fetch-retry.js", () => ({
  fetchWithRetry: async (url: string, init: { body: string; headers: Record<string, string> }) => {
    sent.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ judge: "jev", model: "jev-1.13.0", answers: { answerable: { noul: 0.9 }, holds: { noul: 0.1 } } }), { status: 200 });
  },
}));

const { judgeImageYesNo } = await import("../../src/lib/qualification-judge.js");
const questions = {
  answerable: { instructions: "Is this a usable screenshot?", whenTrue: "It is.", whenFalse: "It is not." },
  holds: { instructions: "Is there no phone in the header?", whenTrue: "No phone.", whenFalse: "A phone." },
};

beforeEach(() => {
  sent.length = 0;
});

describe("image judgment wire", () => {
  it("jev: image + judge named, criteria kept, org identity headers", async () => {
    const out = await judgeImageYesNo({ company: "x" }, "https://r2.example/a.png", questions, { orgId: "o", userId: "u", runId: "r" }, "jev");
    expect(out).toEqual({ probabilities: { answerable: 0.9, holds: 0.1 }, model: "jev-1.13.0" });
    expect(sent[0].url).toMatch(/\/orgs\/judgments$/);
    expect(sent[0].body.image).toEqual({ url: "https://r2.example/a.png" });
    expect(sent[0].body.judge).toBe("jev");
    expect((sent[0].body.questions as Record<string, unknown>).holds).toEqual({ type: "noul", instructions: "Is there no phone in the header?", criteria: { true: "No phone.", false: "A phone." } });
  });

  it("openai-luna on the platform route: no criteria on the wire, boundaries folded into the instructions", async () => {
    await judgeImageYesNo({ company: "x" }, "https://r2.example/a.png", questions, "platform", "openai-luna");
    expect(sent[0].url).toMatch(/\/internal\/platform-judgments$/);
    const holds = (sent[0].body.questions as Record<string, Record<string, unknown>>).holds;
    expect(holds.criteria).toBeUndefined();
    expect(holds.instructions).toBe("Is there no phone in the header?\nYes: No phone.\nNo: A phone.");
  });

  it("cloudflare-clef judges take criteria like jev (only openai-luna folds them)", async () => {
    for (const judge of ["cloudflare-clef", "cloudflare-clef-flash"] as const) {
      sent.length = 0;
      await judgeImageYesNo({ company: "x" }, "https://r2.example/a.png", questions, "platform", judge);
      expect(sent[0].body.judge).toBe(judge);
      expect((sent[0].body.questions as Record<string, unknown>).holds).toEqual({ type: "noul", instructions: "Is there no phone in the header?", criteria: { true: "No phone.", false: "A phone." } });
    }
  });

  it("every judge has its input cost name", async () => {
    const { IMAGE_JUDGES, JUDGE_INPUT_COST_NAMES } = await import("../../src/lib/qualification-judge.js");
    for (const j of IMAGE_JUDGES) expect(JUDGE_INPUT_COST_NAMES[j]).toMatch(/-tokens-input$/);
    expect(JUDGE_INPUT_COST_NAMES["cloudflare-clef-flash"]).toBe("cloudflare-clef-flash-tokens-input");
  });

  it("a text judgment sends neither image nor judge (bytes unchanged)", async () => {
    const { judgeYesNo } = await import("../../src/lib/qualification-judge.js");
    await judgeYesNo("state", { holds: { instructions: "?" } }, "platform");
    expect(Object.keys(sent[0].body).sort()).toEqual(["questions", "state"]);
  });
});
