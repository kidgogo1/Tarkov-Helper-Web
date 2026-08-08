import type { ProfileType } from "./data";

export type SavedQuestStatus = "done" | "failed";
export type QuestStatus =
  | "active"
  | "locked"
  | "levelLocked"
  | "unavailable"
  | "done"
  | "failed";

export const DEFAULT_MINI_MAP_ZOOM_IN_KEY = "Alt+Plus";
export const DEFAULT_MINI_MAP_ZOOM_OUT_KEY = "Alt+Minus";

export interface InventoryAmount {
  fir: number;
  nonFir: number;
}

export interface CustomMapMarker {
  id: string;
  mapKey: string;
  name: string;
  x: number;
  y: number;
  z: number;
  floorId?: string;
  color: string;
  size: number;
  opacity: number;
  createdAt: string;
}

export interface ProfileState {
  level: number;
  scavRep: number;
  dspDecodeCount: number;
  hasEodEdition: boolean;
  hasUnheardEdition: boolean;
  prestigeLevel: number;
  faction: "bear" | "usec" | null;
  questProgress: Record<string, SavedQuestStatus>;
  objectiveProgress: Record<string, boolean>;
  hideoutLevels: Record<string, number>;
  inventory: Record<string, InventoryAmount>;
  customMarkers: CustomMapMarker[];
}

export interface MapDisplaySettings {
  lastMapKey: string;
  fixedView: boolean;
  showQuestMarkers: boolean;
  showExtractMarkers: boolean;
  showPmcExtracts: boolean;
  showScavExtracts: boolean;
  showTransits: boolean;
  showCompletedObjectives: boolean;
  hiddenMarkerTypes: string[];
  questMarkerStyle: "icon" | "circle" | "iconWithName" | "circleWithName";
  markerSize: number;
  questNameSize: number;
  playerMarkerSize: number;
  extractNameSize: number;
  customMarkerOpacity: number;
  miniMapViewMode: "fixed" | "playerTracking";
  miniMapWindowSize: number;
  miniMapZoom: number;
  /** Fraction added/removed for each configured keyboard zoom press. */
  miniMapZoomStep: number;
  miniMapKeyboardShortcutsEnabled: boolean;
  miniMapZoomInKey: string;
  miniMapZoomOutKey: string;
  miniMapOpacity: number;
  miniMapPlayerMarkerScale: number;
  miniMapOffsetX: number;
  miniMapOffsetY: number;
  miniMapShowQuestMarkers: boolean;
  miniMapShowExtractMarkers: boolean;
  miniMapShowPmcExtracts: boolean;
  miniMapShowScavExtracts: boolean;
  miniMapShowTransits: boolean;
  miniMapShowCustomMarkers: boolean;
  miniMapHiddenMarkerTypes: string[];
}

export interface SharedSettings {
  fontFamily: "system" | "sans" | "serif" | "mono" | "uploaded";
  fontSize: number;
  map: MapDisplaySettings;
}

export interface PersistedAppState {
  version: 1;
  activeProfile: ProfileType;
  profiles: Record<ProfileType, ProfileState>;
  settings: SharedSettings;
}
