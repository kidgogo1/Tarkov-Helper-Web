import type { AppTab } from "./AppShell";

const VALID_TABS: readonly AppTab[] = [
  "quests",
  "hideout",
  "items",
  "collector",
  "prices",
  "map",
];

export type AppNavigationIntent = "focus" | "selection";

export type AppRouteLocation =
  | { tab: "quests"; questId?: string }
  | { tab: "hideout"; stationId?: string; stationLevel?: number }
  | { tab: "items"; itemId?: string }
  | { tab: "collector" }
  | { tab: "prices" }
  | { tab: "map" };

export type AppRoute = AppRouteLocation & {
  navigationIntent: AppNavigationIntent;
};

interface AppHistoryState {
  schemaVersion: 1;
  navigationIntent: AppNavigationIntent;
  route: string;
}

function safeIdentifier(value: string | null): string | undefined {
  const normalized = value?.normalize("NFKC").trim();
  if (!normalized || Array.from(normalized).length > 256) return undefined;
  for (const character of normalized) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f || codePoint === 0xfffd) {
      return undefined;
    }
  }
  return normalized;
}

function historyIntent(
  value: unknown,
  location: AppRouteLocation,
): AppNavigationIntent | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<AppHistoryState>;
  if (candidate.schemaVersion !== 1) return undefined;
  if (candidate.route !== serializeAppRoute(location)) return undefined;
  return candidate.navigationIntent === "focus" || candidate.navigationIntent === "selection"
    ? candidate.navigationIntent
    : undefined;
}

function withIntent(
  location: AppRouteLocation,
  historyState: unknown,
): AppRoute {
  const recordedIntent = historyIntent(historyState, location);
  const hasTarget =
    (location.tab === "quests" && Boolean(location.questId)) ||
    (location.tab === "items" && Boolean(location.itemId)) ||
    (location.tab === "hideout" && Boolean(location.stationId));
  return {
    ...location,
    navigationIntent: recordedIntent ?? (hasTarget ? "focus" : "selection"),
  };
}

export function parseAppRoute(hash: string, historyState?: unknown): AppRoute {
  const routeText = hash.replace(/^#\/?/, "");
  const [path = "", query = ""] = routeText.split("?", 2);
  const tab = VALID_TABS.includes(path as AppTab) ? (path as AppTab) : "quests";
  const parameters = new URLSearchParams(hash.length <= 2_048 ? query : "");

  if (tab === "quests") {
    return withIntent(
      { tab, questId: safeIdentifier(parameters.get("quest")) },
      historyState,
    );
  }
  if (tab === "items") {
    return withIntent(
      { tab, itemId: safeIdentifier(parameters.get("item")) },
      historyState,
    );
  }
  if (tab === "hideout") {
    const stationId = safeIdentifier(parameters.get("station"));
    const rawLevel = parameters.get("level");
    const parsedLevel = rawLevel && /^\d+$/.test(rawLevel) ? Number(rawLevel) : undefined;
    const stationLevel = parsedLevel && parsedLevel >= 1 && parsedLevel <= 99
      ? parsedLevel
      : undefined;
    return withIntent(
      { tab, stationId, stationLevel: stationId ? stationLevel : undefined },
      historyState,
    );
  }
  return withIntent({ tab }, historyState);
}

export function serializeAppRoute(route: AppRouteLocation): string {
  const parameters = new URLSearchParams();
  if (route.tab === "quests" && route.questId) parameters.set("quest", route.questId);
  if (route.tab === "items" && route.itemId) parameters.set("item", route.itemId);
  if (route.tab === "hideout" && route.stationId) {
    parameters.set("station", route.stationId);
    if (route.stationLevel) parameters.set("level", String(route.stationLevel));
  }
  const query = parameters.toString();
  return `#/${route.tab}${query ? `?${query}` : ""}`;
}

export function appRouteKey(route: AppRoute): string {
  return `${serializeAppRoute(route)}|${route.navigationIntent}`;
}

export function appRouteHistoryState(route: AppRoute): AppHistoryState {
  return {
    schemaVersion: 1,
    navigationIntent: route.navigationIntent,
    route: serializeAppRoute(route),
  };
}
