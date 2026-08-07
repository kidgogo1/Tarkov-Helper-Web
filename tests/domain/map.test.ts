import { describe, expect, it } from "vitest";

import type { MapConfig, MapFloorLocation } from "../../src/types/data";
import {
  applyAffineTransform,
  detectFloor,
  detectFloorByY,
  detectMapFromLogLine,
  invertAffineTransform,
  inverseMapPosition,
  parseQuestLogContent,
  parseScreenshotFilename,
  transformMapPosition,
} from "../../src/domain/map";

describe("affine map coordinates", () => {
  it("applies a six-value affine matrix and inverts it", () => {
    const transform = [2, 3, -1, 4, 10, -5];
    const screen = applyAffineTransform(transform, 2, 5);

    expect(screen).toEqual({ x: 29, y: 13 });
    expect(invertAffineTransform(transform, screen!.x, screen!.y)).toEqual({
      x: 2,
      z: 5,
    });
  });

  it("rejects incomplete or singular affine matrices", () => {
    expect(applyAffineTransform([1, 2], 1, 1)).toBeNull();
    expect(invertAffineTransform([1, 2, 2, 4, 0, 0], 1, 1)).toBeNull();
  });

  it("prefers the player-marker transform and falls back to calibrated transform", () => {
    const base: MapConfig = {
      key: "Woods",
      displayName: "Woods",
      svgFileName: "woods.svg",
      imageWidth: 1000,
      imageHeight: 1000,
      aliases: [],
      floors: [],
      calibratedTransform: [1, 0, 0, 1, 10, 10],
    };

    expect(transformMapPosition(base, 1, 2)).toEqual({ x: 11, y: 12 });
    expect(
      transformMapPosition(
        { ...base, playerMarkerTransform: [2, 0, 0, 2, 0, 0] },
        1,
        2,
      ),
    ).toEqual({ x: 2, y: 4 });
    expect(
      inverseMapPosition(
        { ...base, playerMarkerTransform: [2, 0, 0, 2, 0, 0] },
        2,
        4,
      ),
    ).toEqual({ x: 1, z: 2 });
  });

  it("uses the desktop center-offset fallback when a map has no affine data", () => {
    const config: MapConfig = {
      key: "Fallback",
      displayName: "Fallback",
      svgFileName: "fallback.svg",
      imageWidth: 1000,
      imageHeight: 800,
      aliases: [],
      floors: [],
    };

    expect(transformMapPosition(config, 5, -10)).toEqual({ x: 505, y: 390 });
    expect(inverseMapPosition(config, 505, 390)).toEqual({ x: 5, z: -10 });
  });
});

describe("screenshot coordinate parsing", () => {
  it("parses EFT position/quaternion filenames and converts Y-axis yaw with the EFT offset", () => {
    const parsed = parseScreenshotFilename(
      "2025-12-04[00-40]_95.77, 2.44, -134.02_0, 0.7071068, 0, 0.7071068_16.74 (0).png",
    );

    expect(parsed).toMatchObject({
      mapName: "Unknown",
      x: 95.77,
      y: 2.44,
      z: -134.02,
    });
    expect(parsed?.angle).toBeCloseTo(270, 5);
  });

  it("returns null for blank or malformed filenames", () => {
    expect(parseScreenshotFilename("")).toBeNull();
    expect(parseScreenshotFilename("ordinary-screenshot.png")).toBeNull();
  });
});

describe("game log parsing", () => {
  it("detects mapped map names from scene bundles and Location fields", () => {
    expect(
      detectMapFromLogLine(
        "scene preset path:maps/laboratory_preset.bundle rcid:laboratory.ScenesPreset.asset",
      ),
    ).toBe("Labs");
    expect(
      detectMapFromLogLine("TRACE-NetworkGameCreate Location: bigmap, Sid: 42"),
    ).toBe("Customs");
    expect(detectMapFromLogLine("Location: brand_new_map, Sid: 42")).toBe(
      "brand_new_map",
    );
    expect(detectMapFromLogLine("no location here")).toBeNull();
  });

  it("extracts multiline new_message quest events and ignores unrelated JSON", () => {
    const content = [
      "regular log line",
      "{",
      '  "type": "new_message",',
      '  "dialogId": "trader-1",',
      '  "message": {',
      '    "type": 10,',
      '    "templateId": "quest-start welcome",',
      '    "dt": 0',
      "  }",
      "}",
      '{"type":"new_message","message":{"type":12,"templateId":"quest-done text","dt":1}}',
      '{"type":"new_message","message":{"type":11,"templateId":"quest-fail","dt":2}}',
      '{"type":"something_else","message":{"type":12,"templateId":"ignored"}}',
    ].join("\n");

    const events = parseQuestLogContent(content, "notifications.log");

    expect(
      events.map(({ questId, eventType, traderId, sourceFile }) => ({
        questId,
        eventType,
        traderId,
        sourceFile,
      })),
    ).toEqual([
      {
        questId: "quest-start",
        eventType: "started",
        traderId: "trader-1",
        sourceFile: "notifications.log",
      },
      {
        questId: "quest-done",
        eventType: "completed",
        traderId: "",
        sourceFile: "notifications.log",
      },
      {
        questId: "quest-fail",
        eventType: "failed",
        traderId: "",
        sourceFile: "notifications.log",
      },
    ]);
    expect(events[0]?.timestamp.getTime()).toBe(0);
  });
});

describe("floor detection", () => {
  const floors: MapFloorLocation[] = [
    {
      id: "broad",
      mapKey: "Labs",
      floorId: "ground",
      minY: 0,
      maxY: 10,
      priority: 1,
    },
    {
      id: "room",
      mapKey: "Labs",
      floorId: "upper-room",
      minY: 5,
      maxY: 10,
      minX: 0,
      maxX: 5,
      minZ: 0,
      maxZ: 5,
      priority: 10,
    },
  ];

  it("uses inclusive XYZ bounds and highest priority first", () => {
    expect(detectFloor(floors, "labs", 5, 5, 5)).toBe("upper-room");
    expect(detectFloor(floors, "Labs", 6, 5, 5)).toBe("ground");
    expect(detectFloor(floors, "Unknown", 1, 5, 1)).toBeNull();
  });

  it("legacy Y-only detection ignores spatially bounded regions", () => {
    expect(detectFloorByY(floors, "Labs", 6)).toBe("ground");
  });
});
