import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";

import type { ProfileType } from "../types/data";
import type {
  CustomMapMarker,
  InventoryAmount,
  MapDisplaySettings,
  PersistedAppState,
  ProfileState,
  SavedQuestStatus,
  SharedSettings,
} from "../types/state";

export const APP_STATE_VERSION = 1 as const;
export const APP_STATE_STORAGE_KEY = "tarkov-helper-web:state";

type ProfileFields = Pick<
  ProfileState,
  | "level"
  | "scavRep"
  | "dspDecodeCount"
  | "hasEodEdition"
  | "hasUnheardEdition"
  | "prestigeLevel"
  | "faction"
>;

export type ProfilePatch = Partial<ProfileFields>;
export type SettingsPatch = Partial<Omit<SharedSettings, "map">> & {
  map?: Partial<MapDisplaySettings>;
};

export interface AppStoreValue {
  state: PersistedAppState;
  activeProfile: ProfileType;
  profile: ProfileState;
  settings: SharedSettings;
  setActiveProfile: (type: ProfileType) => void;
  updateProfile: (patch: ProfilePatch) => void;
  setQuestStatus: (id: string, status: SavedQuestStatus | null) => void;
  setObjectiveProgress: (id: string, completed: boolean) => void;
  setHideoutLevel: (id: string, level: number) => void;
  setInventory: (id: string, amount: InventoryAmount) => void;
  upsertCustomMarker: (marker: CustomMapMarker) => void;
  deleteCustomMarker: (id: string) => void;
  resetProgress: () => void;
  updateSettings: (patch: SettingsPatch) => void;
  updateMapSettings: (patch: Partial<MapDisplaySettings>) => void;
}

function createDefaultProfile(): ProfileState {
  return {
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
  };
}

function createDefaultMapSettings(): MapDisplaySettings {
  return {
    lastMapKey: "",
    fixedView: false,
    showQuestMarkers: true,
    showExtractMarkers: true,
    showPmcExtracts: true,
    showScavExtracts: true,
    showTransits: true,
    showCompletedObjectives: true,
    hiddenMarkerTypes: [],
    questMarkerStyle: "iconWithName",
    markerSize: 18,
    questNameSize: 20,
    playerMarkerSize: 18,
    extractNameSize: 16,
    customMarkerOpacity: 1,
    miniMapViewMode: "playerTracking",
    miniMapZoom: 1,
    miniMapOpacity: 0.8,
    miniMapPlayerMarkerScale: 1,
    miniMapOffsetX: 0,
    miniMapOffsetY: 0,
  };
}

// Store helpers intentionally live beside the provider as its public contract.
// eslint-disable-next-line react-refresh/only-export-components
export function createDefaultState(): PersistedAppState {
  return {
    version: APP_STATE_VERSION,
    activeProfile: "pvp",
    profiles: {
      pvp: createDefaultProfile(),
      pve: createDefaultProfile(),
    },
    settings: {
      fontFamily: "system",
      fontSize: 18,
      map: createDefaultMapSettings(),
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.round(clamp(value, minimum, maximum));
}

function sanitizeHiddenMarkerTypes(
  value: unknown,
  fallback: readonly string[],
): string[] {
  if (!Array.isArray(value)) return [...fallback];

  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const markerType = candidate.trim();
    if (!markerType || markerType.length > 80 || seen.has(markerType)) continue;
    seen.add(markerType);
    result.push(markerType);
    if (result.length === 100) break;
  }
  return result;
}

function normalizeMapSettings(
  current: MapDisplaySettings,
  patch: Partial<MapDisplaySettings>,
): MapDisplaySettings {
  const next = { ...current, ...patch };
  return {
    ...next,
    hiddenMarkerTypes: sanitizeHiddenMarkerTypes(
      next.hiddenMarkerTypes,
      current.hiddenMarkerTypes,
    ),
    markerSize: Number.isFinite(next.markerSize)
      ? clampInteger(next.markerSize, 12, 32)
      : current.markerSize,
    playerMarkerSize: Number.isFinite(next.playerMarkerSize)
      ? clampInteger(next.playerMarkerSize, 12, 32)
      : current.playerMarkerSize,
    questNameSize: Number.isFinite(next.questNameSize)
      ? clamp(next.questNameSize, 12, 32)
      : current.questNameSize,
    extractNameSize: Number.isFinite(next.extractNameSize)
      ? clamp(next.extractNameSize, 10, 32)
      : current.extractNameSize,
    customMarkerOpacity: Number.isFinite(next.customMarkerOpacity)
      ? clamp(next.customMarkerOpacity, 0, 1)
      : current.customMarkerOpacity,
    miniMapViewMode:
      next.miniMapViewMode === "fixed" || next.miniMapViewMode === "playerTracking"
        ? next.miniMapViewMode
        : current.miniMapViewMode,
    miniMapZoom: Number.isFinite(next.miniMapZoom)
      ? clamp(next.miniMapZoom, 0.01, 4)
      : current.miniMapZoom,
    miniMapOpacity: Number.isFinite(next.miniMapOpacity)
      ? clamp(next.miniMapOpacity, 0.1, 1)
      : current.miniMapOpacity,
    miniMapPlayerMarkerScale: Number.isFinite(next.miniMapPlayerMarkerScale)
      ? clamp(next.miniMapPlayerMarkerScale, 0.5, 3)
      : current.miniMapPlayerMarkerScale,
    miniMapOffsetX: Number.isFinite(next.miniMapOffsetX)
      ? clamp(next.miniMapOffsetX, -10_000, 10_000)
      : current.miniMapOffsetX,
    miniMapOffsetY: Number.isFinite(next.miniMapOffsetY)
      ? clamp(next.miniMapOffsetY, -10_000, 10_000)
      : current.miniMapOffsetY,
  };
}

function updateProfileFields(
  current: ProfileState,
  patch: ProfilePatch,
): ProfileState {
  const next = { ...current, ...patch };

  return {
    ...next,
    level: Number.isFinite(next.level)
      ? clampInteger(next.level, 1, 79)
      : current.level,
    scavRep: Number.isFinite(next.scavRep)
      ? Math.round(clamp(next.scavRep, -6, 6) * 10) / 10
      : current.scavRep,
    dspDecodeCount: Number.isFinite(next.dspDecodeCount)
      ? clampInteger(next.dspDecodeCount, 0, 3)
      : current.dspDecodeCount,
    prestigeLevel: Number.isFinite(next.prestigeLevel)
      ? clampInteger(next.prestigeLevel, 0, 5)
      : current.prestigeLevel,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeProfile(value: unknown): ProfileState {
  const defaults = createDefaultProfile();
  if (!isRecord(value)) return defaults;

  const fields: ProfilePatch = {};
  for (const key of ["level", "scavRep", "dspDecodeCount", "prestigeLevel"] as const) {
    if (typeof value[key] === "number") fields[key] = value[key];
  }
  if (typeof value.hasEodEdition === "boolean") fields.hasEodEdition = value.hasEodEdition;
  if (typeof value.hasUnheardEdition === "boolean") {
    fields.hasUnheardEdition = value.hasUnheardEdition;
  }
  if (value.faction === null || value.faction === "bear" || value.faction === "usec") {
    fields.faction = value.faction;
  }

  const questProgress: Record<string, SavedQuestStatus> = {};
  if (isRecord(value.questProgress)) {
    for (const [id, status] of Object.entries(value.questProgress)) {
      if (status === "done" || status === "failed") questProgress[id] = status;
    }
  }

  const objectiveProgress: Record<string, boolean> = {};
  if (isRecord(value.objectiveProgress)) {
    for (const [id, completed] of Object.entries(value.objectiveProgress)) {
      if (typeof completed === "boolean") objectiveProgress[id] = completed;
    }
  }

  const hideoutLevels: Record<string, number> = {};
  if (isRecord(value.hideoutLevels)) {
    for (const [id, level] of Object.entries(value.hideoutLevels)) {
      if (typeof level === "number" && Number.isFinite(level)) {
        hideoutLevels[id] = Math.max(0, Math.round(level));
      }
    }
  }

  const inventory: Record<string, InventoryAmount> = {};
  if (isRecord(value.inventory)) {
    for (const [id, rawAmount] of Object.entries(value.inventory)) {
      if (!isRecord(rawAmount)) continue;
      const fir = typeof rawAmount.fir === "number" && Number.isFinite(rawAmount.fir)
        ? Math.max(0, Math.round(rawAmount.fir))
        : 0;
      const nonFir = typeof rawAmount.nonFir === "number" && Number.isFinite(rawAmount.nonFir)
        ? Math.max(0, Math.round(rawAmount.nonFir))
        : 0;
      inventory[id] = { fir, nonFir };
    }
  }

  const customMarkers = Array.isArray(value.customMarkers)
    ? value.customMarkers.flatMap((candidate): CustomMapMarker[] => {
        if (!isRecord(candidate)) return [];
        const stringFields = ["id", "mapKey", "name", "color", "createdAt"] as const;
        const numberFields = ["x", "y", "z", "size", "opacity"] as const;
        if (
          !stringFields.every((key) => typeof candidate[key] === "string") ||
          !numberFields.every(
            (key) => typeof candidate[key] === "number" && Number.isFinite(candidate[key]),
          )
        ) {
          return [];
        }
        return [{
          id: candidate.id as string,
          mapKey: candidate.mapKey as string,
          name: candidate.name as string,
          x: candidate.x as number,
          y: candidate.y as number,
          z: candidate.z as number,
          ...(typeof candidate.floorId === "string" ? { floorId: candidate.floorId } : {}),
          color: candidate.color as string,
          size: clamp(candidate.size as number, 12, 64),
          opacity: clamp(candidate.opacity as number, 0, 1),
          createdAt: candidate.createdAt as string,
        }];
      })
    : [];

  return {
    ...updateProfileFields(defaults, fields),
    questProgress,
    objectiveProgress,
    hideoutLevels,
    inventory,
    customMarkers,
  };
}

function sanitizeSettings(value: unknown): SharedSettings {
  const defaults = createDefaultState().settings;
  if (!isRecord(value)) return defaults;

  const fontFamilies: SharedSettings["fontFamily"][] = [
    "system",
    "sans",
    "serif",
    "mono",
    "uploaded",
  ];
  const fontFamily = fontFamilies.includes(value.fontFamily as SharedSettings["fontFamily"])
    ? value.fontFamily as SharedSettings["fontFamily"]
    : defaults.fontFamily;
  const fontSize = typeof value.fontSize === "number" && Number.isFinite(value.fontSize)
    ? clampInteger(value.fontSize, 10, 28)
    : defaults.fontSize;

  const rawMap = isRecord(value.map) ? value.map : {};
  const mapPatch: Partial<MapDisplaySettings> = {};
  for (const key of ["lastMapKey"] as const) {
    if (typeof rawMap[key] === "string") mapPatch[key] = rawMap[key];
  }
  if (Array.isArray(rawMap.hiddenMarkerTypes)) {
    mapPatch.hiddenMarkerTypes = sanitizeHiddenMarkerTypes(
      rawMap.hiddenMarkerTypes,
      defaults.map.hiddenMarkerTypes,
    );
  }
  for (const key of [
    "fixedView",
    "showQuestMarkers",
    "showExtractMarkers",
    "showPmcExtracts",
    "showScavExtracts",
    "showTransits",
    "showCompletedObjectives",
  ] as const) {
    if (typeof rawMap[key] === "boolean") mapPatch[key] = rawMap[key];
  }
  for (const key of [
    "markerSize",
    "questNameSize",
    "playerMarkerSize",
    "extractNameSize",
    "customMarkerOpacity",
    "miniMapZoom",
    "miniMapOpacity",
    "miniMapPlayerMarkerScale",
    "miniMapOffsetX",
    "miniMapOffsetY",
  ] as const) {
    if (typeof rawMap[key] === "number") mapPatch[key] = rawMap[key];
  }
  if (
    rawMap.questMarkerStyle === "icon" ||
    rawMap.questMarkerStyle === "circle" ||
    rawMap.questMarkerStyle === "iconWithName" ||
    rawMap.questMarkerStyle === "circleWithName"
  ) {
    mapPatch.questMarkerStyle = rawMap.questMarkerStyle;
  }
  if (
    rawMap.miniMapViewMode === "fixed" ||
    rawMap.miniMapViewMode === "playerTracking"
  ) {
    mapPatch.miniMapViewMode = rawMap.miniMapViewMode;
  }

  return {
    fontFamily,
    fontSize,
    map: normalizeMapSettings(defaults.map, mapPatch),
  };
}

function readPersistedState(): PersistedAppState {
  if (typeof window === "undefined") return createDefaultState();

  try {
    const raw = window.localStorage.getItem(APP_STATE_STORAGE_KEY);
    if (!raw) return createDefaultState();

    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== APP_STATE_VERSION) {
      return createDefaultState();
    }
    const profiles = isRecord(parsed.profiles) ? parsed.profiles : {};
    return {
      version: APP_STATE_VERSION,
      activeProfile: parsed.activeProfile === "pve" ? "pve" : "pvp",
      profiles: {
        pvp: sanitizeProfile(profiles.pvp),
        pve: sanitizeProfile(profiles.pve),
      },
      settings: sanitizeSettings(parsed.settings),
    };
  } catch {
    return createDefaultState();
  }
}

const AppStoreContext = createContext<AppStoreValue | null>(null);

export function AppStoreProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<PersistedAppState>(readPersistedState);

  useEffect(() => {
    try {
      window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The app remains usable when storage is blocked or full.
    }
  }, [state]);

  const setActiveProfile = useCallback((type: ProfileType) => {
    setState((current) =>
      current.activeProfile === type
        ? current
        : { ...current, activeProfile: type },
    );
  }, []);

  const updateActiveProfile = useCallback(
    (update: (profile: ProfileState) => ProfileState) => {
      setState((current) => {
        const type = current.activeProfile;
        const profile = update(current.profiles[type]);

        return {
          ...current,
          profiles: { ...current.profiles, [type]: profile },
        };
      });
    },
    [],
  );

  const updateProfile = useCallback(
    (patch: ProfilePatch) => {
      updateActiveProfile((profile) => updateProfileFields(profile, patch));
    },
    [updateActiveProfile],
  );

  const setQuestStatus = useCallback(
    (id: string, status: SavedQuestStatus | null) => {
      updateActiveProfile((profile) => {
        const questProgress = { ...profile.questProgress };
        if (status === null) delete questProgress[id];
        else questProgress[id] = status;
        return { ...profile, questProgress };
      });
    },
    [updateActiveProfile],
  );

  const setObjectiveProgress = useCallback(
    (id: string, completed: boolean) => {
      updateActiveProfile((profile) => ({
        ...profile,
        objectiveProgress: {
          ...profile.objectiveProgress,
          [id]: completed,
        },
      }));
    },
    [updateActiveProfile],
  );

  const setHideoutLevel = useCallback(
    (id: string, level: number) => {
      updateActiveProfile((profile) => ({
        ...profile,
        hideoutLevels: {
          ...profile.hideoutLevels,
          [id]: Math.max(0, Math.round(level)),
        },
      }));
    },
    [updateActiveProfile],
  );

  const setInventory = useCallback(
    (id: string, amount: InventoryAmount) => {
      updateActiveProfile((profile) => ({
        ...profile,
        inventory: {
          ...profile.inventory,
          [id]: {
            fir: Math.max(0, Math.round(amount.fir)),
            nonFir: Math.max(0, Math.round(amount.nonFir)),
          },
        },
      }));
    },
    [updateActiveProfile],
  );

  const upsertCustomMarker = useCallback(
    (marker: CustomMapMarker) => {
      updateActiveProfile((profile) => {
        const index = profile.customMarkers.findIndex(
          (candidate) => candidate.id === marker.id,
        );
        const customMarkers = [...profile.customMarkers];
        if (index === -1) customMarkers.push({ ...marker });
        else customMarkers[index] = { ...marker };
        return { ...profile, customMarkers };
      });
    },
    [updateActiveProfile],
  );

  const deleteCustomMarker = useCallback(
    (id: string) => {
      updateActiveProfile((profile) => ({
        ...profile,
        customMarkers: profile.customMarkers.filter(
          (marker) => marker.id !== id,
        ),
      }));
    },
    [updateActiveProfile],
  );

  const resetProgress = useCallback(() => {
    updateActiveProfile((profile) => ({
      ...profile,
      questProgress: {},
      objectiveProgress: {},
      hideoutLevels: {},
    }));
  }, [updateActiveProfile]);

  const updateSettings = useCallback((patch: SettingsPatch) => {
    setState((current) => ({
      ...current,
      settings: {
        ...current.settings,
        ...patch,
        fontSize:
          patch.fontSize === undefined
            ? current.settings.fontSize
            : Number.isFinite(patch.fontSize)
              ? clampInteger(patch.fontSize, 10, 28)
              : current.settings.fontSize,
        map: patch.map
          ? normalizeMapSettings(current.settings.map, patch.map)
          : current.settings.map,
      },
    }));
  }, []);

  const updateMapSettings = useCallback(
    (patch: Partial<MapDisplaySettings>) => {
      setState((current) => ({
        ...current,
        settings: {
          ...current.settings,
          map: normalizeMapSettings(current.settings.map, patch),
        },
      }));
    },
    [],
  );

  const value = useMemo<AppStoreValue>(
    () => ({
      state,
      activeProfile: state.activeProfile,
      profile: state.profiles[state.activeProfile],
      settings: state.settings,
      setActiveProfile,
      updateProfile,
      setQuestStatus,
      setObjectiveProgress,
      setHideoutLevel,
      setInventory,
      upsertCustomMarker,
      deleteCustomMarker,
      resetProgress,
      updateSettings,
      updateMapSettings,
    }),
    [
      state,
      setActiveProfile,
      updateProfile,
      setQuestStatus,
      setObjectiveProgress,
      setHideoutLevel,
      setInventory,
      upsertCustomMarker,
      deleteCustomMarker,
      resetProgress,
      updateSettings,
      updateMapSettings,
    ],
  );

  return (
    <AppStoreContext.Provider value={value}>
      {children}
    </AppStoreContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAppStore(): AppStoreValue {
  const store = useContext(AppStoreContext);
  if (!store) {
    throw new Error("useAppStore must be used within AppStoreProvider");
  }
  return store;
}
