import { describe, expect, it, vi } from "vitest";

import bundledCatalogJson from "../../public/data/weapon-modding/catalog.json?raw";

import {
  EMPTY_WEAPON_MOD_CATALOG,
  loadWeaponModCatalog,
  parseWeaponModCatalog,
} from "../../src/services/weapon-mod-data";
import type { WeaponCatalog } from "../../src/types/weapon-modding";

const weaponId = "5447a9cd4bdc2dbd208b4567";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function catalog(): WeaponCatalog {
  return {
    schemaVersion: 1,
    dataVersion: "2026-08-26T00:00:00.000Z",
    weaponIds: [weaponId],
    items: [{
      id: weaponId,
      name: "M4A1",
      nameEn: "M4A1",
      nameKo: "M4A1",
      shortName: "M4A1",
      kind: "weapon",
      categories: ["5447b5f14bdc2d61278b4567"],
      imageUrl: `https://assets.tarkov.dev/${weaponId}-image.webp`,
      iconUrl: `https://assets.tarkov.dev/${weaponId}-icon.webp`,
      slots: [],
      factoryPartIds: [],
      baseStats: {
        verticalRecoil: 119,
        horizontalRecoil: 342,
        ergonomics: 48,
        weight: 0.75,
      },
    }],
  };
}

describe("weapon mod catalog boundary", () => {
  it("accepts the complete catalog shipped in the application bundle", async () => {
    const payload = JSON.parse(bundledCatalogJson) as unknown;

    const parsed = parseWeaponModCatalog(payload);

    expect(parsed?.weaponIds.length).toBeGreaterThan(100);
    expect(parsed?.items.length).toBeGreaterThan(2_000);
    expect(parsed?.items.filter((item) => (
      (item.fleaByProfile?.pvp?.minimumPlayerLevel ?? 0) > 0 ||
      (item.fleaByProfile?.pve?.minimumPlayerLevel ?? 0) > 0
    )).length).toBeGreaterThan(500);
  });

  it("loads a valid bundled catalog without relying on an external API", async () => {
    const payload = catalog();
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

    await expect(loadWeaponModCatalog(undefined, request)).resolves.toEqual(payload);
    expect(request).toHaveBeenCalledWith(expect.stringMatching(/data\/weapon-modding\/catalog\.json$/), {
      cache: "default",
      headers: { Accept: "application/json" },
      signal: undefined,
    });
  });

  it("loads and parses one catalog only once per browser session", async () => {
    const payload = catalog();
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload));

    await expect(loadWeaponModCatalog(undefined, request)).resolves.toEqual(payload);
    await expect(loadWeaponModCatalog(undefined, request)).resolves.toEqual(payload);

    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates the normalized RUB value on trader offers", () => {
    const payload = catalog();
    payload.items[0].traderOffers = [{
      traderId: "5935c25fb3acc3127c3d8cd9",
      traderName: "Peacekeeper",
      price: 55,
      priceRoubles: 6622,
      currency: "USD",
      loyaltyLevel: 2,
    }];

    expect(parseWeaponModCatalog(payload)?.items[0].traderOffers?.[0]).toMatchObject({
      price: 55,
      priceRoubles: 6622,
      currency: "USD",
    });

    payload.items[0].traderOffers![0].priceRoubles = -1;
    expect(parseWeaponModCatalog(payload)).toBeNull();
  });

  it("validates profile-specific trader offers and quest unlock metadata", () => {
    const payload = catalog();
    payload.items[0].traderOffersByProfile = {
      pve: [{
        traderId: "5a7c2eca46aef81a7ca2145d",
        traderName: "Mechanic",
        price: 4_500,
        priceRoubles: 4_500,
        currency: "RUB",
        loyaltyLevel: 2,
        questUnlock: {
          questId: "5969f9e986f7741dde183a50",
          questName: "약사",
          minimumPlayerLevel: 10,
        },
      }],
    };

    expect(parseWeaponModCatalog(payload)?.items[0].traderOffersByProfile?.pve?.[0])
      .toMatchObject({ priceRoubles: 4_500, questUnlock: { questName: "약사" } });
    payload.items[0].traderOffersByProfile.pve![0].questUnlock!.minimumPlayerLevel = -1;
    expect(parseWeaponModCatalog(payload)).toBeNull();
  });

  it("validates profile-specific flea unlock levels", () => {
    const payload = catalog();
    payload.items[0].fleaByProfile = {
      pvp: {
        price: 45_000,
        currency: "RUB",
        updatedAt: "2026-08-26T00:00:00.000Z",
        minimumPlayerLevel: 15,
      },
    };

    expect(parseWeaponModCatalog(payload)?.items[0].fleaByProfile?.pvp)
      .toMatchObject({ price: 45_000, minimumPlayerLevel: 15 });
    payload.items[0].fleaByProfile.pvp!.minimumPlayerLevel = 101;
    expect(parseWeaponModCatalog(payload)).toBeNull();
  });

  it("falls back safely for unavailable, malformed, and legacy catalogs", async () => {
    const onFailure = vi.fn();
    const unavailable = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 503));
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...catalog(), weaponIds: ["missing"] }));
    const legacy = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ...catalog(), schemaVersion: 0 }));
    const rejected = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network failed"));

    await expect(loadWeaponModCatalog(undefined, unavailable, onFailure)).resolves.toEqual(EMPTY_WEAPON_MOD_CATALOG);
    await expect(loadWeaponModCatalog(undefined, malformed, onFailure)).resolves.toEqual(EMPTY_WEAPON_MOD_CATALOG);
    await expect(loadWeaponModCatalog(undefined, legacy, onFailure)).resolves.toEqual(EMPTY_WEAPON_MOD_CATALOG);
    await expect(loadWeaponModCatalog(undefined, rejected, onFailure)).resolves.toEqual(EMPTY_WEAPON_MOD_CATALOG);
    expect(onFailure.mock.calls).toEqual([
      ["REQUEST_FAILED"],
      ["INVALID_RESPONSE"],
      ["UNSUPPORTED_SCHEMA"],
      ["REQUEST_FAILED"],
    ]);
  });

  it("does not turn an intentional cancellation into an empty catalog", async () => {
    const aborted = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("Aborted", "AbortError"));
    await expect(loadWeaponModCatalog(undefined, aborted)).rejects.toMatchObject({ name: "AbortError" });
  });
});
