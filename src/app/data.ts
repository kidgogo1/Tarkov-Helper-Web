import type { TarkovData } from "../types/data";

const DATA_URL = `${import.meta.env.BASE_URL}data/tarkov-data.json`;

const ARRAY_COUNTS: ReadonlyArray<
  readonly [keyof TarkovData, keyof TarkovData["meta"]["counts"], string]
> = [
  ["quests", "quests", "퀘스트"],
  ["items", "items", "아이템"],
  ["hideoutStations", "hideoutStations", "은신처 시설"],
  ["mapConfigs", "maps", "지도"],
  ["mapMarkers", "mapMarkers", "지도 마커"],
];

function validateTarkovData(value: unknown): asserts value is TarkovData {
  if (typeof value !== "object" || value === null) {
    throw new Error("번들 데이터 형식이 올바르지 않습니다.");
  }

  const data = value as Partial<TarkovData>;
  if (typeof data.meta !== "object" || data.meta === null || !data.meta.counts) {
    throw new Error("번들 데이터 메타 정보가 없습니다.");
  }

  for (const [arrayKey, countKey, label] of ARRAY_COUNTS) {
    const records = data[arrayKey];
    const expected = data.meta.counts[countKey];
    if (!Array.isArray(records)) {
      throw new Error(`${label} 데이터가 배열이 아닙니다.`);
    }
    if (records.length !== expected) {
      throw new Error(
        `${label} 개수가 일치하지 않습니다. 예상 ${expected}개, 실제 ${records.length}개`,
      );
    }
  }

  if (!Array.isArray(data.traders) || !Array.isArray(data.mapFloorLocations)) {
    throw new Error("부가 번들 데이터 형식이 올바르지 않습니다.");
  }

  const itemIds = new Set(
    (data.items as unknown[]).flatMap((item) =>
      typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
        ? [(item as { id: string }).id]
        : [],
    ),
  );
  for (const quest of data.quests as unknown[]) {
    if (typeof quest !== "object" || quest === null) continue;
    const invalidReference = (requirements: unknown): boolean => {
      if (!Array.isArray(requirements)) return false;
      return requirements.some((requirement) => {
        if (typeof requirement !== "object" || requirement === null) return true;
        const itemId = (requirement as { itemId?: unknown }).itemId;
        return typeof itemId !== "string" || !itemId || !itemIds.has(itemId);
      });
    };
    const requiredItems = (quest as { requiredItems?: unknown }).requiredItems;
    if (invalidReference(requiredItems)) {
      throw new Error("퀘스트 필수 아이템 참조가 번들 아이템 데이터와 일치하지 않습니다.");
    }
    const rewardItems = (quest as { rewardItems?: unknown }).rewardItems;
    if (invalidReference(rewardItems)) {
      throw new Error("보상 아이템 참조가 번들 아이템 데이터와 일치하지 않습니다.");
    }
  }
}

export async function loadTarkovData(signal?: AbortSignal): Promise<TarkovData> {
  const response = await fetch(DATA_URL, { signal });
  if (!response.ok) {
    throw new Error(`번들 데이터를 불러오지 못했습니다. (HTTP ${response.status})`);
  }

  const payload: unknown = await response.json();
  validateTarkovData(payload);
  return payload;
}
