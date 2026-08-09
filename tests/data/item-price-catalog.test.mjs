// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  buildItemPriceCatalog,
  readBoundedJsonResponse,
} from "../../scripts/item-price-catalog.mjs";

function sourceItem(overrides = {}) {
  return {
    id: "5447a9cd4bdc2dbd208b4567",
    name: "5447a9cd4bdc2dbd208b4567 Name",
    shortName: "5447a9cd4bdc2dbd208b4567 ShortName",
    normalizedName: "colt-m4a1-556x45-assault-rifle",
    wikiLink: "https://escapefromtarkov.fandom.com/wiki/Colt_M4A1_5.56x45_assault_rifle",
    link: "https://tarkov.dev/item/colt-m4a1-556x45-assault-rifle",
    updated: "2026-08-09T16:38:01.000Z",
    lastLowPrice: 24000,
    avg24hPrice: 43360,
    low24hPrice: 24000,
    high24hPrice: 199000,
    changeLast48hPercent: -40.32,
    lastOfferCount: 41,
    types: ["gun", "wearable"],
    sellToTrader: [
      { trader: "mechanic", price: 8278, priceRUB: 8278, currency: "RUB" },
      { trader: "peacekeeper", price: 55, priceRUB: 6622, currency: "USD" },
    ],
    ...overrides,
  };
}

function sourceDocument(item) {
  return {
    data: { items: { [item.id]: item } },
    translations: ["items"],
  };
}

const english = {
  data: {
    "5447a9cd4bdc2dbd208b4567 Name": "Colt M4A1 5.56x45 assault rifle",
    "5447a9cd4bdc2dbd208b4567 ShortName": "M4A1",
  },
};

const korean = {
  data: {
    "5447a9cd4bdc2dbd208b4567 Name": "Colt M4A1 5.56x45 돌격소총",
    "5447a9cd4bdc2dbd208b4567 ShortName": "M4A1",
  },
};

describe("item price catalog generation", () => {
  it("merges PVP/PVE quotes, translations, a local icon, and the best trader sale", () => {
    const regularItem = sourceItem();
    const pveItem = sourceItem({ lastLowPrice: 31000, avg24hPrice: 48000 });
    const catalog = buildItemPriceCatalog({
      generatedAt: "2026-08-10T00:00:00.000Z",
      regular: sourceDocument(regularItem),
      pve: sourceDocument(pveItem),
      english,
      korean,
      localItems: [{
        wikiPageLink: regularItem.wikiLink,
        localIcon: "assets/items/m4.webp",
      }],
    });

    expect(catalog.meta).toMatchObject({
      schemaVersion: 1,
      generatedAt: "2026-08-10T00:00:00.000Z",
      itemCount: 1,
      pvpQuoteCount: 1,
      pveQuoteCount: 1,
    });
    expect(catalog.items).toEqual([expect.objectContaining({
      id: regularItem.id,
      nameEn: "Colt M4A1 5.56x45 assault rifle",
      nameKo: "Colt M4A1 5.56x45 돌격소총",
      shortNameEn: "M4A1",
      shortNameKo: "M4A1",
      localIcon: "assets/items/m4.webp",
      prices: {
        pvp: expect.objectContaining({
          lastLowPrice: 24000,
          bestTraderOffer: {
            traderId: "mechanic",
            price: 8278,
            priceRUB: 8278,
            currency: "RUB",
          },
        }),
        pve: expect.objectContaining({ lastLowPrice: 31000, avg24hPrice: 48000 }),
      },
    })]);
  });

  it("rejects unsafe source records and does not attach ambiguous local icons", () => {
    const item = sourceItem();
    expect(() => buildItemPriceCatalog({
      generatedAt: "2026-08-10T00:00:00.000Z",
      regular: sourceDocument(sourceItem({ id: "../bad" })),
      pve: sourceDocument(item),
      english,
      korean,
      localItems: [],
    })).toThrow(/item id/i);

    const catalog = buildItemPriceCatalog({
      generatedAt: "2026-08-10T00:00:00.000Z",
      regular: sourceDocument(item),
      pve: sourceDocument(item),
      english,
      korean,
      localItems: [
        { wikiPageLink: item.wikiLink, localIcon: "assets/items/first.webp" },
        { wikiPageLink: item.wikiLink, localIcon: "assets/items/second.webp" },
      ],
    });
    expect(catalog.items[0]).not.toHaveProperty("localIcon");
  });

  it("sorts deterministically and uses English when Korean text is unavailable", () => {
    const first = sourceItem();
    const second = sourceItem({
      id: "5a0c27731526d80618476ac4",
      name: "5a0c27731526d80618476ac4 Name",
      shortName: "5a0c27731526d80618476ac4 ShortName",
      normalizedName: "zulu-item",
      wikiLink: "https://escapefromtarkov.fandom.com/wiki/Zulu_item",
      link: "https://tarkov.dev/item/zulu-item",
    });
    const translations = {
      data: {
        ...english.data,
        "5a0c27731526d80618476ac4 Name": "Zulu item",
        "5a0c27731526d80618476ac4 ShortName": "Zulu",
      },
    };
    const regular = { data: { items: { [second.id]: second, [first.id]: first } } };
    const catalog = buildItemPriceCatalog({
      generatedAt: "2026-08-10T00:00:00.000Z",
      regular,
      pve: regular,
      english: translations,
      korean: { data: korean.data },
      localItems: [],
    });

    expect(catalog.items.map(({ id }) => id)).toEqual([first.id, second.id]);
    expect(catalog.items[1]).toMatchObject({ nameEn: "Zulu item", nameKo: "Zulu item" });
  });

  it("enforces a byte cap before parsing an upstream response", async () => {
    const response = new Response(JSON.stringify({ data: { items: {} } }), {
      headers: { "content-type": "application/json" },
    });
    await expect(readBoundedJsonResponse(response, 8)).rejects.toThrow(/size limit/i);
  });
});
