import { describe, expect, it } from "vitest";

import {
  appRouteHistoryState,
  parseAppRoute,
  serializeAppRoute,
} from "../../src/app/navigation";

describe("app route contract", () => {
  it("treats a direct detail URL as a one-time focus request", () => {
    expect(parseAppRoute("#/hideout?station=workbench&level=2")).toEqual({
      tab: "hideout",
      stationId: "workbench",
      stationLevel: 2,
      navigationIntent: "focus",
    });
  });

  it("restores a bound selection intent without turning it into a focus request", () => {
    const route = parseAppRoute("#/items?item=bolts");
    const selectionRoute = { ...route, navigationIntent: "selection" as const };

    expect(
      parseAppRoute(
        serializeAppRoute(selectionRoute),
        appRouteHistoryState(selectionRoute),
      ),
    ).toEqual(selectionRoute);
  });

  it("ignores history intent that belongs to a different URL", () => {
    expect(
      parseAppRoute("#/quests?quest=target", {
        schemaVersion: 1,
        navigationIntent: "selection",
        route: "#/items?item=target",
      }),
    ).toMatchObject({
      tab: "quests",
      questId: "target",
      navigationIntent: "focus",
    });
  });

  it("drops unrelated query fields and invalid hideout levels", () => {
    const route = parseAppRoute(
      "#/hideout?station=workbench&level=0&unknown=value",
    );

    expect(route).toEqual({
      tab: "hideout",
      stationId: "workbench",
      stationLevel: undefined,
      navigationIntent: "focus",
    });
    expect(serializeAppRoute(route)).toBe("#/hideout?station=workbench");
  });

  it("parses and serializes a weapon modding deep link with a canonical Tarkov id", () => {
    const route = parseAppRoute(
      "#/modding?weapon=5447A9CD4BDC2DBD208B4567&unknown=value",
    );

    expect(route).toEqual({
      tab: "modding",
      weaponId: "5447a9cd4bdc2dbd208b4567",
      navigationIntent: "focus",
    });
    expect(serializeAppRoute({
      tab: "modding",
      weaponId: "5447a9cd4bdc2dbd208b4567",
    })).toBe(
      "#/modding?weapon=5447a9cd4bdc2dbd208b4567",
    );
  });

  it.each([
    "5447a9cd4bdc2dbd208b456",
    "5447a9cd4bdc2dbd208b45678",
    "5447a9cd4bdc2dbd208b456g",
    "%00%00%00%00%00%00%00%00%00%00%00%00",
  ])("drops an unsafe weapon id without leaving the modding page: %s", (weaponId) => {
    const route = parseAppRoute(`#/modding?weapon=${weaponId}`);

    expect(route).toEqual({
      tab: "modding",
      weaponId: undefined,
      navigationIntent: "selection",
    });
    expect(serializeAppRoute(route)).toBe("#/modding");
  });

  it("falls back safely for unknown tabs and oversized identifiers", () => {
    expect(parseAppRoute("#/unknown?item=bolts")).toEqual({
      tab: "quests",
      questId: undefined,
      navigationIntent: "selection",
    });
    expect(parseAppRoute(`#/items?item=${"a".repeat(257)}`)).toEqual({
      tab: "items",
      itemId: undefined,
      navigationIntent: "selection",
    });
    expect(parseAppRoute("#/items?item=%E0%A4%A")).toEqual({
      tab: "items",
      itemId: undefined,
      navigationIntent: "selection",
    });
    expect(parseAppRoute(`#/items?item=${"a".repeat(2_100)}`)).toEqual({
      tab: "items",
      itemId: undefined,
      navigationIntent: "selection",
    });
  });
});
