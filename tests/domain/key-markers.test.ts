import { describe, expect, it } from "vitest";

import {
  isKeyItem,
  keyItemLabel,
  keyItemsForMap,
  keyMarkerIsVisible,
} from "../../src/domain/key-markers";

const key = {
  id: "key-1",
  name: "Dorm key",
  nameEn: "Dorm room key",
  nameKo: "기숙사 열쇠",
  shortNameEn: "Dorm 103",
  shortNameKo: "기숙사 103",
  categories: ["Keys"],
  category: "Keys",
  isDogtagItem: false,
};

describe("key marker helpers", () => {
  it("recognizes keys and keycards without matching unrelated items", () => {
    expect(isKeyItem(key)).toBe(true);
    expect(isKeyItem({ ...key, category: "Weapon", categories: ["Weapons"] })).toBe(false);
  });

  it("returns only mapped key items in stable short-name order", () => {
    const items = keyItemsForMap({ items: [
      { ...key, id: "key-2", shortNameEn: "Zeta" },
      { ...key, id: "key-1", shortNameEn: "Alpha" },
      { ...key, id: "not-a-key", category: "Weapon", categories: ["Weapons"] },
    ] }, ["key-1", "key-2", "not-a-key"]);
    expect(items.map((item) => item.id)).toEqual(["key-1", "key-2"]);
    expect(keyItemLabel(items[0])).toBe("기숙사 103");
  });

  it("hides a key marker when its item is unchecked or floor differs", () => {
    const marker = {
      id: "marker-1",
      mapKey: "Customs",
      itemId: "key-1",
      x: 1,
      y: 2,
      z: 3,
      floorId: "main",
      lootTier: "normal" as const,
      createdAt: "2026-08-25T00:00:00Z",
    };
    expect(keyMarkerIsVisible(marker, "main", new Set())).toBe(true);
    expect(keyMarkerIsVisible(marker, "level2", new Set())).toBe(false);
    expect(keyMarkerIsVisible(marker, "main", new Set(["key-1"]))).toBe(false);
  });
});
