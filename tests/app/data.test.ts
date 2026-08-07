import { afterEach, describe, expect, it, vi } from "vitest";

import { loadTarkovData } from "../../src/app/data";

describe("loadTarkovData", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a validated bundled dataset", async () => {
    const payload = {
      meta: {
        originalCommit: "ef71936",
        modifiedCommit: "77ee734",
        exportedAt: "2026-08-07T00:00:00Z",
        counts: { quests: 1, items: 1, hideoutStations: 1, maps: 1, mapMarkers: 1 },
      },
      quests: [{}],
      items: [{}],
      hideoutStations: [{}],
      traders: [],
      mapConfigs: [{}],
      mapMarkers: [{}],
      mapFloorLocations: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => payload }));

    await expect(loadTarkovData()).resolves.toBe(payload);
  });

  it("rejects a response whose counts do not match its arrays", async () => {
    const payload = {
      meta: {
        originalCommit: "ef71936",
        modifiedCommit: "77ee734",
        exportedAt: "2026-08-07T00:00:00Z",
        counts: { quests: 2, items: 0, hideoutStations: 0, maps: 0, mapMarkers: 0 },
      },
      quests: [{}],
      items: [],
      hideoutStations: [],
      traders: [],
      mapConfigs: [],
      mapMarkers: [],
      mapFloorLocations: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => payload }));

    await expect(loadTarkovData()).rejects.toThrow("퀘스트 개수");
  });

  it("reports an HTTP loading failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

    await expect(loadTarkovData()).rejects.toThrow("404");
  });
});

