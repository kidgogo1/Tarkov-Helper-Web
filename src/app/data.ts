import type { TarkovData } from "../types/data";

const DATA_URL = `${import.meta.env.BASE_URL}data/tarkov-data.json`;
const QUEST_WIKI_GUIDES_URL = `${import.meta.env.BASE_URL}data/quest-wiki-guides.json`;
const CORE_FETCH_ATTEMPTS = 3;
const CORE_RETRY_DELAYS_MS = [100, 250] as const;

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

  const itemIdList = (data.items as unknown[]).flatMap((item) =>
    typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string"
      ? [(item as { id: string }).id]
      : [],
  );
  const itemIds = new Set(itemIdList);
  if (itemIds.size !== itemIdList.length) {
    throw new Error("번들 아이템 ID가 중복되었습니다.");
  }
  const questLists: Array<{ name: string; quests: unknown[] }> = [
    { name: "regular", quests: data.quests as unknown[] },
  ];
  const questCatalogs = (data as { questCatalogs?: unknown }).questCatalogs;
  if (questCatalogs !== undefined) {
    if (typeof questCatalogs !== "object" || questCatalogs === null || Array.isArray(questCatalogs)) {
      throw new Error("퀘스트 카탈로그 형식이 올바르지 않습니다.");
    }
    for (const catalogName of ["pve", "pvpSeason"] as const) {
      const catalog = (questCatalogs as Record<string, unknown>)[catalogName];
      if (catalog === undefined) continue;
      if (!Array.isArray(catalog)) {
        throw new Error(`퀘스트 카탈로그(${catalogName})가 배열이 아닙니다.`);
      }
      questLists.push({ name: catalogName, quests: catalog });
    }
  }
  const catalogCounts = data.meta.sources?.questCatalogCounts;
  if (catalogCounts) {
    for (const [name, expected] of Object.entries(catalogCounts)) {
      const catalog = questLists.find((entry) => entry.name === name);
      if (!catalog || catalog.quests.length !== expected) {
        throw new Error(`퀘스트 카탈로그(${name}) 개수가 메타 정보와 일치하지 않습니다.`);
      }
    }
  }

  const invalidReference = (requirements: unknown): boolean => {
    if (!Array.isArray(requirements)) return false;
    return requirements.some((requirement) => {
      if (typeof requirement !== "object" || requirement === null) return true;
      const { itemId, alternativeItemIds } = requirement as {
        itemId?: unknown;
        alternativeItemIds?: unknown;
      };
      if (typeof itemId !== "string" || !itemId || !itemIds.has(itemId)) {
        return true;
      }
      if (alternativeItemIds === undefined) return false;
      if (!Array.isArray(alternativeItemIds)) return true;
      return alternativeItemIds.some(
        (alternativeItemId) =>
          typeof alternativeItemId !== "string" ||
          !alternativeItemId ||
          !itemIds.has(alternativeItemId),
      );
    });
  };
  const invalidObjectiveReference = (objectives: unknown): boolean => {
    if (!Array.isArray(objectives)) return false;
    return objectives.some((objective) => {
      if (typeof objective !== "object" || objective === null) return true;
      const { itemId, questItemId, alternativeItemIds, requiredKeyGroups } = objective as {
        itemId?: unknown;
        questItemId?: unknown;
        alternativeItemIds?: unknown;
        requiredKeyGroups?: unknown;
      };
      const directIds = [itemId, questItemId].filter((id) => id !== undefined);
      if (directIds.some((id) => typeof id !== "string" || !id || !itemIds.has(id))) {
        return true;
      }
      if (alternativeItemIds !== undefined && (
        !Array.isArray(alternativeItemIds) || alternativeItemIds.some(
          (id) => typeof id !== "string" || !id || !itemIds.has(id)
        )
      )) return true;
      if (requiredKeyGroups === undefined) return false;
      return !Array.isArray(requiredKeyGroups) || requiredKeyGroups.some(
        (group) => !Array.isArray(group) || group.some(
          (id) => typeof id !== "string" || !id || !itemIds.has(id),
        ),
      );
    });
  };
  for (const { name, quests } of questLists) {
    const questIds = new Set<string>();
    const objectiveIds = new Set<string>();
    for (const quest of quests) {
      if (typeof quest !== "object" || quest === null) continue;
      const questId = (quest as { id?: unknown }).id;
      if (typeof questId === "string" && questId) {
        if (questIds.has(questId)) {
          throw new Error(`퀘스트 카탈로그(${name})에 중복 퀘스트 ID가 있습니다.`);
        }
        questIds.add(questId);
      }
      const requiredItems = (quest as { requiredItems?: unknown }).requiredItems;
      if (invalidReference(requiredItems)) {
        throw new Error("퀘스트 필수 아이템 참조가 번들 아이템 데이터와 일치하지 않습니다.");
      }
      const rewardItems = (quest as { rewardItems?: unknown }).rewardItems;
      if (invalidReference(rewardItems)) {
        throw new Error("보상 아이템 참조가 번들 아이템 데이터와 일치하지 않습니다.");
      }
      const objectives = (quest as { objectives?: unknown }).objectives;
      if (invalidObjectiveReference(objectives)) {
        throw new Error("퀘스트 목표 아이템 참조가 번들 아이템 데이터와 일치하지 않습니다.");
      }
      if (Array.isArray(objectives)) {
        for (const objective of objectives) {
          if (typeof objective !== "object" || objective === null) continue;
          const objectiveId = (objective as { id?: unknown }).id;
          if (typeof objectiveId !== "string" || !objectiveId) continue;
          if (objectiveIds.has(objectiveId)) {
            throw new Error(`퀘스트 카탈로그(${name})에 중복 목표 ID가 있습니다.`);
          }
          objectiveIds.add(objectiveId);
        }
      }
    }
  }
}

function waitForRetry(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchCoreData(signal?: AbortSignal): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CORE_FETCH_ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(DATA_URL, { signal, cache: "no-store" });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      lastError = error;
      if (attempt < CORE_FETCH_ATTEMPTS - 1) {
        await waitForRetry(signal, CORE_RETRY_DELAYS_MS[attempt] ?? 250);
      }
      continue;
    }
    if (response.ok) return response;
    const status = response.status;
    if (status < 500 && status !== 429) {
      throw new Error(`번들 데이터를 불러오지 못했습니다. (HTTP ${status})`);
    }
    lastError = new Error(`번들 데이터를 불러오지 못했습니다. (HTTP ${status})`);
    if (attempt < CORE_FETCH_ATTEMPTS - 1) {
      await waitForRetry(signal, CORE_RETRY_DELAYS_MS[attempt] ?? 250);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("번들 데이터를 불러오지 못했습니다.");
}

export async function loadTarkovData(signal?: AbortSignal): Promise<TarkovData> {
  const response = await fetchCoreData(signal);

  const payload: unknown = await response.json();
  validateTarkovData(payload);
  // The Wiki guide index is an optional enrichment. A stale/older package can
  // still open with its core data when the separate index is unavailable.
  try {
    const guideResponse = await fetch(QUEST_WIKI_GUIDES_URL, { signal });
    if (guideResponse.ok) {
      const guidePayload: unknown = await guideResponse.json();
      if (
        typeof guidePayload === "object" &&
        guidePayload !== null &&
        typeof (guidePayload as { entries?: unknown }).entries === "object" &&
        (guidePayload as { entries?: unknown }).entries !== null
      ) {
        payload.questWikiGuides = (guidePayload as {
          entries: NonNullable<TarkovData["questWikiGuides"]>;
        }).entries;
      }
    }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
  }
  return payload;
}
