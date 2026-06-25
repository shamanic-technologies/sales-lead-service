import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  checkDeliveryStatus,
  isContacted,
  checkEmailStatus,
  type StatusResult,
  type ProviderStatus,
  type ScopedStatus,
} from "../../src/lib/email-gateway-client.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("email-gateway-client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkDeliveryStatus", () => {
    it("returns status results on success", async () => {
      const responseBody = {
        results: [
          {
            email: "alice@acme.com",
            broadcast: {
              campaign: { contacted: true, delivered: true, opened: false, replied: false, replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: "2024-01-01" },
              brand: { contacted: true, delivered: true, opened: false, replied: false, replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: "2024-01-01" },
              global: {
                email: { bounced: false, unsubscribed: false },
              },
            },
          },
        ],
      };

      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(responseBody),
      });

      const result = await checkDeliveryStatus("brand-1", "campaign-1", [
        { email: "alice@acme.com" },
      ]);

      expect(result).toEqual(responseBody);
      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toContain("/orgs/status");
      expect(opts.method).toBe("POST");
      const body = JSON.parse(opts.body);
      expect(body.brandId).toBe("brand-1");
      expect(body.campaignId).toBe("campaign-1");
      expect(body.items).toEqual([{ email: "alice@acme.com" }]);
    });

    it("sends brandId in body when campaignId is undefined", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ results: [] }),
      });

      await checkDeliveryStatus("brand-1", undefined, [
        { email: "alice@acme.com" },
      ]);

      const [, opts] = mockFetch.mock.calls[0];
      const body = JSON.parse(opts.body);
      expect(body.brandId).toBe("brand-1");
      expect(body.campaignId).toBeUndefined();
      expect(body.items).toEqual([{ email: "alice@acme.com" }]);
    });

    it("throws on non-200 response (fail loud)", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal server error"),
      });

      await expect(
        checkDeliveryStatus("brand-1", "campaign-1", [
          { email: "alice@acme.com" },
        ])
      ).rejects.toThrow("Status check failed: 500");
    });

    it("throws on connection error (fail loud)", async () => {
      mockFetch.mockRejectedValue(new TypeError("fetch failed"));

      await expect(
        checkDeliveryStatus("brand-1", "campaign-1", [
          { email: "alice@acme.com" },
        ])
      ).rejects.toThrow("fetch failed");
    });

    it("retries a transient socket drop and then succeeds (no 500 leaks to caller)", async () => {
      const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
      const socketErr = Object.assign(new TypeError("fetch failed"), { cause });
      mockFetch
        .mockRejectedValueOnce(socketErr)
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ results: [] }) });

      const result = await checkDeliveryStatus("brand-1", "campaign-1", [
        { email: "alice@acme.com" },
      ]);

      expect(result).toEqual({ results: [] });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("returns empty results for empty items array", async () => {
      const result = await checkDeliveryStatus("brand-1", "campaign-1", []);
      expect(result).toEqual({ results: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("batches items when exceeding batch size", async () => {
      const items = Array.from({ length: 150 }, (_, i) => ({
        email: `user${i}@acme.com`,
      }));

      mockFetch.mockImplementation(async (_url: string, opts: { body: string }) => {
        const body = JSON.parse(opts.body);
        return {
          ok: true,
          json: () => Promise.resolve({
            results: body.items.map((item: { email: string }) => ({
              email: item.email,
            })),
          }),
        };
      });

      const result = await checkDeliveryStatus("brand-1", "campaign-1", items);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const firstBatch = JSON.parse(mockFetch.mock.calls[0][1].body);
      const secondBatch = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(firstBatch.items).toHaveLength(100);
      expect(secondBatch.items).toHaveLength(50);
      expect(result.results).toHaveLength(150);
    });

    it("throws if any batch fails (fail loud)", async () => {
      const items = Array.from({ length: 150 }, (_, i) => ({
        email: `user${i}@acme.com`,
      }));

      let callCount = 0;
      mockFetch.mockImplementation(async () => {
        callCount++;
        if (callCount === 2) {
          return { ok: false, status: 500, text: () => Promise.resolve("error") };
        }
        return {
          ok: true,
          json: () => Promise.resolve({ results: [] }),
        };
      });

      await expect(
        checkDeliveryStatus("brand-1", "campaign-1", items)
      ).rejects.toThrow("Status check failed: 500");
    });
  });

  describe("isContacted", () => {
    const emptyScoped: ScopedStatus = {
      contacted: false, sent: false, delivered: false, opened: false, clicked: false, replied: false,
      replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null, firstClickedAt: null,
    };

    const emptyGlobal = {
      email: { bounced: false, unsubscribed: false },
    };

    const emptyProvider: ProviderStatus = {
      campaign: emptyScoped,
      brand: emptyScoped,
      global: emptyGlobal,
    };

    it("returns false when nothing is contacted", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: emptyProvider,
        transactional: emptyProvider,
      };
      expect(isContacted(result)).toBe(false);
    });

    it("returns false when no providers present", () => {
      const result: StatusResult = { email: "alice@acme.com" };
      expect(isContacted(result)).toBe(false);
    });

    it("returns true when broadcast campaign is contacted", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: {
          ...emptyProvider,
          campaign: { ...emptyScoped, contacted: true, delivered: true },
        },
      };
      expect(isContacted(result)).toBe(true);
    });

    it("returns true when broadcast brand is contacted", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: {
          ...emptyProvider,
          brand: { ...emptyScoped, contacted: true, delivered: true },
        },
      };
      expect(isContacted(result)).toBe(true);
    });

    it("returns true when broadcast byCampaign has a contacted entry", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: {
          ...emptyProvider,
          byCampaign: {
            "campaign-other": { ...emptyScoped, contacted: true, delivered: true },
          },
        },
      };
      expect(isContacted(result)).toBe(true);
    });

    it("returns false when broadcast byCampaign entries are all not contacted", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: {
          ...emptyProvider,
          byCampaign: {
            "campaign-other": emptyScoped,
          },
        },
      };
      expect(isContacted(result)).toBe(false);
    });
  });

  describe("checkEmailStatus", () => {
    const emptyScoped: ScopedStatus = {
      contacted: false, sent: false, delivered: false, opened: false, clicked: false, replied: false,
      replyClassification: null, bounced: false, unsubscribed: false, lastDeliveredAt: null, firstClickedAt: null,
    };

    const emptyGlobal = {
      email: { bounced: false, unsubscribed: false },
    };

    const emptyProvider: ProviderStatus = {
      campaign: emptyScoped,
      brand: emptyScoped,
      global: emptyGlobal,
    };

    it("returns all false when nothing is set", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: emptyProvider,
        transactional: emptyProvider,
      };
      expect(checkEmailStatus(result)).toEqual({ contacted: false, bounced: false, unsubscribed: false });
    });

    it("detects global bounce from broadcast", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: {
          ...emptyProvider,
          global: {
            email: { bounced: true, unsubscribed: false },
          },
        },
      };
      expect(checkEmailStatus(result)).toEqual({ contacted: false, bounced: true, unsubscribed: false });
    });

    it("detects global unsubscribe from transactional", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        transactional: {
          ...emptyProvider,
          global: {
            email: { bounced: false, unsubscribed: true },
          },
        },
      };
      expect(checkEmailStatus(result)).toEqual({ contacted: false, bounced: false, unsubscribed: true });
    });

    it("detects contacted + bounced simultaneously", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: {
          campaign: { ...emptyScoped, contacted: true },
          brand: emptyScoped,
          global: {
            email: { bounced: true, unsubscribed: false },
          },
        },
      };
      const status = checkEmailStatus(result);
      expect(status.contacted).toBe(true);
      expect(status.bounced).toBe(true);
    });

    it("isContacted delegates to checkEmailStatus", () => {
      const result: StatusResult = {
        email: "alice@acme.com",
        broadcast: {
          ...emptyProvider,
          brand: { ...emptyScoped, contacted: true },
        },
      };
      expect(isContacted(result)).toBe(true);
    });
  });
});
