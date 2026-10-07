import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelInvalidJsonError, complete } from "../../src/lib/chat-complete-client.js";

const id = { orgId: "org-1", userId: "u", runId: "r", brandId: null, campaignId: null, workflowSlug: null, featureSlug: null };
const body = JSON.stringify({ error: "LLM returned invalid JSON.", detail: "Expected ',' or ']' after array element" });

afterEach(() => vi.unstubAllGlobals());

describe("chat-service refusing the model's invalid JSON", () => {
  it("is named ModelInvalidJsonError when JSON was asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 502 })));
    await expect(complete({ systemPrompt: "s", message: "m", json: true }, id)).rejects.toBeInstanceOf(ModelInvalidJsonError);
  });

  it("any other failure stays a plain error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 502 })));
    const err = await complete({ systemPrompt: "s", message: "m", json: true }, id).catch((e) => e);
    expect(err).not.toBeInstanceOf(ModelInvalidJsonError);
    expect(err.message).toMatch(/502 boom/);
  });
});
