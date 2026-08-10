import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadCatalog: vi.fn(),
  fetchQuote: vi.fn(),
}));

vi.mock("../../src/services/item-prices", () => ({
  loadItemPriceCatalog: mocks.loadCatalog,
  fetchItemPriceQuote: mocks.fetchQuote,
}));

import { ItemMarketSummary } from "../../src/features/items/ItemMarketSummary";
import type { ItemPriceCatalog } from "../../src/types/prices";

const itemId = "5447a9cd4bdc2dbd208b4567";
const catalog: ItemPriceCatalog = {
  meta: {
    schemaVersion: 1,
    generatedAt: "2026-08-10T00:00:00.000Z",
    source: "https://json.tarkov.dev/endpoints",
    itemCount: 1,
    pvpQuoteCount: 1,
    pveQuoteCount: 1,
  },
  items: [{
    id: itemId,
    normalizedName: "bolts",
    nameEn: "Bolts",
    nameKo: "볼트",
    shortNameEn: "Bolts",
    shortNameKo: "볼트",
    prices: {
      pvp: {
        updatedAt: "2026-08-10T00:00:00.000Z",
        lastLowPrice: 10_000,
        avg24hPrice: 12_000,
        low24hPrice: 8_000,
        high24hPrice: 20_000,
        changeLast48hPercent: 2.5,
        offerCount: 15,
      },
      pve: {
        updatedAt: "2026-08-10T00:00:00.000Z",
        lastLowPrice: 15_000,
        avg24hPrice: 16_000,
        low24hPrice: 11_000,
        high24hPrice: 22_000,
        changeLast48hPercent: -1.25,
        offerCount: 9,
      },
    },
  }],
};

describe("ItemMarketSummary", () => {
  it("shows PVP/PVE unit and remaining-total estimates with price statistics", async () => {
    mocks.loadCatalog.mockResolvedValue(catalog);
    mocks.fetchQuote.mockImplementation((_id: string, mode: "pvp" | "pve") =>
      Promise.resolve(mode === "pvp" ? {
        protocolVersion: 1,
        itemId,
        gameMode: "pvp",
        source: "LIVE",
        fetchedAt: "2026-08-10T01:00:00.000Z",
        expiresAt: "2026-08-10T01:10:00.000Z",
        isStale: false,
        flea: { ...catalog.items[0]!.prices.pvp, lastLowPrice: 11_000 },
      } : null),
    );

    render(<ItemMarketSummary itemId={itemId} itemName="Bolts" remainingCount={3} />);

    const summary = await screen.findByRole("region", { name: "시세 요약" });
    expect(within(summary).getByRole("heading", { name: "PVP" })).toBeInTheDocument();
    expect(within(summary).getByRole("heading", { name: "PVE" })).toBeInTheDocument();
    expect(within(summary).getAllByText("₽11,000")).toHaveLength(2);
    expect(within(summary).getByText("₽33,000")).toBeInTheDocument();
    expect(within(summary).getByText("₽15,000")).toBeInTheDocument();
    expect(within(summary).getByText("₽45,000")).toBeInTheDocument();
    expect(within(summary).getAllByText("24시간 평균")).toHaveLength(2);
    expect(within(summary).getAllByText("등록 매물")).toHaveLength(2);
    expect(within(summary).getByText("실시간")).toBeInTheDocument();
    expect(within(summary).getByText("번들 시세")).toBeInTheDocument();
  });

  it("does not inflate the estimate when no remaining items are needed", async () => {
    mocks.loadCatalog.mockResolvedValue(catalog);
    mocks.fetchQuote.mockResolvedValue(null);

    render(<ItemMarketSummary itemId={itemId} itemName="Bolts" remainingCount={0} />);

    const summary = await screen.findByRole("region", { name: "시세 요약" });
    await waitFor(() => expect(within(summary).getAllByText("₽0")).toHaveLength(2));
  });
});
