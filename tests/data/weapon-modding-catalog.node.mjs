import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildWeaponModCatalog,
  enrichWeaponModFactoryPrices,
  readBoundedJsonResponse,
} from "../../scripts/weapon-modding-catalog.mjs";

const WEAPON_ID = "5447a9cd4bdc2dbd208b4567";
const DEFAULT_PRESET_ID = "5af08cf886f774223c269184";
const DEFAULT_PART_ID = "55d4b9964bdc2d1d4e8b456e";
const DIRECT_PART_ID = "55d355e64bdc2d962f8b4569";
const CATEGORY_PART_ID = "5d440625a4b9361eec4ae6c5";
const CHILD_PART_ID = "5d44064fa4b9361e4f6eb8b5";
const UNRELATED_ID = "5c0530ee86f774697952d952";
const MOD_CATEGORY_ID = "55802f4a4bdc2ddb688b4569";
const NESTED_CATEGORY_ID = "55802f4a4bdc2ddb688b457a";
const CONFLICT_SLOT_ID = "55d35d0c4bdc2d892f8b456c";
const CONFLICT_CATEGORY_ID = "55818a304bdc2db5418b457d";
const CHILD_SLOT_ID = "55d35d754bdc2d882f8b456b";
const NESTED_SLOT_ID = "55d35e074bdc2d882f8b456c";
const SECOND_ROOT_SLOT_ID = "55d35e074bdc2d882f8b456d";

function slot(overrides = {}) {
  return {
    id: "55d354084bdc2d8c2f8b4568",
    nameId: "mod_pistol_grip",
    name: "MOD_PISTOL_GRIP",
    required: true,
    filters: {
      allowedCategories: [],
      allowedItems: [DEFAULT_PART_ID, DIRECT_PART_ID],
      excludedCategories: [],
      excludedItems: [],
    },
    ...overrides,
  };
}

function sourceItem(id, overrides = {}) {
  return {
    id,
    name: `${id} Name`,
    shortName: `${id} ShortName`,
    normalizedName: `item-${id}`,
    width: 1,
    height: 1,
    weight: 0.1,
    categories: [MOD_CATEGORY_ID],
    types: ["mods"],
    iconLink: `https://assets.tarkov.dev/${id}-icon.webp`,
    gridImageLink: `https://assets.tarkov.dev/${id}-grid-image.webp`,
    baseImageLink: `https://assets.tarkov.dev/${id}-base-image.webp`,
    inspectImageLink: `https://assets.tarkov.dev/${id}-image.webp`,
    image512pxLink: `https://assets.tarkov.dev/${id}-512.webp`,
    conflictingItems: [],
    conflictingSlotIds: [],
    conflictingCategories: [],
    minLevelForFlea: 15,
    lastLowPrice: 12_345,
    avg24hPrice: 13_000,
    low24hPrice: 11_000,
    high24hPrice: 15_000,
    lastOfferCount: 9,
    lastScan: "2026-08-25T23:58:01.000Z",
    buyFromTrader: [],
    containsItems: [],
    properties: {
      propertiesType: "ItemPropertiesWeaponMod",
      ergonomics: 2,
      recoilModifier: -0.04,
      accuracyModifier: 0.01,
      slots: [],
    },
    ergonomicsModifier: 2,
    recoilModifier: -4,
    accuracyModifier: 1,
    ...overrides,
  };
}

function translations(items, language) {
  const data = {};
  for (const item of Object.values(items)) {
    data[item.name] = language === "ko" ? `한국어 ${item.id}` : `English ${item.id}`;
    data[item.shortName] = language === "ko" ? `한국 ${item.id.slice(-4)}` : `EN ${item.id.slice(-4)}`;
  }
  return { data };
}

function taskFixture() {
  const task = {
    id: "5969f9e986f7741dde183a50",
    name: "5969f9e986f7741dde183a50 name",
    minPlayerLevel: 10,
  };
  return {
    tasks: { data: { tasks: { [task.id]: task } } },
    taskEnglish: { data: { [task.name]: "Pharmacist" } },
    taskKorean: { data: { [task.name]: "약사" } },
  };
}

function sourceFixture() {
  const directPart = sourceItem(DIRECT_PART_ID, {
    conflictingItems: [CHILD_PART_ID],
    conflictingSlotIds: [CONFLICT_SLOT_ID],
    conflictingCategories: [CONFLICT_CATEGORY_ID],
    properties: {
      propertiesType: "ItemPropertiesWeaponMod",
      ergonomics: 5,
      recoilModifier: -0.01,
      accuracyModifier: 0,
      centerOfImpact: 0.053,
      slots: [slot({
        id: CHILD_SLOT_ID,
        nameId: "mod_muzzle",
        name: "MOD_MUZZLE",
        required: false,
        filters: {
          allowedCategories: [NESTED_CATEGORY_ID],
          allowedItems: [],
          excludedCategories: [],
          excludedItems: [UNRELATED_ID],
        },
      })],
    },
    buyFromTrader: [
      {
        trader: "5935c25fb3acc3127c3d8cd9",
        price: 55,
        priceRUB: 6622,
        currency: "USD",
        currencyItem: "5696686a4bdc2da3298b456a",
        minTraderLevel: 2,
        taskUnlock: null,
        buyLimit: 8,
      },
      {
        trader: "5a7c2eca46aef81a7ca2145d",
        price: 6498,
        priceRUB: 6498,
        currency: "RUB",
        currencyItem: "5449016a4bdc2d6f028b456f",
        minTraderLevel: 3,
        taskUnlock: "5969f9e986f7741dde183a50",
        buyLimit: 5,
      },
    ],
  });
  const items = {
    [WEAPON_ID]: sourceItem(WEAPON_ID, {
      types: ["gun", "wearable"],
      categories: ["5447b5f14bdc2d61278b4567"],
      weight: 0.75,
      containsItems: [{ item: DEFAULT_PART_ID, count: 1, attributes: {} }],
      properties: {
        propertiesType: "ItemPropertiesWeapon",
        caliber: "Caliber556x45NATO",
        ergonomics: 48,
        recoilVertical: 119,
        recoilHorizontal: 342,
        fireRate: 800,
        effectiveDistance: 500,
        sightingRange: 100,
        centerOfImpact: 0.01,
        deviationCurve: 1.35,
        deviationMax: 23,
        slots: [
          slot(),
          slot({
            id: SECOND_ROOT_SLOT_ID,
            nameId: "mod_second",
            name: "MOD_SECOND",
            required: false,
            filters: {
              allowedCategories: [],
              allowedItems: [DIRECT_PART_ID],
              excludedCategories: [],
              excludedItems: [],
            },
          }),
        ],
        defaultPreset: DEFAULT_PRESET_ID,
        fireModes: ["single", "fullauto"],
      },
      ergonomicsModifier: 48,
      recoilModifier: undefined,
      accuracyModifier: undefined,
    }),
    [DEFAULT_PRESET_ID]: sourceItem(DEFAULT_PRESET_ID, {
      types: ["preset"],
      categories: ["5661632d4bdc2d903d8b456b"],
      containsItems: [
        { item: WEAPON_ID, count: 1, attributes: {} },
        { item: DEFAULT_PART_ID, count: 1, attributes: {} },
        { item: DIRECT_PART_ID, count: 2, attributes: {} },
      ],
      properties: {
        propertiesType: "ItemPropertiesPreset",
        baseItem: WEAPON_ID,
        default: true,
      },
    }),
    [DEFAULT_PART_ID]: sourceItem(DEFAULT_PART_ID, {
      properties: {
        propertiesType: "ItemPropertiesWeaponMod",
        slots: [slot({
          id: "55d35d0c4bdc2d892f8b456d",
          nameId: "mod_nested",
          name: "MOD_NESTED",
          required: false,
          filters: {
            allowedCategories: [],
            allowedItems: [DIRECT_PART_ID],
            excludedCategories: [],
            excludedItems: [],
          },
        })],
      },
    }),
    [DIRECT_PART_ID]: directPart,
    [CATEGORY_PART_ID]: sourceItem(CATEGORY_PART_ID, {
      categories: [NESTED_CATEGORY_ID],
      properties: {
        propertiesType: "ItemPropertiesWeaponMod",
        ergonomics: -4,
        recoilModifier: -0.07,
        accuracyModifier: 0.01,
        slots: [slot({
          id: NESTED_SLOT_ID,
          filters: {
            allowedCategories: [],
            allowedItems: [CHILD_PART_ID],
            excludedCategories: [],
            excludedItems: [],
          },
        })],
      },
    }),
    [CHILD_PART_ID]: sourceItem(CHILD_PART_ID),
    [UNRELATED_ID]: sourceItem(UNRELATED_ID, {
      categories: ["5448fe124bdc2da5018b4567"],
      iconLink: "https://evil.example/private.png",
    }),
  };
  const pveItems = structuredClone(items);
  pveItems[DIRECT_PART_ID].lastLowPrice = 54_321;
  pveItems[DIRECT_PART_ID].minLevelForFlea = 25;
  pveItems[DIRECT_PART_ID].low24hPrice = 51_000;
  pveItems[DIRECT_PART_ID].avg24hPrice = 56_000;
  pveItems[DIRECT_PART_ID].buyFromTrader = [{
    trader: "5a7c2eca46aef81a7ca2145d",
    price: 4_500,
    priceRUB: 4_500,
    currency: "RUB",
    currencyItem: "5449016a4bdc2d6f028b456f",
    minTraderLevel: 2,
    taskUnlock: null,
    buyLimit: 5,
  }];
  return {
    regular: { data: { items } },
    pve: { data: { items: pveItems } },
    english: translations(items, "en"),
    korean: translations(items, "ko"),
    ...taskFixture(),
  };
}

describe("weapon modding catalog generation", () => {
  it("prices the verified default preset separately from the bare receiver", () => {
    const source = sourceFixture();
    const offer = (price) => ({
      trader: "5935c25fb3acc3127c3d8cd9", price, priceRUB: price,
      currency: "RUB", minTraderLevel: 2, taskUnlock: null,
    });
    source.regular.data.items[WEAPON_ID].buyFromTrader = [offer(20_000)];
    source.regular.data.items[DEFAULT_PRESET_ID].buyFromTrader = [offer(110_000)];
    source.pve.data.items[DEFAULT_PRESET_ID].buyFromTrader = [offer(120_000)];

    const catalog = buildWeaponModCatalog({ generatedAt: "2026-09-07T00:00:00.000Z", ...source });
    const weapon = catalog.items.find(({ id }) => id === WEAPON_ID);

    assert.equal(weapon.traderOffersByProfile.pvp[0].priceRoubles, 20_000);
    assert.equal(weapon.factoryTraderOffersByProfile.pvp[0].priceRoubles, 110_000);
    assert.equal(weapon.factoryTraderOffersByProfile.pve[0].priceRoubles, 120_000);
    assert.equal(weapon.factoryPriceUpdatedAt, "2026-09-07T00:00:00.000Z");
    assert.equal(catalog.items.filter((item) => item.kind === "part")
      .some((item) => item.factoryTraderOffersByProfile !== undefined), false);
  });

  it("does not replace an unavailable factory quote with a receiver or another profile", () => {
    const source = sourceFixture();
    const offer = {
      trader: "5935c25fb3acc3127c3d8cd9", price: 110_000, priceRUB: 110_000,
      currency: "RUB", minTraderLevel: 2, taskUnlock: null,
    };
    source.regular.data.items[WEAPON_ID].buyFromTrader = [offer];
    source.pve.data.items[DEFAULT_PRESET_ID].buyFromTrader = [offer];
    // The same preset identity now contains a different assembly in PVE.
    source.pve.data.items[DEFAULT_PRESET_ID].containsItems = [
      { item: WEAPON_ID, count: 1, attributes: {} },
      { item: DEFAULT_PART_ID, count: 1, attributes: {} },
    ];
    const catalog = buildWeaponModCatalog({ generatedAt: "2026-09-07T00:00:00.000Z", ...source });
    const weapon = catalog.items.find(({ id }) => id === WEAPON_ID);

    assert.equal(weapon.factoryTraderOffersByProfile, undefined);
    assert.equal(weapon.factoryPriceUpdatedAt, undefined);
  });

  it("enriches only factory pricing without refreshing catalog data or borrowing profile quotes", () => {
    const source = sourceFixture();
    const original = buildWeaponModCatalog({ generatedAt: "2026-08-26T00:00:00.000Z", ...source });
    const before = structuredClone(original);
    source.regular.data.items[DEFAULT_PRESET_ID].buyFromTrader = [{
      trader: "5935c25fb3acc3127c3d8cd9", price: 110_000, priceRUB: 110_000,
      currency: "RUB", minTraderLevel: 2, taskUnlock: null,
    }];
    // Unrelated newer data must not leak into this focused update.
    source.regular.data.items[DIRECT_PART_ID].lastLowPrice = 999_999;
    const enriched = enrichWeaponModFactoryPrices({
      catalog: original, generatedAt: "2026-09-07T00:00:00.000Z", ...source,
    });
    const weapon = enriched.catalog.items.find(({ id }) => id === WEAPON_ID);

    assert.deepEqual(original, before);
    assert.equal(enriched.catalog.dataVersion, before.dataVersion);
    assert.equal(weapon.factoryTraderOffersByProfile.pvp[0].priceRoubles, 110_000);
    assert.equal(weapon.factoryTraderOffersByProfile.pve, undefined);
    assert.equal(weapon.factoryPriceUpdatedAt, "2026-09-07T00:00:00.000Z");
    assert.deepEqual(enriched.catalog.items.map((item) => {
      const withoutPricing = { ...item };
      delete withoutPricing.factoryTraderOffersByProfile;
      delete withoutPricing.factoryPriceUpdatedAt;
      return withoutPricing;
    }), before.items);
    assert.equal(enriched.report.pvp.quoted, 1);
    assert.equal(enriched.report.pve.missing.length, 1);
  });

  it("removes stale factory quotes if the preset identity or full tree changed", () => {
    const source = sourceFixture();
    const original = buildWeaponModCatalog({ generatedAt: "2026-08-26T00:00:00.000Z", ...source });
    const weapon = original.items.find(({ id }) => id === WEAPON_ID);
    weapon.factoryTraderOffersByProfile = { pvp: [], pve: [] };
    weapon.factoryPriceUpdatedAt = "2026-08-26T00:00:00.000Z";
    const offer = {
      trader: "5935c25fb3acc3127c3d8cd9", price: 110_000, priceRUB: 110_000,
      currency: "RUB", minTraderLevel: 2, taskUnlock: null,
    };
    source.regular.data.items[DEFAULT_PRESET_ID].buyFromTrader = [offer];
    source.pve.data.items[DEFAULT_PRESET_ID].buyFromTrader = [offer];
    source.regular.data.items[DEFAULT_PRESET_ID].containsItems[2].count = 1;
    source.pve.data.items[WEAPON_ID].properties.defaultPreset = UNRELATED_ID;
    const enriched = enrichWeaponModFactoryPrices({
      catalog: original, generatedAt: "2026-09-07T00:00:00.000Z", ...source,
    });
    const updatedWeapon = enriched.catalog.items.find(({ id }) => id === WEAPON_ID);

    assert.equal(updatedWeapon.factoryTraderOffersByProfile, undefined);
    assert.equal(updatedWeapon.factoryPriceUpdatedAt, undefined);
    assert.equal(enriched.report.pvp.quoted, 0);
    assert.equal(enriched.report.pvp.missing[0].reason, "preset-tree-changed");
    assert.equal(enriched.report.pve.missing[0].reason, "preset-id-changed");
  });

  it("collects weapons plus factory, direct, category, and recursively allowed parts", () => {
    const source = sourceFixture();
    const catalog = buildWeaponModCatalog({
      generatedAt: "2026-08-26T00:00:00.000Z",
      ...source,
    });

    assert.equal(catalog.schemaVersion, 1);
    assert.equal(catalog.dataVersion, "2026-08-26T00:00:00.000Z");
    assert.deepEqual(catalog.weaponIds, [WEAPON_ID]);
    assert.deepEqual(catalog.items.map(({ id }) => id), [
      WEAPON_ID,
      DIRECT_PART_ID,
      DEFAULT_PART_ID,
      CATEGORY_PART_ID,
      CHILD_PART_ID,
    ].sort());
    assert.equal(catalog.items.some(({ id }) => id === UNRELATED_ID), false);
  });

  it("preserves localized identity, safe images, slots, conflicts, modifiers, offers, and flea data", () => {
    const catalog = buildWeaponModCatalog({
      generatedAt: "2026-08-26T00:00:00.000Z",
      ...sourceFixture(),
    });
    const item = catalog.items.find(({ id }) => id === DIRECT_PART_ID);

    assert.ok(item);
    assert.deepEqual({
      kind: item.kind,
      nameEn: item.nameEn,
      nameKo: item.nameKo,
      imageUrl: item.imageUrl,
      iconUrl: item.iconUrl,
      stats: item.stats,
      conflicts: item.conflicts,
      traderOffersByProfile: item.traderOffersByProfile,
      fleaByProfile: item.fleaByProfile,
    }, {
      kind: "part",
      nameEn: `English ${DIRECT_PART_ID}`,
      nameKo: `한국어 ${DIRECT_PART_ID}`,
      imageUrl: `https://assets.tarkov.dev/${DIRECT_PART_ID}-image.webp`,
      iconUrl: `https://assets.tarkov.dev/${DIRECT_PART_ID}-icon.webp`,
      stats: {
        weight: 0.1,
        ergonomics: 2,
        recoilModifier: -4,
        centerOfImpact: 0.053,
      },
      conflicts: {
        itemIds: [CHILD_PART_ID],
        slotIds: [CONFLICT_SLOT_ID],
        categories: [CONFLICT_CATEGORY_ID],
      },
      traderOffersByProfile: {
        pvp: [{
          traderId: "5a7c2eca46aef81a7ca2145d",
          traderName: "Mechanic",
          price: 6498,
          priceRoubles: 6498,
          currency: "RUB",
          loyaltyLevel: 3,
          questUnlock: {
            questId: "5969f9e986f7741dde183a50",
            questName: "약사",
            minimumPlayerLevel: 10,
          },
        }, {
          traderId: "5935c25fb3acc3127c3d8cd9",
          traderName: "Peacekeeper",
          price: 55,
          priceRoubles: 6622,
          currency: "USD",
          loyaltyLevel: 2,
        }],
        pve: [{
          traderId: "5a7c2eca46aef81a7ca2145d",
          traderName: "Mechanic",
          price: 4500,
          priceRoubles: 4500,
          currency: "RUB",
          loyaltyLevel: 2,
        }],
      },
      fleaByProfile: {
        pvp: {
          price: 12_345,
          currency: "RUB",
          updatedAt: "2026-08-25T23:58:01.000Z",
          minimumPlayerLevel: 15,
          lowPrice: 11_000,
          average24h: 13_000,
        },
        pve: {
          price: 54_321,
          currency: "RUB",
          updatedAt: "2026-08-25T23:58:01.000Z",
          minimumPlayerLevel: 25,
          lowPrice: 51_000,
          average24h: 56_000,
        },
      },
    });
    assert.deepEqual(item.slots[0], {
      id: CHILD_SLOT_ID,
      name: "MOD_MUZZLE",
      required: false,
      allowedItemIds: [],
      allowedCategories: [NESTED_CATEGORY_ID],
      excludedItemIds: [UNRELATED_ID],
      excludedCategories: [],
    });
  });

  it("includes base weapon stats and factory part ids from the default preset", () => {
    const catalog = buildWeaponModCatalog({
      generatedAt: "2026-08-26T00:00:00.000Z",
      ...sourceFixture(),
    });
    const weapon = catalog.items.find(({ id }) => id === WEAPON_ID);

    assert.ok(weapon);
    assert.deepEqual({
      kind: weapon.kind,
      factoryPartIds: weapon.factoryPartIds,
      factoryPresetId: weapon.factoryPresetId,
      factoryImageUrl: weapon.factoryImageUrl,
      factoryPartsByParent: weapon.factoryPartsByParent,
      factoryPresetBuild: weapon.factoryPresetBuild,
      baseStats: weapon.baseStats,
    }, {
      kind: "weapon",
      factoryPartIds: [DIRECT_PART_ID, DEFAULT_PART_ID],
      factoryPresetId: DEFAULT_PRESET_ID,
      factoryImageUrl: `https://assets.tarkov.dev/${DEFAULT_PRESET_ID}-image.webp`,
      factoryPartsByParent: {
        [WEAPON_ID]: [DIRECT_PART_ID, DEFAULT_PART_ID],
        [DEFAULT_PART_ID]: [DIRECT_PART_ID],
      },
      factoryPresetBuild: [{
        itemId: DEFAULT_PART_ID,
        slotId: "55d354084bdc2d8c2f8b4568",
        children: [{
          itemId: DIRECT_PART_ID,
          slotId: "55d35d0c4bdc2d892f8b456d",
          children: [],
        }],
      }, {
        itemId: DIRECT_PART_ID,
        slotId: SECOND_ROOT_SLOT_ID,
        children: [],
      }],
      baseStats: {
        ergonomics: 48,
        verticalRecoil: 119,
        horizontalRecoil: 342,
        weight: 0.75,
        centerOfImpact: 0.01,
      },
    });
  });

  it("rejects malformed source ids and unsafe declared response sizes", async () => {
    const source = sourceFixture();
    source.regular.data.items[WEAPON_ID].id = "../bad";
    assert.throws(() => buildWeaponModCatalog({
      generatedAt: "2026-08-26T00:00:00.000Z",
      ...source,
    }), /item id/i);

    const response = new Response(JSON.stringify({ data: { items: {} } }), {
      headers: { "content-length": "999" },
    });
    await assert.rejects(readBoundedJsonResponse(response, 100), /size limit/i);
  });
});
