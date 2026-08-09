import { describe, expect, it, vi } from "vitest";

import { fetchItemPriceQuote, loadItemPriceCatalog } from "../../src/services/item-prices";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const quote = {
  protocolVersion: 1,
  itemId: "5447a9cd4bdc2dbd208b4567",
  gameMode: "pvp",
  source: "LIVE",
  fetchedAt: "2026-08-10T00:00:00.000Z",
  expiresAt: "2026-08-10T00:10:00.000Z",
  isStale: false,
  flea: {
    lastLowPrice: 30_000,
    avg24hPrice: 52_000,
    low24hPrice: 28_000,
    high24hPrice: 91_000,
    changeLast48hPercent: -4.25,
    offerCount: 30,
    updatedAt: "2026-08-09T23:58:01.000Z",
  },
};

describe("item price API boundary", () => {
  it("loads and validates the generated catalog without caching the request", async () => {
    const payload = {
      meta: {
        schemaVersion: 1,
        generatedAt: "2026-08-10T00:00:00.000Z",
        source: "https://json.tarkov.dev/endpoints",
        itemCount: 1,
        pvpQuoteCount: 1,
        pveQuoteCount: 1,
      },
      items: [{
        id: quote.itemId,
        normalizedName: "m4a1",
        nameEn: "M4A1",
        nameKo: "M4A1",
        shortNameEn: "M4A1",
        shortNameKo: "M4A1",
        prices: { pvp: { lastLowPrice: 30_000 }, pve: { lastLowPrice: 32_000 } },
      }],
    };
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

    await expect(loadItemPriceCatalog(undefined, request)).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(expect.stringMatching(/data\/item-price-catalog\.json$/), {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("accepts only an exact requested item/mode quote", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(quote));
    await expect(fetchItemPriceQuote(quote.itemId, "pvp", undefined, request)).resolves.toEqual(quote);
    expect(request).toHaveBeenCalledWith(
      `/api/v1/item-prices/quote?itemId=${quote.itemId}&gameMode=pvp`,
      expect.objectContaining({ cache: "no-store", headers: { Accept: "application/json" } }),
    );

    const wrongItem = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...quote, itemId: "5c0530ee86f774697952d952" }));
    const wrongMode = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...quote, gameMode: "pve" }));
    await expect(fetchItemPriceQuote(quote.itemId, "pvp", undefined, wrongItem)).resolves.toBeNull();
    await expect(fetchItemPriceQuote(quote.itemId, "pvp", undefined, wrongMode)).resolves.toBeNull();
  });

  it("treats 404, network, invalid schema, and aborts as live-unavailable", async () => {
    const missing = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: {} }, 404));
    const failed = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed"));
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...quote, source: "OTHER" }));
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    await expect(fetchItemPriceQuote(quote.itemId, "pvp", undefined, missing)).resolves.toBeNull();
    await expect(fetchItemPriceQuote(quote.itemId, "pvp", undefined, failed)).resolves.toBeNull();
    await expect(fetchItemPriceQuote(quote.itemId, "pvp", undefined, malformed)).resolves.toBeNull();
    await expect(fetchItemPriceQuote(quote.itemId, "pvp", undefined, aborted)).resolves.toBeNull();
  });
});
