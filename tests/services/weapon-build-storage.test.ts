import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_SAVED_WEAPON_BUILDS,
  WEAPON_BUILD_STORAGE_KEY,
  loadWeaponBuild,
  resetWeaponBuild,
  saveWeaponBuild,
} from "../../src/services/weapon-build-storage";
import type { BuildNode, WeaponBuild } from "../../src/types/weapon-modding";

const weaponA = "5447a9cd4bdc2dbd208b4567";
const weaponB = "5c488a752e221602b412af63";
const receiver = "55d355e64bdc2d962f8b4569";
const scope = "5c0517910db83400232ffee5";
const receiverSlot = "55d30c4c4bdc2db4468b457e";
const scopeSlot = "55d30c4c4bdc2db4468b457f";

function build(weaponId: string, children: BuildNode[] = []): WeaponBuild {
  return {
    schemaVersion: 1,
    catalogDataVersion: "2026-08-26T00:00:00.000Z",
    weaponId,
    root: {
      instanceId: `root:${weaponId}`,
      itemId: weaponId,
      children,
    },
  };
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("weapon build storage", () => {
  it("saves and loads one sanitized build per weapon", () => {
    const saved = build(weaponA, [{
      instanceId: `root:${weaponA}/${receiverSlot}`,
      itemId: receiver,
      slotId: receiverSlot,
      children: [],
    }]);

    expect(saveWeaponBuild(saved)).toBe(true);
    expect(loadWeaponBuild(weaponA)).toEqual(saved);
    expect(loadWeaponBuild(weaponB)).toBeNull();

    const stored = JSON.parse(localStorage.getItem(WEAPON_BUILD_STORAGE_KEY) ?? "null") as {
      schemaVersion: number;
      builds: WeaponBuild[];
    };
    expect(stored.schemaVersion).toBe(1);
    expect(stored.builds).toEqual([saved]);
  });

  it("replaces the previous build for the same weapon without duplicating it", () => {
    expect(saveWeaponBuild(build(weaponA))).toBe(true);
    const updated = build(weaponA, [{
      instanceId: `root:${weaponA}/${scopeSlot}`,
      itemId: scope,
      slotId: scopeSlot,
      children: [],
    }]);

    expect(saveWeaponBuild(updated)).toBe(true);
    expect(loadWeaponBuild(weaponA)).toEqual(updated);

    const stored = JSON.parse(localStorage.getItem(WEAPON_BUILD_STORAGE_KEY) ?? "null") as {
      builds: WeaponBuild[];
    };
    expect(stored.builds).toHaveLength(1);
  });

  it("resets only the requested weapon and preserves the other saved builds", () => {
    expect(saveWeaponBuild(build(weaponA))).toBe(true);
    expect(saveWeaponBuild(build(weaponB))).toBe(true);

    expect(resetWeaponBuild(weaponA)).toBe(true);
    expect(loadWeaponBuild(weaponA)).toBeNull();
    expect(loadWeaponBuild(weaponB)).toEqual(build(weaponB));
  });

  it("ignores malformed, legacy, and unsafe tree data without throwing", () => {
    const invalidPayloads: unknown[] = [
      "not-json",
      JSON.stringify({ schemaVersion: 0, builds: [build(weaponA)] }),
      JSON.stringify({
        schemaVersion: 1,
        builds: [{
          ...build(weaponA),
          root: { ...build(weaponA).root, itemId: weaponB },
        }],
      }),
      JSON.stringify({
        schemaVersion: 1,
        builds: [{
          ...build(weaponA),
          root: {
            ...build(weaponA).root,
            children: [{
              instanceId: `root:${weaponA}`,
              itemId: receiver,
              slotId: receiverSlot,
              children: [],
            }],
          },
        }],
      }),
    ];

    for (const payload of invalidPayloads) {
      localStorage.setItem(WEAPON_BUILD_STORAGE_KEY, String(payload));
      expect(() => loadWeaponBuild(weaponA)).not.toThrow();
      expect(loadWeaponBuild(weaponA)).toBeNull();
    }
  });

  it("strips unexpected properties instead of returning untrusted objects", () => {
    const unsafe = {
      ...build(weaponA),
      secret: "discard me",
      root: {
        ...build(weaponA).root,
        secret: "discard me too",
      },
    };
    localStorage.setItem(WEAPON_BUILD_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      builds: [unsafe],
    }));

    expect(loadWeaponBuild(weaponA)).toEqual(build(weaponA));
  });

  it("keeps storage bounded by evicting the oldest weapon builds", () => {
    const weaponIds = Array.from({ length: MAX_SAVED_WEAPON_BUILDS + 1 }, (_, index) =>
      index.toString(16).padStart(24, "0"),
    );

    for (const weaponId of weaponIds) {
      expect(saveWeaponBuild(build(weaponId))).toBe(true);
    }

    expect(loadWeaponBuild(weaponIds[0])).toBeNull();
    expect(loadWeaponBuild(weaponIds.at(-1)!)).toEqual(build(weaponIds.at(-1)!));
    const stored = JSON.parse(localStorage.getItem(WEAPON_BUILD_STORAGE_KEY) ?? "null") as {
      builds: WeaponBuild[];
    };
    expect(stored.builds).toHaveLength(MAX_SAVED_WEAPON_BUILDS);
  });

  it("fails closed when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });

    expect(loadWeaponBuild(weaponA)).toBeNull();
    expect(saveWeaponBuild(build(weaponA))).toBe(false);
    expect(resetWeaponBuild(weaponA)).toBe(false);
  });

  it("does not overwrite saved data when an existing store cannot be read", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });

    expect(saveWeaponBuild(build(weaponA))).toBe(false);
    expect(resetWeaponBuild(weaponA)).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{unfinished"],
    ["empty but existing payload", ""],
    ["legacy schema", JSON.stringify({ schemaVersion: 0, builds: [build(weaponB)] })],
    ["future schema", JSON.stringify({ schemaVersion: 2, builds: [build(weaponB)] })],
    ["malformed collection", JSON.stringify({ schemaVersion: 1, builds: {} })],
    ["a damaged entry alongside a valid draft", JSON.stringify({ schemaVersion: 1, builds: [build(weaponB), { broken: true }] })],
    ["duplicate weapon entries", JSON.stringify({ schemaVersion: 1, builds: [build(weaponB), build(weaponB)] })],
  ])("preserves %s without treating it as an empty writable store", (_description, payload) => {
    localStorage.setItem(WEAPON_BUILD_STORAGE_KEY, payload);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    expect(saveWeaponBuild(build(weaponA))).toBe(false);
    expect(resetWeaponBuild(weaponB)).toBe(false);
    expect(localStorage.getItem(WEAPON_BUILD_STORAGE_KEY)).toBe(payload);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it("accepts an absent store or a valid empty collection as a writable initial state", () => {
    for (const payload of [null, JSON.stringify({ schemaVersion: 1, builds: [] })]) {
      if (payload === null) localStorage.removeItem(WEAPON_BUILD_STORAGE_KEY);
      else localStorage.setItem(WEAPON_BUILD_STORAGE_KEY, payload);
      expect(saveWeaponBuild(build(weaponA))).toBe(true);
      expect(loadWeaponBuild(weaponA)).toEqual(build(weaponA));
      expect(resetWeaponBuild(weaponA)).toBe(true);
      expect(localStorage.getItem(WEAPON_BUILD_STORAGE_KEY)).toBeNull();
    }
  });

  it("preserves an existing collection above the supported limit instead of dropping its unread tail", () => {
    const builds = Array.from({ length: MAX_SAVED_WEAPON_BUILDS + 1 }, (_, index) =>
      build(index.toString(16).padStart(24, "0")),
    );
    const original = JSON.stringify({ schemaVersion: 1, builds });
    localStorage.setItem(WEAPON_BUILD_STORAGE_KEY, original);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");

    expect(loadWeaponBuild(builds[0].weaponId)).toBeNull();
    expect(saveWeaponBuild(build(weaponA))).toBe(false);
    expect(resetWeaponBuild(builds[0].weaponId)).toBe(false);
    expect(localStorage.getItem(WEAPON_BUILD_STORAGE_KEY)).toBe(original);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });
});
