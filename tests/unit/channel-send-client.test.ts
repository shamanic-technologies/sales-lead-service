import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * WA-SENDS-BATCH-1014: the non-email sender's record (crm-service `POST /orgs/whatsapp/sends/query`), read in ONE call
 * per pull for a bounded batch of people. Fail loud: an unreadable answer is never "nothing sent".
 */
const fetchWithRetry = vi.fn();
vi.mock("../../src/lib/fetch-retry.js", () => ({ fetchWithRetry: (...a: unknown[]) => fetchWithRetry(...a) }));

const { fetchChannelSendsBatch, ChannelSendsUnavailableError, channelSendKey } = await import(
  "../../src/lib/channel-send-client.js"
);

const ctx = { orgId: "org-1", userId: "user-1", runId: "run-1" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const send = (over: Record<string, unknown>) => ({
  email: "imenez@gmail.com",
  sendId: "s1",
  status: "sent",
  code: null,
  campaignId: "c1",
  sentAt: "2026-10-12T14:43:32.913Z",
  createdAt: "2026-10-12T14:43:31.765Z",
  ...over,
});

afterEach(() => fetchWithRetry.mockReset());

describe("channel send client (one batch call)", () => {
  it("asks crm-service ONCE for the whole batch, scoped to the brand and campaign, with the caller's identity", async () => {
    fetchWithRetry.mockResolvedValueOnce(json(200, { sends: [send({})], invalidEmails: [] }));
    const out = await fetchChannelSendsBatch("brand-1", "c1", ["Imenez@gmail.com", "imenez@gmail.com", " Fresh@x.co "], ctx);
    expect(fetchWithRetry).toHaveBeenCalledTimes(1);
    const [url, init] = fetchWithRetry.mock.calls[0];
    expect(url).toBe("http://crm:3016/orgs/whatsapp/sends/query");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ brandId: "brand-1", campaignId: "c1", emails: ["imenez@gmail.com", "fresh@x.co"] });
    expect(init.headers).toMatchObject({ "X-API-Key": "test-crm-key", "x-org-id": "org-1", "x-brand-id": "brand-1", "x-user-id": "user-1", "x-run-id": "run-1" });
    expect(out.get("imenez@gmail.com")).toEqual([
      { sendId: "s1", status: "sent", campaignId: "c1", sentAt: "2026-10-12T14:43:32.913Z", createdAt: "2026-10-12T14:43:31.765Z" },
    ]);
    // A person with no send is absent (the pool reads that as nothing sent, as before).
    expect(out.has("fresh@x.co")).toBe(false);
  });

  it("groups several sends of one person, newest first as crm-service states them", async () => {
    fetchWithRetry.mockResolvedValueOnce(
      json(200, { sends: [send({ sendId: "new", status: "sending", sentAt: null }), send({ sendId: "old", status: "failed", sentAt: null, email: "IMENEZ@gmail.com" })], invalidEmails: [] }),
    );
    const out = await fetchChannelSendsBatch("b", "c1", ["imenez@gmail.com"], ctx);
    expect(out.get("imenez@gmail.com")?.map((s) => s.sendId)).toEqual(["new", "old"]);
  });

  it("an address crm-service cannot match is never sent: dropped, logged with its lead, the rest still asked (LEAD-CHANGES-INVALID-EMAIL-1016)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchWithRetry.mockResolvedValueOnce(json(200, { sends: [send({ email: "a@x.co" })], invalidEmails: [] }));
    const out = await fetchChannelSendsBatch("b", "c1", ["not-an-email", "a@x.co", "x y@z.co"], ctx, new Map([["not-an-email", "lead-bad-1"], ["x y@z.co", "lead-bad-2"]]));
    expect(JSON.parse(fetchWithRetry.mock.calls[0][1].body).emails).toEqual(["a@x.co"]);
    expect(out.get("a@x.co")?.map((s) => s.sendId)).toEqual(["s1"]);
    const logged = errors.mock.calls.map((c) => String(c[0]));
    expect(logged).toHaveLength(2);
    expect(logged[0]).toContain("lead-bad-1");
    expect(logged[1]).toContain("lead-bad-2");
    errors.mockRestore();
  });

  it("an email crm-service still names unmatchable (its rule moved) fails the pull, named", async () => {
    fetchWithRetry.mockResolvedValueOnce(json(200, { sends: [], invalidEmails: ["a@x.co"] }));
    await expect(fetchChannelSendsBatch("b", "c1", ["a@x.co"], ctx)).rejects.toThrow(/cannot match 1 email.*a@x.co/);
  });

  it("fails loud on a non-2xx, an unreachable service, a malformed answer or an unreadable send", async () => {
    fetchWithRetry.mockResolvedValueOnce(json(502, { error: "x" }));
    await expect(fetchChannelSendsBatch("b", "c1", ["a@x.co"], ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
    fetchWithRetry.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(fetchChannelSendsBatch("b", "c1", ["a@x.co"], ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
    fetchWithRetry.mockResolvedValueOnce(json(200, { sends: [] }));
    await expect(fetchChannelSendsBatch("b", "c1", ["a@x.co"], ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
    fetchWithRetry.mockResolvedValueOnce(json(200, { sends: [{ email: "a@x.co" }], invalidEmails: [] }));
    await expect(fetchChannelSendsBatch("b", "c1", ["a@x.co"], ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
    fetchWithRetry.mockResolvedValueOnce(json(200, { sends: [send({ email: null })], invalidEmails: [] }));
    await expect(fetchChannelSendsBatch("b", "c1", ["a@x.co"], ctx)).rejects.toBeInstanceOf(ChannelSendsUnavailableError);
  });

  it("asks nothing for an empty batch, and refuses one past crm-service's cap", async () => {
    expect((await fetchChannelSendsBatch("b", "c1", [], ctx)).size).toBe(0);
    await expect(fetchChannelSendsBatch("b", "c1", Array.from({ length: 501 }, (_, i) => `p${i}@x.co`), ctx)).rejects.toBeInstanceOf(
      ChannelSendsUnavailableError,
    );
    expect(fetchWithRetry).not.toHaveBeenCalled();
  });

  it("keys a person the way crm-service matches them", () => {
    expect(channelSendKey("  A@X.co ")).toBe("a@x.co");
  });

  it("the per-person read is gone", async () => {
    const mod = await import("../../src/lib/channel-send-client.js");
    expect(mod).not.toHaveProperty("fetchChannelSends");
  });
});
