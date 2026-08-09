import type { ProfileType } from "../types/data";
import type { ItemPriceCatalogItem, ItemPriceSnapshot } from "../types/prices";

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function relevance(item: ItemPriceCatalogItem, needle: string): number {
  const values = [
    item.shortNameKo,
    item.shortNameEn,
    item.nameKo,
    item.nameEn,
    item.normalizedName,
  ].map(normalize);
  if (values.some((value) => value === needle)) return 0;
  if (values.some((value) => value.startsWith(needle))) return 1;
  return 2;
}

export function searchPriceCatalog(
  items: readonly ItemPriceCatalogItem[],
  searchText: string,
  limit = 40,
): ItemPriceCatalogItem[] {
  const needle = normalize(searchText);
  if (!needle || !Number.isSafeInteger(limit) || limit < 1) return [];
  return items
    .filter((item) => [
      item.nameKo,
      item.nameEn,
      item.shortNameKo,
      item.shortNameEn,
      item.normalizedName,
    ].some((value) => normalize(value).includes(needle)))
    .sort((left, right) =>
      relevance(left, needle) - relevance(right, needle) ||
      left.nameKo.localeCompare(right.nameKo, "ko"),
    )
    .slice(0, limit);
}

export function selectCatalogSnapshot(
  item: ItemPriceCatalogItem,
  profile: ProfileType,
): ItemPriceSnapshot | undefined {
  return item.prices[profile];
}

export function formatRoubles(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `₽${value.toLocaleString("en-US")}`;
}

export function formatPriceTime(value: string | null | undefined): string {
  if (!value) return "시간 정보 없음";
  const date = new Date(value);
  return Number.isFinite(date.valueOf())
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(date)
    : "시간 정보 없음";
}
