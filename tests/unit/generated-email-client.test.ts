import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchWithRetry = vi.fn();
vi.mock("../../src/lib/fetch-retry.js", () => ({ fetchWithRetry }));

const ctx = { orgId: "org-1", userId: "user-1", runId: "11111111-1111-4111-8111-111111111111" };

function answer(generation: Record<string, unknown>) {
  return new Response(JSON.stringify({ generation }), { status: 200 });
}

describe("fetchGeneratedEmail — the run that generated the sequence", () => {
  beforeEach(() => {
    fetchWithRetry.mockReset();
    vi.resetModules();
  });

  it("carries the producer's runId", async () => {
    fetchWithRetry.mockResolvedValue(
      answer({ id: "g", runId: "c376867e-f94f-435b-8833-355affca0a4b", generationRunId: "child" }),
    );
    const { fetchGeneratedEmail } = await import("../../src/lib/generated-email-client.js");
    const read = await fetchGeneratedEmail("lead-1", "camp-1", ctx);
    expect(read.ok && read.data?.runId).toBe("c376867e-f94f-435b-8833-355affca0a4b");
  });

  it("reads an absent or empty runId as null, never a guess", async () => {
    const { fetchGeneratedEmail } = await import("../../src/lib/generated-email-client.js");
    fetchWithRetry.mockResolvedValueOnce(answer({ id: "g" }));
    const absent = await fetchGeneratedEmail("lead-1", "camp-1", ctx);
    expect(absent.ok && absent.data?.runId).toBeNull();
    fetchWithRetry.mockResolvedValueOnce(answer({ id: "g", runId: "" }));
    const empty = await fetchGeneratedEmail("lead-1", "camp-1", ctx);
    expect(empty.ok && empty.data?.runId).toBeNull();
  });
});
