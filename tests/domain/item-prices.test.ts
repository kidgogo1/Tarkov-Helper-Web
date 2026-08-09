import { describe, expect, it } from "vitest";

import { searchPriceCatalog, selectCatalogSnapshot } from "../../src/domain/item-prices";
import type { ItemPriceCatalog } from "../../src/types/prices";

const catalog: ItemPriceCatalog = {
  meta: {
    schemaVersion: 1,
    generatedAt: "2026-08-10T00:00:00.000Z",
    source: "https://json.tarkov.dev/endpoints",
    itemCount: 2,
    pvpQuoteCount: 2,
    pveQuoteCount: 2,
  },
  items: [
    {
      id: "5447a9cd4bdc2dbd208b4567",
      normalizedName: "colt-m4a1-556x45-assault-rifle",
      nameEn: "Colt M4A1 5.56x45 assault rifle",
      nameKo: "Colt M4A1 5.56x45 돌격소총",
      shortNameEn: "M4A1",
      shortNameKo: "M4A1",
      prices: {
        pvp: { lastLowPrice: 24_000, avg24hPrice: 43_360 },
        pve: { lastLowPrice: 31_000, avg24hPrice: 48_000 },
      },
    },
    {
      id: "5c0530ee86f774697952d952",
      normalizedName: "ledx-skin-transilluminator",
      nameEn: "LEDX Skin Transilluminator",
      nameKo: "LEDX 피부 트랜스일루미네이터",
      shortNameEn: "LEDX",
      shortNameKo: "LEDX",
      prices: {
        pvp: { lastLowPrice: 579_000, avg24hPrice: 610_407 },
        pve: { lastLowPrice: 700_000, avg24hPrice: 850_316 },
      },
    },
  ],
};

describe("item price search", () => {
  it("searches Korean, English, short, and normalized names", () => {
    expect(searchPriceCatalog(catalog.items, "돌격소총")[0]?.shortNameEn).toBe("M4A1");
    expect(searchPriceCatalog(catalog.items, "transilluminator")[0]?.shortNameEn).toBe("LEDX");
    expect(searchPriceCatalog(catalog.items, "m4a1")[0]?.shortNameEn).toBe("M4A1");
    expect(searchPriceCatalog(catalog.items, "ledx-skin")[0]?.shortNameEn).toBe("LEDX");
  });

  it("returns a bounded result set with exact and prefix matches first", () => {
    const items = Array.from({ length: 100 }, (_, index) => ({
      ...catalog.items[0],
      id: index.toString(16).padStart(24, "0"),
      nameEn: index === 71 ? "M4A1" : `M4A1 part ${index}`,
      shortNameEn: index === 71 ? "M4A1" : `part-${index}`,
      shortNameKo: index === 71 ? "M4A1" : `부품-${index}`,
    }));
    const results = searchPriceCatalog(items, "M4A1", 40);
    expect(results).toHaveLength(40);
    expect(results[0]?.nameEn).toBe("M4A1");
  });

  it("selects the active PVP/PVE snapshot without mutating the item", () => {
    expect(selectCatalogSnapshot(catalog.items[1], "pvp")?.lastLowPrice).toBe(579_000);
    expect(selectCatalogSnapshot(catalog.items[1], "pve")?.lastLowPrice).toBe(700_000);
  });
});
