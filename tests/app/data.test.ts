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
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadTarkovData()).rejects.toThrow("404");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retries a transient core-data failure before showing the startup error", async () => {
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
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("temporary connection reset"))
      .mockResolvedValueOnce({ ok: true, json: () => payload })
      .mockResolvedValueOnce({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadTarkovData()).resolves.toBe(payload);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects quest item requirements without a resolvable item ID", async () => {
    const payload = {
      meta: {
        originalCommit: "original",
        modifiedCommit: "modified",
        exportedAt: "2026-08-07T00:00:00Z",
        counts: { quests: 1, items: 1, hideoutStations: 0, maps: 0, mapMarkers: 0 },
      },
      quests: [{ requiredItems: [{ itemId: "" }] }],
      items: [{ id: "known-item" }],
      hideoutStations: [],
      traders: [],
      mapConfigs: [],
      mapMarkers: [],
      mapFloorLocations: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => payload }));

    await expect(loadTarkovData()).rejects.toThrow("아이템 참조");
  });
  it("rejects reward items without a resolvable item ID", async () => {
    const payload = {
      meta: {
        originalCommit: "original",
        modifiedCommit: "modified",
        exportedAt: "2026-08-07T00:00:00Z",
        counts: { quests: 1, items: 1, hideoutStations: 0, maps: 0, mapMarkers: 0 },
      },
      quests: [{ requiredItems: [], rewardItems: [{ itemId: "missing-item" }] }],
      items: [{ id: "known-item" }],
      hideoutStations: [],
      traders: [],
      mapConfigs: [],
      mapMarkers: [],
      mapFloorLocations: [],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => payload }));

    await expect(loadTarkovData()).rejects.toThrow("보상 아이템 참조");
  });
});
