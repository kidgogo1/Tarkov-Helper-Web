import type { MapFloorLocation } from "../types/data";

/**
 * Floor bounds recovered from the Tarkov.dev/Fika GameBounds definitions.
 *
 * Those definitions store the map's screen-plane coordinates as x/y and the
 * game's vertical coordinate as z.  The web app uses x/z for the screen plane
 * and y for height, so the source bounds are intentionally transposed here.
 * These are only used when an older data pack does not contain any explicit
 * MapFloorLocations for the map.
 */
const FALLBACK_FLOOR_LOCATIONS: Readonly<Record<string, readonly MapFloorLocation[]>> = {
  Factory: [
    {
      id: "fallback-factory-basement",
      mapKey: "Factory",
      floorId: "basement",
      regionName: "Factory tunnels",
      minY: -100,
      maxY: -1,
      minX: -65,
      maxX: 77.6,
      minZ: -64.5,
      maxZ: 67.2,
      priority: 10,
    },
    {
      id: "fallback-factory-main",
      mapKey: "Factory",
      floorId: "main",
      regionName: "Factory ground floor",
      minY: -1,
      maxY: 3,
      minX: -65,
      maxX: 77.6,
      minZ: -64.5,
      maxZ: 67.2,
      priority: 20,
    },
    {
      id: "fallback-factory-level2",
      mapKey: "Factory",
      floorId: "level2",
      regionName: "Factory second floor",
      minY: 3,
      maxY: 6,
      minX: -65,
      maxX: 77.6,
      minZ: -64.5,
      maxZ: 67.2,
      priority: 30,
    },
    {
      id: "fallback-factory-level3",
      mapKey: "Factory",
      floorId: "level3",
      regionName: "Factory third floor",
      minY: 6,
      maxY: 100,
      minX: -65,
      maxX: 77.6,
      minZ: -64.5,
      maxZ: 67.2,
      priority: 40,
    },
  ],
  GroundZero: [
    {
      id: "fallback-ground-zero-garage",
      mapKey: "GroundZero",
      floorId: "basement",
      regionName: "Ground Zero garage",
      minY: -100,
      maxY: 21,
      minX: 43,
      maxX: 117,
      minZ: -100,
      maxZ: 190,
      priority: 40,
    },
    {
      id: "fallback-ground-zero-underpass",
      mapKey: "GroundZero",
      floorId: "basement",
      regionName: "Ground Zero underpass",
      minY: -100,
      maxY: 21,
      minX: 117,
      maxX: 143,
      minZ: 49,
      maxZ: 80,
      priority: 40,
    },
    {
      id: "fallback-ground-zero-main",
      mapKey: "GroundZero",
      floorId: "main",
      regionName: "Ground Zero ground floor",
      minY: -100,
      maxY: 28,
      minX: -99,
      maxX: 249,
      minZ: -124,
      maxZ: 364,
      priority: 10,
    },
    {
      id: "fallback-ground-zero-level2",
      mapKey: "GroundZero",
      floorId: "level2",
      regionName: "Ground Zero second floor",
      minY: 28,
      maxY: 32.3,
      minX: -99,
      maxX: 249,
      minZ: -124,
      maxZ: 364,
      priority: 30,
    },
    {
      id: "fallback-ground-zero-m-showroom",
      mapKey: "GroundZero",
      floorId: "level2",
      regionName: "Ground Zero M showroom",
      minY: 26,
      maxY: 31,
      minX: 91,
      maxX: 98,
      minZ: 216,
      maxZ: 228,
      priority: 25,
    },
    {
      id: "fallback-ground-zero-level3",
      mapKey: "GroundZero",
      floorId: "level3",
      regionName: "Ground Zero third floor",
      minY: 32.3,
      maxY: 100,
      minX: -99,
      maxX: 249,
      minZ: -124,
      maxZ: 364,
      priority: 40,
    },
  ],
};

export function fallbackFloorLocationsForMap(
  mapKey: string,
): readonly MapFloorLocation[] {
  return FALLBACK_FLOOR_LOCATIONS[mapKey] ?? [];
}
