import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WA-RESERVE-LOOP-1014: the non-email sender's record (crm-service `GET /orgs/whatsapp/messages`), read one person at
 * a time for a bounded batch. Fail loud: an unreadable answer is never "nothing sent".
 */
const fetchWithRetry = vi.fn();
vi.mock("../../src/lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

const { fetchChannelSends, fetchChannelSendsBatch, ChannelSendsUnavailableError } = await import(
  "../../src/lib/channel-send-client.js"
);

const ctx = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => fetchWithRetry.mockReset());

describe("channel send client", () => {
  it("asks crm-service for one person under the brand, with the caller's identity", async () => {
    fetchWithRetry.mockResolvedValueOnce(
      json(200, { sends: [{ sendId: "s1", status: "sent", campaignId: "c1", sentAt: "2026-10-12T14:43:32.913Z", createdAt: "2026-10-12T14:43:31.765Z", text: "hi" }] }),
    );
    const sends = await fetchChannelSends("brand-1", "Imenez@gmail.com", ctx);
    expect(sends).toEqual([{ sendId: "s1", status: "sent", campaignId: "c1", sentAt: "2026-10-12T14:43:32.913Z", createdAt: "2026-10-12T14:43:31.765Z" }]);
    const [url, init] = fetchWithRetry.mock.calls[0];
    expect(url).toBe("http://crm:3016/orgs/whatsapp/messages?brandId=brand-1&email=Imenez%40gmail.com");
    expect(init.headers).toMatchObject({ "X-API-Key": "test-crm-key", "x-org-id": "org-1", "x-brand-id": "brand-1", "x-user-id": "user-1", "x-run-id": "run-1" });
  });

  it("fails loud on a non-2xx, an unreachable service, or an answer with no sends array", async () => {
    fetchWithRetry.mockResolvedValueOnce(json(502, { error: "x" }));
    await expect(fetchChannelSends("b", "a@x.co", ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
    fetchWithRetry.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(fetchChannelSends("b", "a@x.co", ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
    fetchWithRetry.mockResolvedValueOnce(json(200, {}));
    await expect(fetchChannelSends("b", "a@x.co", ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
  });

  it("reads a batch keyed by lowercased email, each person once; one failure fails the batch", async () => {
    fetchWithRetry.mockImplementation(async () => json(200, { sends: [] }));
    const out = await fetchChannelSendsBatch("b", ["A@x.co", "a@x.co", "b@x.co"], ctx);
    expect([...out.keys()].sort()).toEqual(["a@x.co", "b@x.co"]);
    expect(fetchWithRetry).toHaveBeenCalledTimes(2);

    fetchWithRetry.mockReset();
    fetchWithRetry.mockImplementation(async (url: string) => (url.includes("b%40x.co") ? json(500, {}) : json(200, { sends: [] })));
    await expect(fetchChannelSendsBatch("b", ["a@x.co", "b@x.co"], ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
  });
});
