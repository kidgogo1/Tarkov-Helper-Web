import type { ItemData, TarkovData } from "../types/data";
import type { KeyMapMarker } from "../types/state";

export function isKeyItem(item: ItemData): boolean {
  const values = [item.category, ...(item.categories ?? [])]
    .filter(Boolean)
    .map((value) => value!.toLocaleLowerCase("en-US"));
  return values.some((value) => value.includes("key"));
}

export function keyItemsForMap(
  data: Pick<TarkovData, "items">,
  itemIds: readonly string[],
): ItemData[] {
  const allowed = new Set(itemIds);
  return data.items
    .filter((item) => allowed.has(item.id) && isKeyItem(item))
    .sort((left, right) =>
      (left.shortNameEn || left.nameEn || left.name).localeCompare(
        right.shortNameEn || right.nameEn || right.name,
        "en",
      ),
    );
}

export function keyItemLabel(item: ItemData): string {
  return item.shortNameKo || item.shortNameEn || item.nameKo || item.nameEn || item.name;
}

export function keyItemFullName(item: ItemData): string {
  return item.nameKo || item.nameEn || item.name;
}

export function keyMarkerIsVisible(
  marker: KeyMapMarker,
  selectedFloor: string | undefined,
  hiddenItemIds: ReadonlySet<string>,
): boolean {
  return (
    !hiddenItemIds.has(marker.itemId) &&
    (!selectedFloor || !marker.floorId || marker.floorId === selectedFloor)
  );
}
