import { describe, it, expect, beforeEach, vi } from "vitest";
import { chatComplete } from "../../src/lib/chat-client.js";

const fetchMock = vi.fn();
const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

beforeEach(() => {
  fetchMock.mockReset();
  timeoutSpy.mockClear();
  // @ts-expect-error global fetch override for test
  global.fetch = fetchMock;
});

describe("chat-client timeout", () => {
  it("uses AbortSignal.timeout >= 300_000 ms on the fetch call", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: "", tokensInput: 0, tokensOutput: 0, model: "pro" }),
    });

    await chatComplete(
      {
        message: "hi",
        systemPrompt: "sys",
        provider: "google",
        model: "pro",
      },
      { orgId: "org-1" },
    );

    expect(timeoutSpy).toHaveBeenCalled();
    const ms = timeoutSpy.mock.calls[0][0] as number;
    expect(ms).toBeGreaterThanOrEqual(300_000);
  });
});
