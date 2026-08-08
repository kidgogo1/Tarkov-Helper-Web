import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it } from "vitest";

import {
  APP_STATE_STORAGE_KEY,
  APP_STATE_VERSION,
  AppStoreProvider,
  createDefaultState,
  useAppStore,
} from "../../src/app/store";
import type { CustomMapMarker } from "../../src/types/state";

function StoreWrapper({ children }: PropsWithChildren) {
  return <AppStoreProvider>{children}</AppStoreProvider>;
}

describe("AppStoreProvider", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("creates independent PVP and PVE profiles in a versioned state", () => {
    const state = createDefaultState();

    expect(state.version).toBe(APP_STATE_VERSION);
    expect(state.activeProfile).toBe("pvp");
    expect(state.profiles.pvp).toEqual({
      level: 15,
      scavRep: 1,
      dspDecodeCount: 0,
      hasEodEdition: false,
      hasUnheardEdition: false,
      prestigeLevel: 0,
      faction: null,
      questProgress: {},
      objectiveProgress: {},
      hideoutLevels: {},
      inventory: {},
      customMarkers: [],
    });
    expect(state.profiles.pve).toEqual(state.profiles.pvp);
    expect(state.profiles.pve).not.toBe(state.profiles.pvp);
    expect(state.settings.map.showQuestMarkers).toBe(true);
    expect(state.settings.map.hiddenMarkerTypes).toEqual([]);
    expect(state.settings.map).toMatchObject({
      miniMapViewMode: "playerTracking",
      miniMapWindowSize: 300,
      miniMapZoom: 1,
      miniMapKeyboardShortcutsEnabled: true,
      miniMapZoomInKey: "Alt+Plus",
      miniMapZoomOutKey: "Alt+Minus",
      miniMapOpacity: 0.8,
      miniMapPlayerMarkerScale: 1,
      miniMapOffsetX: 0,
      miniMapOffsetY: 0,
    });
  });

  it("clamps profile fields and isolates every mutation to the active profile", () => {
    const { result } = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    act(() => {
      result.current.updateProfile({
        level: 100,
        scavRep: -20,
        dspDecodeCount: 9,
        prestigeLevel: -3,
        faction: "bear",
      });
      result.current.setQuestStatus("quest-pvp", "done");
      result.current.setObjectiveProgress("objective-pvp", true);
      result.current.setHideoutLevel("workbench", 2);
      result.current.setInventory("item-pvp", { fir: 3, nonFir: 4 });
    });

    expect(result.current.profile).toMatchObject({
      level: 79,
      scavRep: -6,
      dspDecodeCount: 3,
      prestigeLevel: 0,
      faction: "bear",
      questProgress: { "quest-pvp": "done" },
      objectiveProgress: { "objective-pvp": true },
      hideoutLevels: { workbench: 2 },
      inventory: { "item-pvp": { fir: 3, nonFir: 4 } },
    });

    act(() => {
      result.current.setActiveProfile("pve");
    });

    expect(result.current.activeProfile).toBe("pve");
    expect(result.current.profile).toEqual(createDefaultState().profiles.pve);

    act(() => {
      result.current.updateProfile({
        level: -4,
        scavRep: 99,
        dspDecodeCount: -2,
        prestigeLevel: 99,
      });
      result.current.setQuestStatus("quest-pve", "failed");
    });

    expect(result.current.profile).toMatchObject({
      level: 1,
      scavRep: 6,
      dspDecodeCount: 0,
      prestigeLevel: 5,
      questProgress: { "quest-pve": "failed" },
    });

    act(() => {
      result.current.setActiveProfile("pvp");
    });

    expect(result.current.profile.questProgress).toEqual({ "quest-pvp": "done" });
    expect(result.current.profile.inventory).toEqual({
      "item-pvp": { fir: 3, nonFir: 4 },
    });
  });

  it("supports clearing progress while retaining inventory and custom markers", () => {
    const marker: CustomMapMarker = {
      id: "marker-1",
      mapKey: "customs",
      name: "테스트 마커",
      x: 100,
      y: 20,
      z: 200,
      floorId: "ground",
      color: "#d7b45a",
      size: 24,
      opacity: 0.8,
      createdAt: "2026-08-07T00:00:00.000Z",
    };
    const { result } = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    act(() => {
      result.current.setQuestStatus("quest-1", "done");
      result.current.setObjectiveProgress("objective-1", true);
      result.current.setHideoutLevel("medstation", 3);
      result.current.setInventory("item-1", { fir: 2, nonFir: 1 });
      result.current.upsertCustomMarker(marker);
    });

    expect(result.current.profile.customMarkers).toEqual([marker]);

    act(() => {
      result.current.upsertCustomMarker({ ...marker, name: "수정됨" });
      result.current.setQuestStatus("quest-1", null);
      result.current.setObjectiveProgress("objective-1", false);
      result.current.resetProgress();
    });

    expect(result.current.profile.questProgress).toEqual({});
    expect(result.current.profile.objectiveProgress).toEqual({});
    expect(result.current.profile.hideoutLevels).toEqual({});
    expect(result.current.profile.inventory).toEqual({
      "item-1": { fir: 2, nonFir: 1 },
    });
    expect(result.current.profile.customMarkers).toEqual([
      expect.objectContaining({ id: "marker-1", name: "수정됨" }),
    ]);

    act(() => {
      result.current.deleteCustomMarker("marker-1");
    });

    expect(result.current.profile.customMarkers).toEqual([]);
  });

  it("shares settings across profiles and restores all state from localStorage", async () => {
    const first = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    act(() => {
      first.result.current.updateSettings({ fontFamily: "mono", fontSize: 19 });
      first.result.current.updateMapSettings({
        lastMapKey: "woods",
        fixedView: true,
        markerSize: 31,
        hiddenMarkerTypes: ["BossSpawn"],
      });
      first.result.current.setInventory("pvp-item", { fir: 1, nonFir: 0 });
      first.result.current.setActiveProfile("pve");
      first.result.current.setInventory("pve-item", { fir: 0, nonFir: 5 });
    });

    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem(APP_STATE_STORAGE_KEY) ?? "null",
      );
      expect(saved).toMatchObject({
        version: APP_STATE_VERSION,
        activeProfile: "pve",
        settings: {
          fontFamily: "mono",
          fontSize: 19,
          map: {
            lastMapKey: "woods",
            fixedView: true,
            markerSize: 31,
            hiddenMarkerTypes: ["BossSpawn"],
          },
        },
        profiles: {
          pvp: { inventory: { "pvp-item": { fir: 1, nonFir: 0 } } },
          pve: { inventory: { "pve-item": { fir: 0, nonFir: 5 } } },
        },
      });
    });

    first.unmount();
    const restored = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    expect(restored.result.current.activeProfile).toBe("pve");
    expect(restored.result.current.profile.inventory).toEqual({
      "pve-item": { fir: 0, nonFir: 5 },
    });
    expect(restored.result.current.state.profiles.pvp.inventory).toEqual({
      "pvp-item": { fir: 1, nonFir: 0 },
    });
    expect(restored.result.current.settings).toMatchObject({
      fontFamily: "mono",
      fontSize: 19,
      map: {
        lastMapKey: "woods",
        fixedView: true,
        markerSize: 31,
        hiddenMarkerTypes: ["BossSpawn"],
      },
    });
  });

  it("sanitizes, deduplicates, and shares hidden marker types across profiles", () => {
    const defaults = createDefaultState();
    window.localStorage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify({
        ...defaults,
        settings: {
          ...defaults.settings,
          map: {
            ...defaults.settings.map,
            hiddenMarkerTypes: [
              " BossSpawn ",
              "",
              "BossSpawn",
              42,
              "ScavSpawn",
              "x".repeat(81),
            ],
          },
        },
      }),
    );

    const { result } = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    expect(result.current.settings.map.hiddenMarkerTypes).toEqual([
      "BossSpawn",
      "ScavSpawn",
    ]);

    act(() => {
      result.current.setActiveProfile("pve");
      result.current.updateMapSettings({
        hiddenMarkerTypes: ["PmcSpawn", " PmcSpawn ", "CultistSpawn"],
      });
    });

    expect(result.current.settings.map.hiddenMarkerTypes).toEqual([
      "PmcSpawn",
      "CultistSpawn",
    ]);
    expect(result.current.state.settings.map.hiddenMarkerTypes).toEqual([
      "PmcSpawn",
      "CultistSpawn",
    ]);
  });

  it("falls back safely when persisted data has an unsupported version", () => {
    window.localStorage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify({ version: 999, activeProfile: "pve" }),
    );

    const { result } = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    expect(result.current.state).toEqual(createDefaultState());
  });

  it("repairs partial same-version state with nested defaults", () => {
    window.localStorage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify({
        version: APP_STATE_VERSION,
        activeProfile: "pve",
        profiles: { pvp: { level: 42 }, pve: {} },
        settings: {},
      }),
    );

    const { result } = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    expect(result.current.activeProfile).toBe("pve");
    expect(result.current.profile).toEqual(createDefaultState().profiles.pve);
    expect(result.current.state.profiles.pvp.level).toBe(42);
    expect(result.current.settings).toEqual(createDefaultState().settings);
  });

  it("clamps shared font and map display values to the desktop ranges", () => {
    const { result } = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    act(() => {
      result.current.updateSettings({ fontSize: 99 });
      result.current.updateMapSettings({
        markerSize: -1,
        playerMarkerSize: 80,
        questNameSize: 4,
        extractNameSize: 90,
        customMarkerOpacity: -2,
        miniMapZoom: 99,
        miniMapWindowSize: 2_000,
        miniMapOpacity: -2,
        miniMapPlayerMarkerScale: 0.1,
        miniMapOffsetX: 50_000,
        miniMapOffsetY: -50_000,
      });
    });

    expect(result.current.settings).toMatchObject({
      fontSize: 28,
      map: {
        markerSize: 12,
        playerMarkerSize: 32,
        questNameSize: 12,
        extractNameSize: 32,
        customMarkerOpacity: 0,
        miniMapZoom: 15,
        miniMapWindowSize: 1000,
        miniMapOpacity: 0.1,
        miniMapPlayerMarkerScale: 0.5,
        miniMapOffsetX: 10_000,
        miniMapOffsetY: -10_000,
      },
    });
  });

  it("migrates partial v1 map settings and sanitizes persisted minimap values", () => {
    const defaults = createDefaultState();
    window.localStorage.setItem(
      APP_STATE_STORAGE_KEY,
      JSON.stringify({
        ...defaults,
        settings: {
          ...defaults.settings,
          map: {
            lastMapKey: "Customs",
            miniMapViewMode: "invalid",
            miniMapWindowSize: 10,
            miniMapZoom: 0,
            miniMapKeyboardShortcutsEnabled: false,
            miniMapZoomInKey: "Not A Shortcut",
            miniMapZoomOutKey: "Ctrl+Shift+M",
            miniMapOpacity: 7,
            miniMapPlayerMarkerScale: 9,
            miniMapOffsetX: 20_000,
            miniMapOffsetY: -20_000,
          },
        },
      }),
    );

    const { result } = renderHook(() => useAppStore(), { wrapper: StoreWrapper });

    expect(result.current.settings.map).toMatchObject({
      lastMapKey: "Customs",
      miniMapViewMode: "playerTracking",
      miniMapWindowSize: 240,
      miniMapZoom: 0.01,
      miniMapKeyboardShortcutsEnabled: false,
      miniMapZoomInKey: "Alt+Plus",
      miniMapZoomOutKey: "Ctrl+Shift+M",
      miniMapOpacity: 1,
      miniMapPlayerMarkerScale: 3,
      miniMapOffsetX: 10_000,
      miniMapOffsetY: -10_000,
      showQuestMarkers: true,
    });
  });

  it("requires consumers to be rendered inside the provider", () => {
    expect(() => renderHook(() => useAppStore())).toThrow(
      "useAppStore must be used within AppStoreProvider",
    );
  });
});
