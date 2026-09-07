import { afterEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_PART_CANDIDATE_FILTERS } from "../../src/features/modding/part-candidate-controls";
import {
  MAX_PART_FILTER_PRESETS,
  MAX_PART_FILTER_PRESET_NAME_LENGTH,
  PART_FILTER_PRESETS_STORAGE_KEY,
  loadPartFilterPresets,
  removePartFilterPreset,
  savePartFilterPreset,
  type PartFilterPresetSettings,
} from "../../src/services/part-filter-presets";

const absentId = "12345678-1234-4567-8123-123456789abc";

function settings(): PartFilterPresetSettings {
  return {
    filters: { ...DEFAULT_PART_CANDIDATE_FILTERS, purchaseFilters: [], effectFilters: [], featureFilters: [] },
    sortKeys: [],
  };
}

function allSettings(): PartFilterPresetSettings {
  return {
    filters: {
      query: "저반동 + 인체공학",
      availability: "auto-resolvable",
      purchaseFilters: ["trader", "flea"],
      effectFilters: ["recoil", "ergonomics", "lighter", "accuracy", "velocity"],
      featureFilters: ["subslots", "required-slots"],
      questRequirement: "not-required",
      traderId: "5a7c2eca46aef81a7ca2145d",
      maxTraderPrice: 25000.5,
      maxFleaPrice: 0,
      maxLoyaltyLevel: 4,
    },
    sortKeys: ["availability", "trader-price", "flea-price", "recoil", "ergonomics", "weight", "accuracy", "velocity", "loyalty-level", "name"],
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("part filter presets", () => {
  it("starts empty and round-trips every setting including sort priority and zero prices", () => {
    expect(loadPartFilterPresets()).toEqual({ ok: true, presets: [] });
    const input = { name: "  저반동 상점 우선  ", ...allSettings() };
    const saved = savePartFilterPreset(input);
    if (!saved.ok) throw new Error("fixture save failed");
    expect(saved.preset).toEqual({ ...allSettings(), name: "저반동 상점 우선", id: expect.any(String) });
    expect(saved.preset.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.presets).toEqual([saved.preset]);
    expect(loadPartFilterPresets()).toEqual({ ok: true, presets: [saved.preset] });
  });

  it("clones input, returned settings, and separately loaded snapshots", () => {
    const input = { name: "내 설정", ...allSettings() };
    const saved = savePartFilterPreset(input);
    if (!saved.ok) throw new Error("fixture save failed");
    input.filters.query = "변경";
    input.sortKeys.reverse();
    expect(saved.preset.filters.query).toBe(allSettings().filters.query);
    expect(saved.preset.sortKeys).toEqual(allSettings().sortKeys);
    saved.preset.filters.query = "반환값 변경";
    expect(saved.presets[0]).toMatchObject(allSettings());
    saved.presets[0].sortKeys.length = 0;
    const firstLoad = loadPartFilterPresets();
    expect(firstLoad.presets[0]).toMatchObject(allSettings());
    firstLoad.presets[0].filters.effectFilters = [];
    expect(loadPartFilterPresets().presets[0]).toMatchObject(allSettings());
  });

  it("rejects normalized duplicate names without overwriting an existing preset", () => {
    expect(savePartFilterPreset({ name: "Ｍ４ ＣＱＢ", ...settings() }).ok).toBe(true);
    const original = localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY);
    expect(savePartFilterPreset({ name: " m4 cqb ", ...allSettings() }))
      .toEqual({ ok: false, reason: "duplicate-name" });
    expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBe(original);
  });

  it("updates only an explicit existing id and rejects renaming to another preset", () => {
    const first = savePartFilterPreset({ name: "상점용", ...settings() });
    const second = savePartFilterPreset({ name: "플리용", ...settings() });
    if (!first.ok || !second.ok) throw new Error("fixture save failed");
    expect(savePartFilterPreset({ id: first.preset.id, name: "플리용", ...allSettings() }))
      .toEqual({ ok: false, reason: "duplicate-name" });
    const updated = savePartFilterPreset({ id: first.preset.id, name: "상점용", ...allSettings() });
    expect(updated).toEqual({
      ok: true,
      preset: { id: first.preset.id, name: "상점용", ...allSettings() },
      presets: [{ id: first.preset.id, name: "상점용", ...allSettings() }, second.preset],
    });
    expect(savePartFilterPreset({ id: absentId, name: "없는 설정", ...settings() }))
      .toEqual({ ok: false, reason: "not-found" });
  });

  it("rereads storage for each mutation, preserving newer presets from another tab", () => {
    const first = savePartFilterPreset({ name: "먼저 저장", ...settings() });
    if (!first.ok) throw new Error("fixture save failed");
    loadPartFilterPresets();
    const external = { id: absentId, name: "다른 탭", ...allSettings() };
    localStorage.setItem(PART_FILTER_PRESETS_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, presets: [first.preset, external] }));
    const updated = savePartFilterPreset({ id: first.preset.id, name: "이름 수정", ...settings() });
    expect(updated.ok && updated.presets[1]).toEqual(external);
    expect(removePartFilterPreset(first.preset.id)).toEqual({ ok: true, presets: [external] });
    expect(removePartFilterPreset(first.preset.id)).toEqual({ ok: false, reason: "not-found" });
    expect(removePartFilterPreset(absentId)).toEqual({ ok: true, presets: [] });
    expect(loadPartFilterPresets()).toEqual({ ok: true, presets: [] });
  });

  it("does not evict named presets at the limit but still allows explicit updates and deletion", () => {
    for (let index = 0; index < MAX_PART_FILTER_PRESETS; index += 1) {
      expect(savePartFilterPreset({ name: `설정 ${index}`, ...settings() }).ok).toBe(true);
    }
    expect(savePartFilterPreset({ name: "추가", ...settings() })).toEqual({ ok: false, reason: "limit" });
    const first = loadPartFilterPresets().presets[0];
    expect(savePartFilterPreset({ id: first.id, name: first.name, ...allSettings() }).ok).toBe(true);
    expect(removePartFilterPreset(first.id).ok).toBe(true);
    expect(savePartFilterPreset({ name: "추가", ...settings() }).ok).toBe(true);
    expect(loadPartFilterPresets().presets).toHaveLength(MAX_PART_FILTER_PRESETS);
  });

  it.each(["", "   ", "\u0000이름", "x".repeat(MAX_PART_FILTER_PRESET_NAME_LENGTH + 1)])("rejects invalid name %j", (name) => {
    expect(savePartFilterPreset({ name, ...settings() })).toEqual({ ok: false, reason: "invalid" });
    expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["unknown availability", { availability: "future" }],
    ["unknown quest requirement", { questRequirement: "future" }],
    ["unknown purchase choice", { purchaseFilters: ["barter"] }],
    ["unknown effect", { effectFilters: ["damage"] }],
    ["unknown feature", { featureFilters: ["folding"] }],
    ["non-array", { purchaseFilters: "trader" }],
    ["duplicate purchases", { purchaseFilters: ["trader", "trader"] }],
    ["duplicate effects", { effectFilters: ["recoil", "recoil"] }],
    ["duplicate features", { featureFilters: ["subslots", "subslots"] }],
    ["negative price", { maxTraderPrice: -1 }],
    ["infinite price", { maxFleaPrice: Infinity }],
    ["NaN price", { maxTraderPrice: NaN }],
    ["string price", { maxFleaPrice: "10" }],
    ["null price", { maxFleaPrice: null }],
    ["zero loyalty", { maxLoyaltyLevel: 0 }],
    ["high loyalty", { maxLoyaltyLevel: 5 }],
    ["fractional loyalty", { maxLoyaltyLevel: 1.5 }],
    ["long query", { query: "a".repeat(257) }],
    ["non-string query", { query: null }],
    ["long trader", { traderId: "a".repeat(129) }],
    ["non-string trader", { traderId: 123 }],
    ["unknown filter", { futureFilter: true }],
  ])("rejects invalid filter settings: %s", (_label, change) => {
    const input = { name: "잘못된 설정", ...settings(), filters: { ...settings().filters, ...change } };
    expect(savePartFilterPreset(input as Parameters<typeof savePartFilterPreset>[0]))
      .toEqual({ ok: false, reason: "invalid" });
    expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBeNull();
  });

  it.each([
    { sortKeys: ["damage"] },
    { sortKeys: ["name", "name"] },
    { sortKeys: null },
    { sortKeys: "name" },
  ])("rejects invalid sort priority $sortKeys", ({ sortKeys }) => {
    expect(savePartFilterPreset({ name: "정렬", ...settings(), sortKeys } as Parameters<typeof savePartFilterPreset>[0]))
      .toEqual({ ok: false, reason: "invalid" });
  });

  it("accepts boundary names, strings, prices, and loyalty levels without silently clamping", () => {
    const input = { name: "가".repeat(MAX_PART_FILTER_PRESET_NAME_LENGTH), ...settings() };
    input.filters.query = "가".repeat(256);
    input.filters.traderId = "t".repeat(128);
    input.filters.maxTraderPrice = Number.MAX_VALUE;
    input.filters.maxFleaPrice = 0;
    input.filters.maxLoyaltyLevel = 1;
    const saved = savePartFilterPreset(input);
    expect(saved.ok && saved.preset).toMatchObject(input);
  });

  it.each([
    ["corrupt JSON", "{"],
    ["empty string", ""],
    ["future schema", JSON.stringify({ schemaVersion: 2, presets: [] })],
    ["legacy schema", JSON.stringify({ schemaVersion: 0, presets: [] })],
    ["invalid collection", JSON.stringify({ schemaVersion: 1, presets: {} })],
    ["unknown document field", JSON.stringify({ schemaVersion: 1, presets: [], future: true })],
    ["oversized raw data", " ".repeat(128 * 1024 + 1)],
  ])("preserves an unreadable existing store: %s", (_label, raw) => {
    localStorage.setItem(PART_FILTER_PRESETS_STORAGE_KEY, raw);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(loadPartFilterPresets()).toEqual({ ok: false, presets: [] });
    expect(savePartFilterPreset({ name: "새 설정", ...settings() })).toEqual({ ok: false, reason: "storage" });
    expect(removePartFilterPreset(absentId)).toEqual({ ok: false, reason: "storage" });
    expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBe(raw);
    expect(write).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it.each(["invalid item", "duplicate id", "duplicate name", "too many", "unknown item field", "unknown setting field"])(
    "rejects the entire collection rather than dropping data: %s",
    (kind) => {
      const originalPreset = { id: absentId, name: "기존", ...allSettings() };
      const other = { id: "12345678-1234-4567-8123-123456789abd", name: "다른 설정", ...settings() };
      let presets: unknown[] = [originalPreset, other];
      if (kind === "invalid item") presets.push(null);
      if (kind === "duplicate id") other.id = absentId;
      if (kind === "duplicate name") other.name = " 기존 ";
      if (kind === "too many") presets = Array.from({ length: MAX_PART_FILTER_PRESETS + 1 }, (_, i) => ({
        ...originalPreset, id: `12345678-1234-4567-8123-${i.toString(16).padStart(12, "0")}`, name: `설정 ${i}`,
      }));
      if (kind === "unknown item field") presets[1] = { ...other, future: true };
      if (kind === "unknown setting field") presets[1] = { ...other, filters: { ...other.filters, future: true } };
      const raw = JSON.stringify({ schemaVersion: 1, presets });
      localStorage.setItem(PART_FILTER_PRESETS_STORAGE_KEY, raw);
      expect(loadPartFilterPresets()).toEqual({ ok: false, presets: [] });
      expect(savePartFilterPreset({ name: "새 설정", ...settings() })).toEqual({ ok: false, reason: "storage" });
      expect(removePartFilterPreset(absentId)).toEqual({ ok: false, reason: "storage" });
      expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBe(raw);
    },
  );

  it("rejects malformed identifiers and malformed input without throwing", () => {
    expect(savePartFilterPreset({ id: "bad-id", name: "내 설정", ...settings() })).toEqual({ ok: false, reason: "invalid" });
    expect(removePartFilterPreset("bad-id")).toEqual({ ok: false, reason: "invalid" });
    expect(savePartFilterPreset(null as unknown as Parameters<typeof savePartFilterPreset>[0])).toEqual({ ok: false, reason: "invalid" });
    const input = { name: "설정", ...settings() };
    Object.defineProperty(input, "filters", { get: () => { throw new Error("unreadable"); } });
    expect(savePartFilterPreset(input)).toEqual({ ok: false, reason: "invalid" });
  });

  it("fails closed when storage is unavailable or cannot be read", () => {
    expect(loadPartFilterPresets(null)).toEqual({ ok: false, presets: [] });
    expect(savePartFilterPreset({ name: "설정", ...settings() }, null)).toEqual({ ok: false, reason: "storage" });
    expect(removePartFilterPreset(absentId, null)).toEqual({ ok: false, reason: "storage" });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadPartFilterPresets()).toEqual({ ok: false, presets: [] });
    expect(savePartFilterPreset({ name: "설정", ...settings() })).toEqual({ ok: false, reason: "storage" });
  });

  it("handles a blocked global storage accessor without throwing", () => {
    vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => { throw new Error("blocked"); });
    expect(loadPartFilterPresets()).toEqual({ ok: false, presets: [] });
    expect(savePartFilterPreset({ name: "설정", ...settings() })).toEqual({ ok: false, reason: "storage" });
  });

  it("preserves existing data if writes fail due to quota or denied storage", () => {
    const saved = savePartFilterPreset({ name: "기존", ...settings() });
    if (!saved.ok) throw new Error("fixture save failed");
    const raw = localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Quota", "QuotaExceededError"); });
    expect(savePartFilterPreset({ id: saved.preset.id, name: "수정", ...allSettings() })).toEqual({ ok: false, reason: "storage" });
    expect(removePartFilterPreset(saved.preset.id)).toEqual({ ok: false, reason: "storage" });
    expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBe(raw);
  });

  it("rejects random id generation failure and collisions without overwriting data", () => {
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(absentId);
    expect(savePartFilterPreset({ name: "첫 설정", ...settings() }).ok).toBe(true);
    const raw = localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY);
    expect(savePartFilterPreset({ name: "다른 설정", ...settings() })).toEqual({ ok: false, reason: "storage" });
    expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBe(raw);
    vi.mocked(globalThis.crypto.randomUUID).mockImplementation(() => { throw new Error("no entropy"); });
    expect(savePartFilterPreset({ name: "다른 설정", ...settings() })).toEqual({ ok: false, reason: "storage" });
  });

  it("returns independent plain-data snapshots without requiring structuredClone", () => {
    vi.stubGlobal("structuredClone", undefined);
    const saved = savePartFilterPreset({ name: "내 설정", ...allSettings() });
    expect(saved.ok && saved.preset).toMatchObject(allSettings());
  });
});
