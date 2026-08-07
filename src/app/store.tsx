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
    faction: "usec",
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
    showCompletedObjectives: true,
    questMarkerStyle: "iconWithName",
    markerSize: 18,
    questNameSize: 16,
    playerMarkerSize: 18,
    extractNameSize: 16,
    customMarkerOpacity: 1,
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

function readPersistedState(): PersistedAppState {
  if (typeof window === "undefined") return createDefaultState();

  try {
    const raw = window.localStorage.getItem(APP_STATE_STORAGE_KEY);
    if (!raw) return createDefaultState();

    const parsed = JSON.parse(raw) as Partial<PersistedAppState>;
    if (parsed.version !== APP_STATE_VERSION) return createDefaultState();
    if (!parsed.profiles?.pvp || !parsed.profiles.pve || !parsed.settings) {
      return createDefaultState();
    }

    return parsed as PersistedAppState;
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
        map: patch.map
          ? { ...current.settings.map, ...patch.map }
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
          map: { ...current.settings.map, ...patch },
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
