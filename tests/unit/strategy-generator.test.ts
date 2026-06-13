import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock chat-client + people-client BEFORE importing the module under test.
const chatComplete = vi.fn();
vi.mock("../../src/lib/chat-client.js", () => ({
  chatComplete: (...args: unknown[]) => chatComplete(...args),
}));

const peopleDryRun = vi.fn();
const fetchFiltersPrompt = vi.fn();
vi.mock("../../src/lib/people-client.js", () => ({
  peopleDryRun: (...args: unknown[]) => peopleDryRun(...args),
  fetchFiltersPrompt: (...args: unknown[]) => fetchFiltersPrompt(...args),
}));

// Mock the DB layer used by getCurrentStrategy / advanceStrategyOrGenerate / persistOutcome.
const findFirst = vi.fn();
const insertReturning = vi.fn();
const updateWhere = vi.fn();

vi.mock("../../src/db/index.js", () => ({
  db: {
    query: {
      campaignsApolloStrategies: { findFirst: (...args: unknown[]) => findFirst(...args) },
    },
    insert: () => ({
      values: () => ({
        returning: (...args: unknown[]) => insertReturning(...args),
      }),
    }),
    update: () => ({
      set: () => ({
        where: (...args: unknown[]) => updateWhere(...args),
      }),
    }),
  },
  sql: {},
}));

import {
  generateNextStrategy,
  getCurrentStrategy,
  advanceStrategyOrGenerate,
  __SYSTEM_PROMPT_STATIC__,
  __resetFiltersPromptCache,
  type StrategyContext,
} from "../../src/lib/strategy-generator.js";

const baseCtx: StrategyContext = {
  orgId: "org-1",
  userId: "user-1",
  runId: "run-1",
  campaignId: "campaign-1",
  brandId: "brand-1",
  provider: "apollo",
  brandCampaignDescription:
    "Brand: Acme Dental Supplies\nIndustry: Dental\nTarget Geography: United States\nIdeal Lead Type: dentists, dental hygienists, orthodontists\nCampaign target audience: independent dental practices in the US",
};

const completion = (json: unknown) => ({
  json,
  tokensInput: 0,
  tokensOutput: 0,
  model: "gemini-pro",
  content: "",
});

beforeEach(() => {
  chatComplete.mockReset();
  peopleDryRun.mockReset();
  fetchFiltersPrompt.mockReset();
  findFirst.mockReset();
  insertReturning.mockReset();
  updateWhere.mockReset();
  __resetFiltersPromptCache();
  // Default: filter-shape doc fetch returns a stable shape so existing tests don't have to opt in.
  fetchFiltersPrompt.mockResolvedValue({
    provider: "apollo",
    prompt: "DEFAULT FILTERS PROMPT BLOCK",
    schemaVersion: "default-v1",
  });
});

describe("strategy-generator", () => {
  describe("generateNextStrategy", () => {
    it("returns the last tested filter set when LLM confirms after one test", async () => {
      peopleDryRun.mockResolvedValueOnce({ provider: "apollo", totalEntries: 3500 });
      chatComplete
        .mockResolvedValueOnce(
          completion({
            action: "test",
            filters: { titles: ["Dentist"], locationCountries: ["United States"] },
            reasoning: "primary segment",
          }),
        )
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "looks good" }));

      const result = await generateNextStrategy(baseCtx, []);

      expect("strategy" in result && result.strategy).toEqual({
        titles: ["Dentist"],
        locationCountries: ["United States"],
      });
      expect(peopleDryRun).toHaveBeenCalledOnce();
      expect(chatComplete).toHaveBeenCalledTimes(2);
    });

    it("passes the campaign provider through to peopleDryRun", async () => {
      peopleDryRun.mockResolvedValueOnce({ provider: "apify", totalEntries: 42 });
      chatComplete
        .mockResolvedValueOnce(
          completion({ action: "test", filters: { companyNames: ["Acme"] }, reasoning: "x" }),
        )
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "ok" }));

      await generateNextStrategy({ ...baseCtx, provider: "apify" }, []);

      expect(peopleDryRun.mock.calls[0][0]).toMatchObject({ provider: "apify" });
    });

    it("returns exhausted when LLM declares no viable alternative", async () => {
      chatComplete.mockResolvedValueOnce(
        completion({ action: "exhausted", reason: "saturated all dental-related titles in US" }),
      );

      const result = await generateNextStrategy(baseCtx, [{ titles: ["Dentist"] }]);
      expect(result).toEqual({ exhausted: true, reason: "saturated all dental-related titles in US" });
      expect(peopleDryRun).not.toHaveBeenCalled();
    });

    it("forces LLM to test before allowing confirm", async () => {
      peopleDryRun.mockResolvedValueOnce({ provider: "apollo", totalEntries: 100 });
      chatComplete
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "I'm sure" }))
        .mockResolvedValueOnce(
          completion({ action: "test", filters: { titles: ["Dentist"] }, reasoning: "fine, testing" }),
        )
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "now I'm sure" }));

      const result = await generateNextStrategy(baseCtx, []);
      expect("strategy" in result).toBe(true);
      expect(peopleDryRun).toHaveBeenCalledOnce();
      expect(chatComplete).toHaveBeenCalledTimes(3);
    });

    it("catches a provider rejection thrown by dryRun, feeds error to LLM, continues loop", async () => {
      peopleDryRun
        .mockRejectedValueOnce(
          new Error(
            'People gateway call failed: 400 - {"type":"validation","error":"Invalid request"}',
          ),
        )
        .mockResolvedValueOnce({ provider: "apollo", totalEntries: 100 });
      chatComplete
        .mockResolvedValueOnce(
          completion({ action: "test", filters: { companySizes: ["1,50"] }, reasoning: "first" }),
        )
        .mockResolvedValueOnce(
          completion({ action: "confirm", reasoning: "ignoring error" }),
        )
        .mockResolvedValueOnce(
          completion({ action: "test", filters: { companySizes: ["1,10"] }, reasoning: "fixed" }),
        )
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "ok" }));

      const result = await generateNextStrategy(baseCtx, []);
      expect("strategy" in result).toBe(true);
      const strategy = (result as { strategy: { companySizes: string[] } }).strategy;
      expect(strategy.companySizes).toEqual(["1,10"]);
      // confirm right after the thrown error is rejected → forces a second test
      expect(peopleDryRun).toHaveBeenCalledTimes(2);
    });

    it("returns Max rounds reached after MAX_STRATEGY_GENERATION_ROUNDS", async () => {
      peopleDryRun.mockResolvedValue({ provider: "apollo", totalEntries: 10 });
      chatComplete.mockResolvedValue(
        completion({ action: "test", filters: { titles: ["Dentist"] }, reasoning: "still searching" }),
      );

      const result = await generateNextStrategy(baseCtx, []);
      expect(result).toEqual({ exhausted: true, reason: "Max rounds reached" });
    });
  });

  describe("getCurrentStrategy", () => {
    it("returns existing strategy + apifyOffset when row has currentIndex < strategies.length", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ titles: ["Dentist"] }],
        currentIndex: 0,
        apifyOffset: 200,
        exhausted: false,
        exhaustionReason: null,
      });

      const result = await getCurrentStrategy(baseCtx);
      expect("strategy" in result && result.strategy).toEqual({ titles: ["Dentist"] });
      expect("strategy" in result && result.apifyOffset).toBe(200);
      expect(chatComplete).not.toHaveBeenCalled();
    });

    it("returns exhausted permanently when row.exhausted=true", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ titles: ["Dentist"] }],
        currentIndex: 1,
        apifyOffset: 0,
        exhausted: true,
        exhaustionReason: "no more viable filters",
      });

      const result = await getCurrentStrategy(baseCtx);
      expect(result).toEqual({ exhausted: true, reason: "no more viable filters" });
      expect(chatComplete).not.toHaveBeenCalled();
    });

    it("throws fail-loud when orgId is missing", async () => {
      await expect(
        getCurrentStrategy({ ...baseCtx, orgId: "" } as StrategyContext),
      ).rejects.toThrow(/orgId/);
    });

    it("throws fail-loud when campaignId is missing", async () => {
      await expect(
        getCurrentStrategy({ ...baseCtx, campaignId: "" } as StrategyContext),
      ).rejects.toThrow(/campaignId/);
    });

    it("generates and persists when no row exists yet", async () => {
      findFirst.mockResolvedValueOnce(null);
      peopleDryRun.mockResolvedValueOnce({ provider: "apollo", totalEntries: 1000 });
      chatComplete
        .mockResolvedValueOnce(
          completion({ action: "test", filters: { titles: ["Dentist"] }, reasoning: "primary" }),
        )
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "ok" }));
      insertReturning.mockResolvedValueOnce([]);

      const result = await getCurrentStrategy(baseCtx);
      expect("strategy" in result && result.strategy).toEqual({ titles: ["Dentist"] });
      expect("strategy" in result && result.apifyOffset).toBe(0);
    });
  });

  describe("advanceStrategyOrGenerate", () => {
    it("marks row exhausted and returns exhausted when LLM gives up", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ titles: ["Dentist"] }],
        currentIndex: 0,
        apifyOffset: 0,
        exhausted: false,
        exhaustionReason: null,
      });
      chatComplete.mockResolvedValueOnce(
        completion({ action: "exhausted", reason: "no more options" }),
      );

      const result = await advanceStrategyOrGenerate(baseCtx);
      expect(result).toEqual({ exhausted: true, reason: "no more options" });
      expect(updateWhere).toHaveBeenCalledOnce();
    });

    it("appends new strategy when LLM confirms a fresh filter", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ titles: ["Dentist"] }],
        currentIndex: 0,
        apifyOffset: 0,
        exhausted: false,
        exhaustionReason: null,
      });
      peopleDryRun.mockResolvedValueOnce({ provider: "apollo", totalEntries: 250 });
      chatComplete
        .mockResolvedValueOnce(
          completion({ action: "test", filters: { titles: ["Orthodontist"] }, reasoning: "adjacent" }),
        )
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "ok" }));

      const result = await advanceStrategyOrGenerate(baseCtx);
      expect("strategy" in result && result.strategy).toEqual({ titles: ["Orthodontist"] });
    });
  });

  describe("SYSTEM_PROMPT — static portion", () => {
    it("contains the absolute rules + workflow framing but not the filter shape doc", () => {
      expect(__SYSTEM_PROMPT_STATIC__).toContain("ABSOLUTE RULES");
      expect(__SYSTEM_PROMPT_STATIC__).toContain("OUTPUT FORMAT");
      // Filter shape lines must NOT appear in the static block — they're fetched from the gateway.
      expect(__SYSTEM_PROMPT_STATIC__).not.toMatch(/^- personTitles:/m);
      expect(__SYSTEM_PROMPT_STATIC__).not.toMatch(/qKeywords/);
    });
  });

  describe("filters-prompt fetch + cache", () => {
    function nextActionsForOneTestThenConfirm() {
      peopleDryRun.mockResolvedValueOnce({ provider: "apollo", totalEntries: 100 });
      chatComplete
        .mockResolvedValueOnce(
          completion({ action: "test", filters: { titles: ["Dentist"] }, reasoning: "primary" }),
        )
        .mockResolvedValueOnce(completion({ action: "confirm", reasoning: "ok" }));
    }

    it("fetches filter-shape doc (with provider) and injects it into the chatComplete systemPrompt", async () => {
      fetchFiltersPrompt.mockReset();
      fetchFiltersPrompt.mockResolvedValue({
        provider: "apollo",
        prompt: "MOCK_FILTER_DOC_X",
        schemaVersion: "v-abc",
      });
      nextActionsForOneTestThenConfirm();

      await generateNextStrategy(baseCtx, []);

      expect(fetchFiltersPrompt).toHaveBeenCalledWith({
        provider: "apollo",
        orgId: "org-1",
        userId: "user-1",
      });
      const firstCall = chatComplete.mock.calls[0][0] as { systemPrompt: string };
      expect(firstCall.systemPrompt).toContain("MOCK_FILTER_DOC_X");
      expect(firstCall.systemPrompt).toContain("ABSOLUTE RULES");
    });

    it("re-fetches each invocation but reuses cached prompt when schemaVersion is unchanged", async () => {
      fetchFiltersPrompt.mockReset();
      fetchFiltersPrompt.mockResolvedValue({
        provider: "apollo",
        prompt: "STABLE_DOC",
        schemaVersion: "stable-v1",
      });

      nextActionsForOneTestThenConfirm();
      await generateNextStrategy(baseCtx, []);
      nextActionsForOneTestThenConfirm();
      await generateNextStrategy(baseCtx, []);

      expect(fetchFiltersPrompt).toHaveBeenCalledTimes(2);
      const promptA = (chatComplete.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;
      const promptC = (chatComplete.mock.calls[2][0] as { systemPrompt: string }).systemPrompt;
      expect(promptA).toContain("STABLE_DOC");
      expect(promptC).toContain("STABLE_DOC");
    });

    it("swaps cache and uses new prompt when schemaVersion changes", async () => {
      fetchFiltersPrompt.mockReset();
      fetchFiltersPrompt
        .mockResolvedValueOnce({ provider: "apollo", prompt: "DOC_OLD", schemaVersion: "v1" })
        .mockResolvedValueOnce({ provider: "apollo", prompt: "DOC_NEW", schemaVersion: "v2" });

      nextActionsForOneTestThenConfirm();
      await generateNextStrategy(baseCtx, []);
      nextActionsForOneTestThenConfirm();
      await generateNextStrategy(baseCtx, []);

      const firstSystem = (chatComplete.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;
      const thirdSystem = (chatComplete.mock.calls[2][0] as { systemPrompt: string }).systemPrompt;
      expect(firstSystem).toContain("DOC_OLD");
      expect(firstSystem).not.toContain("DOC_NEW");
      expect(thirdSystem).toContain("DOC_NEW");
      expect(thirdSystem).not.toContain("DOC_OLD");
    });

    it("propagates fetch errors (no silent fallback)", async () => {
      fetchFiltersPrompt.mockReset();
      fetchFiltersPrompt.mockRejectedValue(new Error("gateway down"));

      await expect(generateNextStrategy(baseCtx, [])).rejects.toThrow(/gateway down/);
      expect(chatComplete).not.toHaveBeenCalled();
    });
  });
});
