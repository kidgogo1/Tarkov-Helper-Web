import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_FAVORITE_WEAPONS,
  MAX_NAMED_WEAPON_PRESETS,
  MODDING_LIBRARY_STORAGE_KEY,
  loadModdingLibrary,
  removeNamedWeaponPreset,
  saveNamedWeaponPreset,
  setFavoriteWeapon,
} from "../../src/services/weapon-modding-library";
import { WEAPON_BUILD_STORAGE_KEY, saveWeaponBuild } from "../../src/services/weapon-build-storage";
import type { BuildNode, WeaponBuild } from "../../src/types/weapon-modding";

const weaponA = "5447a9cd4bdc2dbd208b4567";
const weaponB = "5c488a752e221602b412af63";
const partId = "5c0517910db83400232ffee5";
const slotId = "55d30c4c4bdc2db4468b457f";
const absentPresetId = "12345678-1234-4567-8123-123456789abc";

function build(weaponId = weaponA, children: BuildNode[] = []): WeaponBuild {
  return {
    schemaVersion: 1,
    catalogDataVersion: "2026-09-07",
    weaponId,
    root: { instanceId: `root:${weaponId}`, itemId: weaponId, children },
  };
}

function child(): BuildNode {
  return { instanceId: "scope", itemId: partId, slotId, children: [] };
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("named weapon modding library", () => {
  it("starts empty and keeps multiple named incomplete builds for one weapon", () => {
    expect(loadModdingLibrary()).toEqual({ ok: true, library: { presets: [], favoriteWeaponIds: [] } });
    const first = saveNamedWeaponPreset({ name: "  경량형  ", build: build() });
    const second = saveNamedWeaponPreset({ name: "야간형", build: build(weaponA, [child()]) });
    expect(first.ok && first.preset.name).toBe("경량형");
    expect(first.ok && first.preset.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.ok).toBe(true);
    const loaded = loadModdingLibrary();
    expect(loaded.ok).toBe(true);
    expect(loaded.library.presets.map(({ name }) => name)).toEqual(["경량형", "야간형"]);
    expect(loaded.library.presets[0].build.root.children).toEqual([]);
    expect(loaded.library.presets[1].build.root.children).toEqual([child()]);
  });

  it("overwrites only an explicit preset id while preserving other snapshots and favorites", () => {
    const first = saveNamedWeaponPreset({ name: "원거리", build: build() });
    const second = saveNamedWeaponPreset({ name: "근거리", build: build() });
    if (!first.ok || !second.ok) throw new Error("fixture save failed");
    setFavoriteWeapon(weaponB, true);
    const result = saveNamedWeaponPreset({ id: first.preset.id, name: "원거리 개선", build: build(weaponA, [child()]) });
    expect(result.ok && result.preset.id).toBe(first.preset.id);
    expect(result.ok && result.library.presets).toHaveLength(2);
    expect(result.ok && result.library.presets[1]).toEqual(second.preset);
    expect(result.ok && result.library.favoriteWeaponIds).toEqual([weaponB]);
    expect(loadModdingLibrary().library.presets[0].build.root.children).toEqual([child()]);
  });

  it("rejects normalized duplicate names for the same gun but permits them for another gun", () => {
    expect(saveNamedWeaponPreset({ name: "Ｍ４ ＣＱＢ", build: build() }).ok).toBe(true);
    expect(saveNamedWeaponPreset({ name: " m4 cqb ", build: build() })).toEqual({ ok: false, reason: "duplicate-name" });
    expect(saveNamedWeaponPreset({ name: "m4 cqb", build: build(weaponB) }).ok).toBe(true);
    const second = saveNamedWeaponPreset({ name: "다른 이름", build: build() });
    if (!second.ok) throw new Error("fixture save failed");
    expect(saveNamedWeaponPreset({ id: second.preset.id, name: "m4 cqb", build: build() }))
      .toEqual({ ok: false, reason: "duplicate-name" });
  });

  it("clones saved snapshots and keeps automatic draft storage independent", () => {
    const draft = build(weaponA, [child()]);
    const saved = saveNamedWeaponPreset({ name: "보존", build: draft });
    if (!saved.ok) throw new Error("fixture save failed");
    draft.root.children.length = 0;
    saved.preset.build.root.children[0].itemId = weaponB;
    saved.library.presets.length = 0;
    expect(saveWeaponBuild(draft)).toBe(true);
    const loaded = loadModdingLibrary();
    expect(loaded.library.presets[0].build).toEqual(build(weaponA, [child()]));
    loaded.library.presets[0].name = "변조";
    expect(loadModdingLibrary().library.presets[0].name).toBe("보존");
    expect(localStorage.getItem(WEAPON_BUILD_STORAGE_KEY)).not.toBeNull();
  });

  it("deletes only the named target and rejects missing or cross-weapon overwrite ids", () => {
    const first = saveNamedWeaponPreset({ name: "첫째", build: build() });
    const second = saveNamedWeaponPreset({ name: "둘째", build: build(weaponB) });
    if (!first.ok || !second.ok) throw new Error("fixture save failed");
    setFavoriteWeapon(weaponA, true);
    expect(saveNamedWeaponPreset({ id: absentPresetId, name: "없는 항목", build: build() }))
      .toEqual({ ok: false, reason: "not-found" });
    expect(saveNamedWeaponPreset({ id: first.preset.id, name: "다른 무기", build: build(weaponB) }))
      .toEqual({ ok: false, reason: "invalid" });
    expect(removeNamedWeaponPreset(first.preset.id)).toEqual({
      ok: true,
      library: { presets: [second.preset], favoriteWeaponIds: [weaponA] },
    });
    expect(removeNamedWeaponPreset(first.preset.id)).toEqual({ ok: false, reason: "not-found" });
  });

  it("rejects invalid names, ids and structurally unsafe builds without touching saved data", () => {
    saveNamedWeaponPreset({ name: "보존", build: build() });
    const before = localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY);
    for (const name of ["", "   ", "x".repeat(81), "줄\n바꿈"]) {
      expect(saveNamedWeaponPreset({ name, build: build() })).toEqual({ ok: false, reason: "invalid" });
    }
    const invalidBuilds = [
      { ...build(), schemaVersion: 2 },
      { ...build(), weaponId: "bad" },
      { ...build(), root: { ...build().root, itemId: weaponB } },
      build(weaponA, [child(), { ...child(), instanceId: "different" }]),
      build(weaponA, [{ ...child(), instanceId: build().root.instanceId }]),
    ];
    for (const invalid of invalidBuilds) {
      expect(saveNamedWeaponPreset({ name: "무효", build: invalid as WeaponBuild })).toEqual({ ok: false, reason: "invalid" });
    }
    expect(removeNamedWeaponPreset("not-an-id")).toEqual({ ok: false, reason: "invalid" });
    expect(setFavoriteWeapon("not-an-id", true)).toEqual({ ok: false, reason: "invalid" });
    expect(localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)).toBe(before);
  });

  it("does not persist prices, purchasing modes or other non-build payload fields", () => {
    const input = { ...build(), totalPrice: 999, purchaseMode: "owned", profile: "pve", root: { ...build().root, secret: "discard" } };
    expect(saveNamedWeaponPreset({ name: "구성만", build: input }).ok).toBe(true);
    const raw = localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)!;
    expect(raw).not.toMatch(/totalPrice|purchaseMode|profile|secret/);
    expect(loadModdingLibrary().library.presets[0].build).toEqual(build());
  });

  it("retains favorite insertion order and de-duplicates repeated selections and stored ids", () => {
    setFavoriteWeapon(weaponB, true);
    setFavoriteWeapon(weaponA, true);
    setFavoriteWeapon(weaponB, true);
    expect(loadModdingLibrary().library.favoriteWeaponIds).toEqual([weaponB, weaponA]);
    const raw = JSON.parse(localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)!);
    raw.favoriteWeaponIds.push(weaponB);
    localStorage.setItem(MODDING_LIBRARY_STORAGE_KEY, JSON.stringify(raw));
    expect(loadModdingLibrary().library.favoriteWeaponIds).toEqual([weaponB, weaponA]);
    expect(setFavoriteWeapon(weaponB, false).ok).toBe(true);
    expect(loadModdingLibrary().library.favoriteWeaponIds).toEqual([weaponA]);
    expect(setFavoriteWeapon(weaponB, false).ok).toBe(true);
  });

  it("never evicts named presets at the count limit and still permits overwrite", () => {
    for (let i = 0; i < MAX_NAMED_WEAPON_PRESETS; i += 1) {
      expect(saveNamedWeaponPreset({ name: `구성 ${i}`, build: build() }).ok).toBe(true);
    }
    const loaded = loadModdingLibrary();
    const before = localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY);
    expect(saveNamedWeaponPreset({ name: "초과", build: build() })).toEqual({ ok: false, reason: "limit" });
    expect(localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)).toBe(before);
    expect(saveNamedWeaponPreset({ id: loaded.library.presets[0].id, name: "수정 가능", build: build(weaponA, [child()]) }).ok).toBe(true);
    expect(loadModdingLibrary().library.presets).toHaveLength(MAX_NAMED_WEAPON_PRESETS);
  });

  it("caps favorite guns without evicting earlier quick selections", () => {
    for (let i = 0; i < MAX_FAVORITE_WEAPONS; i += 1) {
      expect(setFavoriteWeapon(i.toString(16).padStart(24, "0"), true).ok).toBe(true);
    }
    expect(setFavoriteWeapon(weaponA, true)).toEqual({ ok: false, reason: "limit" });
    expect(loadModdingLibrary().library.favoriteWeaponIds).toHaveLength(MAX_FAVORITE_WEAPONS);
    expect(setFavoriteWeapon("0".repeat(24), true).ok).toBe(true);
  });

  it("enforces the payload size limit without discarding an existing library", () => {
    saveNamedWeaponPreset({ name: "보존", build: build() });
    const before = localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY);
    const huge = build(weaponA, Array.from({ length: 511 }, (_, i) => ({
      instanceId: `${i}:`.padEnd(2048, "x"),
      itemId: partId,
      slotId: i.toString(16).padStart(24, "0"),
      children: [],
    })));
    expect(saveNamedWeaponPreset({ name: "큰 구성", build: huge })).toEqual({ ok: false, reason: "limit" });
    expect(localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)).toBe(before);
  });

  it.each(["", "not-json", JSON.stringify({ schemaVersion: 2, presets: [], favoriteWeaponIds: [] }), "x".repeat(1024 * 1024 + 1)])(
    "blocks writes for corrupt or unknown stored schemas (%#)", (raw) => {
      localStorage.setItem(MODDING_LIBRARY_STORAGE_KEY, raw);
      expect(loadModdingLibrary()).toEqual({ ok: false, library: { presets: [], favoriteWeaponIds: [] } });
      expect(saveNamedWeaponPreset({ name: "새 항목", build: build() })).toEqual({ ok: false, reason: "storage" });
      expect(removeNamedWeaponPreset(absentPresetId)).toEqual({ ok: false, reason: "storage" });
      expect(setFavoriteWeapon(weaponA, true)).toEqual({ ok: false, reason: "storage" });
      expect(localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)).toBe(raw);
    },
  );

  it("blocks writes instead of silently dropping malformed saved entries", () => {
    const saved = saveNamedWeaponPreset({ name: "보존", build: build() });
    if (!saved.ok) throw new Error("fixture save failed");
    const payloads = [
      { schemaVersion: 1, presets: [saved.preset, { ...saved.preset, id: absentPresetId, build: {} }], favoriteWeaponIds: [] },
      { schemaVersion: 1, presets: [saved.preset, saved.preset], favoriteWeaponIds: [] },
      { schemaVersion: 1, presets: [saved.preset], favoriteWeaponIds: ["invalid"] },
      { schemaVersion: 1, presets: [{ ...saved.preset, updatedAt: "invalid" }], favoriteWeaponIds: [] },
    ];
    for (const payload of payloads) {
      const raw = JSON.stringify(payload);
      localStorage.setItem(MODDING_LIBRARY_STORAGE_KEY, raw);
      expect(loadModdingLibrary().ok).toBe(false);
      expect(saveNamedWeaponPreset({ name: "새 항목", build: build() })).toEqual({ ok: false, reason: "storage" });
      expect(localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)).toBe(raw);
    }
  });

  it("reports unavailable storage and quota failures without claiming a saved mutation", () => {
    expect(loadModdingLibrary(null).ok).toBe(false);
    expect(saveNamedWeaponPreset({ name: "차단", build: build() }, null)).toEqual({ ok: false, reason: "storage" });
    expect(setFavoriteWeapon(weaponA, true, null)).toEqual({ ok: false, reason: "storage" });
    const saved = saveNamedWeaponPreset({ name: "보존", build: build() });
    if (!saved.ok) throw new Error("fixture save failed");
    const before = localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    expect(saveNamedWeaponPreset({ name: "실패", build: build() })).toEqual({ ok: false, reason: "storage" });
    expect(removeNamedWeaponPreset(saved.preset.id)).toEqual({ ok: false, reason: "storage" });
    expect(setFavoriteWeapon(weaponA, true)).toEqual({ ok: false, reason: "storage" });
    expect(localStorage.getItem(MODDING_LIBRARY_STORAGE_KEY)).toBe(before);
  });

  it("never writes when the existing library cannot be read", () => {
    const write = vi.spyOn(Storage.prototype, "setItem");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    expect(loadModdingLibrary().ok).toBe(false);
    expect(saveNamedWeaponPreset({ name: "읽기 실패", build: build() })).toEqual({ ok: false, reason: "storage" });
    expect(removeNamedWeaponPreset(absentPresetId)).toEqual({ ok: false, reason: "storage" });
    expect(setFavoriteWeapon(weaponA, true)).toEqual({ ok: false, reason: "storage" });
    expect(write).not.toHaveBeenCalled();
  });
});
