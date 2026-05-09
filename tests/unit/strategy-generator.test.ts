import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock chat-client + apollo-client BEFORE importing the module under test.
const chatComplete = vi.fn();
vi.mock("../../src/lib/chat-client.js", () => ({
  chatComplete: (...args: unknown[]) => chatComplete(...args),
}));

const apolloDryRun = vi.fn();
const fetchApolloFiltersPrompt = vi.fn();
vi.mock("../../src/lib/apollo-client.js", () => ({
  apolloDryRun: (...args: unknown[]) => apolloDryRun(...args),
  fetchApolloFiltersPrompt: (...args: unknown[]) => fetchApolloFiltersPrompt(...args),
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
  brandCampaignDescription: "Brand: Acme Dental Supplies\nIndustry: Dental\nTarget Geography: United States\nIdeal Lead Type: dentists, dental hygienists, orthodontists\nCampaign target audience: independent dental practices in the US",
};

beforeEach(() => {
  chatComplete.mockReset();
  apolloDryRun.mockReset();
  fetchApolloFiltersPrompt.mockReset();
  findFirst.mockReset();
  insertReturning.mockReset();
  updateWhere.mockReset();
  __resetFiltersPromptCache();
  // Default: filter-shape doc fetch returns a stable shape so existing tests don't have to opt in.
  fetchApolloFiltersPrompt.mockResolvedValue({
    prompt: "DEFAULT FILTERS PROMPT BLOCK",
    schemaVersion: "default-v1",
  });
});

describe("strategy-generator", () => {
  describe("generateNextStrategy", () => {
    it("returns the last tested filter set when LLM confirms after one test", async () => {
      apolloDryRun.mockResolvedValueOnce({ totalEntries: 3500, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: { personTitles: ["Dentist"], organizationLocations: ["United States"] },
            reasoning: "primary segment",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "looks good" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });

      const result = await generateNextStrategy(baseCtx, []);

      expect("strategy" in result && result.strategy).toEqual({
        personTitles: ["Dentist"],
        organizationLocations: ["United States"],
      });
      expect(apolloDryRun).toHaveBeenCalledOnce();
      expect(chatComplete).toHaveBeenCalledTimes(2);
    });

    it("dentists US fixture: never proposes UK or doctors — confirms a dental-adjacent filter", async () => {
      apolloDryRun.mockResolvedValueOnce({ totalEntries: 200, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: {
              personTitles: ["Orthodontist", "Dental Hygienist"],
              organizationLocations: ["United States"],
            },
            reasoning: "dental-adjacent within scope",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "stays within brand offerings" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });

      const result = await generateNextStrategy(baseCtx, [{ personTitles: ["Dentist"] }]);
      expect("strategy" in result).toBe(true);
      const filters = (result as { strategy: Record<string, unknown> }).strategy;
      const titles = (filters.personTitles ?? []) as string[];
      const locations = (filters.organizationLocations ?? []) as string[];
      expect(titles.some((t) => /doctor|physician|gp/i.test(t))).toBe(false);
      expect(locations.some((l) => /uk|united kingdom|europe/i.test(l))).toBe(false);
    });

    it("returns exhausted when LLM declares no viable alternative", async () => {
      chatComplete.mockResolvedValueOnce({
        json: { action: "exhausted", reason: "saturated all dental-related titles in US" },
        tokensInput: 0,
        tokensOutput: 0,
        model: "gemini-pro",
        content: "",
      });

      const result = await generateNextStrategy(baseCtx, [{ personTitles: ["Dentist"] }]);
      expect(result).toEqual({ exhausted: true, reason: "saturated all dental-related titles in US" });
      expect(apolloDryRun).not.toHaveBeenCalled();
    });

    it("forces LLM to test before allowing confirm", async () => {
      apolloDryRun.mockResolvedValueOnce({ totalEntries: 100, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "I'm sure" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: { personTitles: ["Dentist"] },
            reasoning: "fine, testing",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "now I'm sure" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });

      const result = await generateNextStrategy(baseCtx, []);
      expect("strategy" in result).toBe(true);
      expect(apolloDryRun).toHaveBeenCalledOnce();
      expect(chatComplete).toHaveBeenCalledTimes(3);
    });

    it("rejects confirm when last dryRun returned validationErrors and forces another test", async () => {
      apolloDryRun
        .mockResolvedValueOnce({
          totalEntries: 0,
          validationErrors: [
            'organizationNumEmployeesRanges: Invalid option: expected one of "1,10"|"11,20"|...',
          ],
        })
        .mockResolvedValueOnce({ totalEntries: 500, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: {
              personTitles: ["Dentist"],
              organizationNumEmployeesRanges: ["1,50"],
            },
            reasoning: "trying",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "ignoring errors" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: {
              personTitles: ["Dentist"],
              organizationNumEmployeesRanges: ["1,10", "11,20"],
            },
            reasoning: "fixed bucket",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "now valid" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });

      const result = await generateNextStrategy(baseCtx, []);
      expect("strategy" in result).toBe(true);
      const strategy = (result as { strategy: { organizationNumEmployeesRanges: string[] } }).strategy;
      expect(strategy.organizationNumEmployeesRanges).toEqual(["1,10", "11,20"]);
      expect(apolloDryRun).toHaveBeenCalledTimes(2);
    });

    it("catches Apollo 400 thrown by dryRun, feeds error to LLM, continues loop", async () => {
      apolloDryRun
        .mockRejectedValueOnce(
          new Error(
            'Apollo service call failed: 400 - {"type":"validation","error":"Invalid request","details":{"fieldErrors":{"searchParams":["bad bucket"]}}}',
          ),
        )
        .mockResolvedValueOnce({ totalEntries: 100, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: { organizationNumEmployeesRanges: ["1,50"] },
            reasoning: "first",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: { organizationNumEmployeesRanges: ["1,10"] },
            reasoning: "fixed",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "ok" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });

      const result = await generateNextStrategy(baseCtx, []);
      expect("strategy" in result).toBe(true);
      expect(apolloDryRun).toHaveBeenCalledTimes(2);
    });

    it("returns Max rounds reached after MAX_STRATEGY_GENERATION_ROUNDS", async () => {
      // Always test, never confirm.
      apolloDryRun.mockResolvedValue({ totalEntries: 10, validationErrors: [] });
      chatComplete.mockResolvedValue({
        json: {
          action: "test",
          filters: { personTitles: ["Dentist"] },
          reasoning: "still searching",
        },
        tokensInput: 0,
        tokensOutput: 0,
        model: "gemini-pro",
        content: "",
      });

      const result = await generateNextStrategy(baseCtx, []);
      expect(result).toEqual({ exhausted: true, reason: "Max rounds reached" });
    });
  });

  describe("getCurrentStrategy", () => {
    it("returns existing strategy when row has currentIndex < strategies.length", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ personTitles: ["Dentist"] }],
        currentIndex: 0,
        exhausted: false,
        exhaustionReason: null,
      });

      const result = await getCurrentStrategy(baseCtx);
      expect("strategy" in result && result.strategy).toEqual({ personTitles: ["Dentist"] });
      expect(chatComplete).not.toHaveBeenCalled();
    });

    it("returns exhausted permanently when row.exhausted=true", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ personTitles: ["Dentist"] }],
        currentIndex: 1,
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
      apolloDryRun.mockResolvedValueOnce({ totalEntries: 1000, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: { personTitles: ["Dentist"] },
            reasoning: "primary",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "ok" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });
      insertReturning.mockResolvedValueOnce([]);

      const result = await getCurrentStrategy(baseCtx);
      expect("strategy" in result && result.strategy).toEqual({ personTitles: ["Dentist"] });
    });
  });

  describe("advanceStrategyOrGenerate", () => {
    it("marks row exhausted and returns exhausted when LLM gives up", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ personTitles: ["Dentist"] }],
        currentIndex: 0,
        exhausted: false,
        exhaustionReason: null,
      });
      chatComplete.mockResolvedValueOnce({
        json: { action: "exhausted", reason: "no more options" },
        tokensInput: 0,
        tokensOutput: 0,
        model: "gemini-pro",
        content: "",
      });

      const result = await advanceStrategyOrGenerate(baseCtx);
      expect(result).toEqual({ exhausted: true, reason: "no more options" });
      expect(updateWhere).toHaveBeenCalledOnce();
    });

    it("appends new strategy when LLM confirms a fresh filter", async () => {
      findFirst.mockResolvedValueOnce({
        id: "row-1",
        strategies: [{ personTitles: ["Dentist"] }],
        currentIndex: 0,
        exhausted: false,
        exhaustionReason: null,
      });
      apolloDryRun.mockResolvedValueOnce({ totalEntries: 250, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: {
            action: "test",
            filters: { personTitles: ["Orthodontist"] },
            reasoning: "adjacent",
          },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "ok" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });

      const result = await advanceStrategyOrGenerate(baseCtx);
      expect("strategy" in result && result.strategy).toEqual({ personTitles: ["Orthodontist"] });
    });
  });

  describe("SYSTEM_PROMPT — static portion", () => {
    it("contains the absolute rules + workflow framing but not the filter shape doc", () => {
      expect(__SYSTEM_PROMPT_STATIC__).toContain("ABSOLUTE RULES");
      expect(__SYSTEM_PROMPT_STATIC__).toContain("OUTPUT FORMAT");
      // Filter shape lines must NOT appear in the static block — they're fetched from apollo-service.
      expect(__SYSTEM_PROMPT_STATIC__).not.toMatch(/^- personTitles:/m);
      expect(__SYSTEM_PROMPT_STATIC__).not.toMatch(/qKeywords/);
    });
  });

  describe("filters-prompt fetch + cache", () => {
    function nextActionsForOneTestThenConfirm() {
      apolloDryRun.mockResolvedValueOnce({ totalEntries: 100, validationErrors: [] });
      chatComplete
        .mockResolvedValueOnce({
          json: { action: "test", filters: { personTitles: ["Dentist"] }, reasoning: "primary" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        })
        .mockResolvedValueOnce({
          json: { action: "confirm", reasoning: "ok" },
          tokensInput: 0,
          tokensOutput: 0,
          model: "gemini-pro",
          content: "",
        });
    }

    it("fetches filter-shape doc and injects it into the chatComplete systemPrompt", async () => {
      fetchApolloFiltersPrompt.mockReset();
      fetchApolloFiltersPrompt.mockResolvedValue({
        prompt: "MOCK_FILTER_DOC_X",
        schemaVersion: "v-abc",
      });
      nextActionsForOneTestThenConfirm();

      await generateNextStrategy(baseCtx, []);

      expect(fetchApolloFiltersPrompt).toHaveBeenCalledWith({ orgId: "org-1", userId: "user-1" });
      const firstCall = chatComplete.mock.calls[0][0] as { systemPrompt: string };
      expect(firstCall.systemPrompt).toContain("MOCK_FILTER_DOC_X");
      expect(firstCall.systemPrompt).toContain("ABSOLUTE RULES");
    });

    it("re-fetches each invocation but reuses cached prompt when schemaVersion is unchanged", async () => {
      fetchApolloFiltersPrompt.mockReset();
      fetchApolloFiltersPrompt.mockResolvedValue({
        prompt: "STABLE_DOC",
        schemaVersion: "stable-v1",
      });

      nextActionsForOneTestThenConfirm();
      await generateNextStrategy(baseCtx, []);
      nextActionsForOneTestThenConfirm();
      await generateNextStrategy(baseCtx, []);

      expect(fetchApolloFiltersPrompt).toHaveBeenCalledTimes(2);
      const promptA = (chatComplete.mock.calls[0][0] as { systemPrompt: string }).systemPrompt;
      const promptC = (chatComplete.mock.calls[2][0] as { systemPrompt: string }).systemPrompt;
      expect(promptA).toContain("STABLE_DOC");
      expect(promptC).toContain("STABLE_DOC");
    });

    it("swaps cache and uses new prompt when schemaVersion changes", async () => {
      fetchApolloFiltersPrompt.mockReset();
      fetchApolloFiltersPrompt
        .mockResolvedValueOnce({ prompt: "DOC_OLD", schemaVersion: "v1" })
        .mockResolvedValueOnce({ prompt: "DOC_NEW", schemaVersion: "v2" });

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
      fetchApolloFiltersPrompt.mockReset();
      fetchApolloFiltersPrompt.mockRejectedValue(new Error("apollo-service down"));

      await expect(generateNextStrategy(baseCtx, [])).rejects.toThrow(/apollo-service down/);
      expect(chatComplete).not.toHaveBeenCalled();
    });
  });
});
