const ITEM_ID_PATTERN = /^[0-9a-f]{24}$/;
const MAX_NUMBER = 2_000_000_000;
const MAX_TEXT = 400;

const TRADER_NAMES = Object.freeze({
  "54cb50c76803fa8b248b4571": "Prapor",
  "54cb57776803fa99248b456e": "Therapist",
  "579dc571d53a0658a154fbec": "Fence",
  "58330581ace78e27b8b10cee": "Skier",
  "5935c25fb3acc3127c3d8cd9": "Peacekeeper",
  "5a7c2eca46aef81a7ca2145d": "Mechanic",
  "5ac3b934156ae10c4430e83c": "Ragman",
  "5c0647fdd443bc2504c2d371": "Jaeger",
  "6617beeaa9cfa777ca915b7c": "Ref",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredRecord(value, label) {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function cleanText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const cleaned = value.trim();
  return cleaned && cleaned.length <= MAX_TEXT ? cleaned : fallback;
}

function validItemId(value) {
  return typeof value === "string" && ITEM_ID_PATTERN.test(value);
}

function boundedNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_NUMBER
    ? value
    : undefined;
}

function boundedInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_NUMBER
    ? value
    : undefined;
}

function stringArray(value, label, { ids = false } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = [];
  for (const entry of value) {
    const cleaned = cleanText(entry);
    if (!cleaned || (ids && !validItemId(cleaned))) {
      throw new Error(`${label} contains an invalid id`);
    }
    result.push(cleaned);
  }
  return [...new Set(result)].sort();
}

function sourceItems(document) {
  return requiredRecord(
    requiredRecord(requiredRecord(document, "regular document").data, "regular.data").items,
    "regular.data.items",
  );
}

function translationMap(document, label) {
  return requiredRecord(requiredRecord(document, label).data, `${label}.data`);
}

function sourceTasks(document) {
  return requiredRecord(
    requiredRecord(requiredRecord(document, "tasks document").data, "tasks.data").tasks,
    "tasks.data.tasks",
  );
}

function translation(translations, key, fallback) {
  return cleanText(typeof key === "string" ? translations[key] : undefined, fallback);
}

function propertiesOf(item) {
  return isRecord(item.properties) ? item.properties : {};
}

function propertyType(item) {
  return cleanText(propertiesOf(item).propertiesType);
}

function slotsOf(item) {
  const slots = propertiesOf(item).slots;
  if (slots === undefined || slots === null) return [];
  if (!Array.isArray(slots)) throw new Error(`slots must be an array for ${item.id}`);
  return slots;
}

function categoriesOf(item) {
  return stringArray(item.categories, `categories for ${item.id}`, { ids: true });
}

function filtersOf(rawSlot, itemId) {
  if (rawSlot.filters === undefined || rawSlot.filters === null) return {};
  return requiredRecord(rawSlot.filters, `slot filters for ${itemId}`);
}

function normalizeSlot(rawSlot, itemId, english, korean) {
  const slot = requiredRecord(rawSlot, `slot for ${itemId}`);
  if (!validItemId(slot.id)) throw new Error(`slot id is invalid for ${itemId}`);
  const filters = filtersOf(slot, itemId);
  const sourceName = cleanText(slot.name, cleanText(slot.nameId, slot.id));
  const nameEn = translation(english, sourceName, sourceName);
  const nameKo = translation(korean, sourceName, nameEn);
  return {
    id: slot.id,
    name: nameKo || nameEn || slot.id,
    required: slot.required === true,
    allowedItemIds: stringArray(filters.allowedItems, `allowedItems for ${slot.id}`, { ids: true }),
    allowedCategories: stringArray(filters.allowedCategories, `allowedCategories for ${slot.id}`, { ids: true }),
    excludedItemIds: stringArray(filters.excludedItems, `excludedItems for ${slot.id}`, { ids: true }),
    excludedCategories: stringArray(filters.excludedCategories, `excludedCategories for ${slot.id}`, { ids: true }),
  };
}

function safeAssetLink(value, itemId) {
  const text = cleanText(value, "");
  if (!text || text.length > 500) return undefined;
  try {
    const url = new URL(text);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "assets.tarkov.dev" ||
      !url.pathname.startsWith(`/${itemId}-`)
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function conflictsOf(item) {
  const itemIds = stringArray(item.conflictingItems, `conflictingItems for ${item.id}`, { ids: true });
  const slotIds = stringArray(item.conflictingSlotIds, `conflictingSlotIds for ${item.id}`, { ids: true });
  const categories = stringArray(item.conflictingCategories, `conflictingCategories for ${item.id}`, { ids: true });
  return itemIds.length || slotIds.length || categories.length
    ? {
        ...(itemIds.length ? { itemIds } : {}),
        ...(categories.length ? { categories } : {}),
        ...(slotIds.length ? { slotIds } : {}),
      }
    : undefined;
}

function statsOfPart(item) {
  const properties = propertiesOf(item);
  const weight = boundedNumber(item.weight);
  const ergonomics = boundedNumber(
    item.ergonomicsModifier ?? properties.ergonomics,
  );
  const recoil = boundedNumber(item.recoilModifier);
  const centerOfImpact = boundedNumber(properties.centerOfImpact);
  const muzzleVelocityModifier = boundedNumber(item.velocity);
  const stats = {
    ...(recoil !== undefined ? { recoilModifier: recoil } : {}),
    ...(ergonomics !== undefined ? { ergonomics } : {}),
    ...(weight !== undefined ? { weight } : {}),
    ...(centerOfImpact !== undefined ? { centerOfImpact } : {}),
    ...(muzzleVelocityModifier !== undefined && muzzleVelocityModifier !== 0
      ? { muzzleVelocityModifier }
      : {}),
  };
  return Object.keys(stats).length ? stats : undefined;
}

function baseStatsOfWeapon(item) {
  const properties = propertiesOf(item);
  const verticalRecoil = boundedNumber(properties.recoilVertical);
  const horizontalRecoil = boundedNumber(properties.recoilHorizontal);
  const ergonomics = boundedNumber(properties.ergonomics ?? item.ergonomicsModifier);
  const weight = boundedNumber(item.weight);
  if (
    verticalRecoil === undefined || horizontalRecoil === undefined ||
    ergonomics === undefined || weight === undefined
  ) throw new Error(`weapon base stats are invalid for ${item.id}`);
  const centerOfImpact = boundedNumber(properties.centerOfImpact);
  return {
    verticalRecoil,
    horizontalRecoil,
    ergonomics,
    weight,
    ...(centerOfImpact !== undefined ? { centerOfImpact } : {}),
  };
}

function traderOffersOf(item, tasks, taskEnglish, taskKorean) {
  if (item.buyFromTrader === undefined || item.buyFromTrader === null) return undefined;
  if (!Array.isArray(item.buyFromTrader)) {
    throw new Error(`buyFromTrader must be an array for ${item.id}`);
  }
  const offers = [];
  for (const rawOffer of item.buyFromTrader) {
    const offer = requiredRecord(rawOffer, `trader offer for ${item.id}`);
    if (!validItemId(offer.trader)) throw new Error(`trader id is invalid for ${item.id}`);
    const price = boundedInteger(offer.price);
    const priceRoubles = boundedInteger(offer.priceRUB);
    const currency = cleanText(offer.currency);
    const loyaltyLevel = boundedInteger(offer.minTraderLevel);
    if (
      price === undefined || priceRoubles === undefined || !currency ||
      currency.length > 12 || loyaltyLevel === undefined
    ) {
      throw new Error(`trader offer is invalid for ${item.id}`);
    }
    const questId = offer.taskUnlock === null || offer.taskUnlock === undefined
      ? undefined
      : validItemId(offer.taskUnlock) ? offer.taskUnlock : null;
    if (questId === null) throw new Error(`task unlock id is invalid for ${item.id}`);
    const task = questId ? tasks[questId] : undefined;
    const taskRecord = task === undefined ? undefined : requiredRecord(task, `task ${questId}`);
    if (taskRecord && taskRecord.id !== questId) throw new Error(`task id is invalid for ${item.id}`);
    const taskSourceName = taskRecord ? cleanText(taskRecord.name, questId) : questId;
    const taskName = questId
      ? translation(taskKorean, taskSourceName, translation(taskEnglish, taskSourceName, questId))
      : undefined;
    const minimumPlayerLevel = taskRecord ? boundedInteger(taskRecord.minPlayerLevel) : undefined;
    offers.push({
      traderId: offer.trader,
      traderName: TRADER_NAMES[offer.trader] ?? offer.trader,
      price,
      priceRoubles,
      currency,
      loyaltyLevel,
      ...(questId ? {
        questUnlock: {
          questId,
          questName: taskName,
          ...(minimumPlayerLevel !== undefined && minimumPlayerLevel > 0
            ? { minimumPlayerLevel }
            : {}),
        },
      } : {}),
    });
  }
  offers.sort((left, right) =>
    left.priceRoubles - right.priceRoubles ||
    left.loyaltyLevel - right.loyaltyLevel ||
    left.traderId.localeCompare(right.traderId),
  );
  return offers.length ? offers : undefined;
}

function fleaOf(item, generatedAt) {
  const price = boundedInteger(item.lastLowPrice);
  if (price === undefined) return undefined;
  const minimumPlayerLevel = boundedInteger(item.minLevelForFlea);
  if (item.minLevelForFlea !== undefined && item.minLevelForFlea !== null &&
      (minimumPlayerLevel === undefined || minimumPlayerLevel > 100)) {
    throw new Error(`flea minimum player level is invalid for ${item.id}`);
  }
  const lowPrice = boundedInteger(item.low24hPrice);
  const average24h = boundedInteger(item.avg24hPrice);
  const updatedSource = cleanText(item.lastScan, generatedAt);
  const updatedAt = Number.isFinite(Date.parse(updatedSource))
    ? new Date(updatedSource).toISOString()
    : generatedAt;
  return {
    price,
    currency: "RUB",
    updatedAt,
    ...(minimumPlayerLevel !== undefined && minimumPlayerLevel > 0
      ? { minimumPlayerLevel }
      : {}),
    ...(lowPrice !== undefined ? { lowPrice } : {}),
    ...(average24h !== undefined ? { average24h } : {}),
  };
}

function isPartCandidate(item) {
  if (!isRecord(item)) return false;
  const types = item.types;
  if (!Array.isArray(types)) return false;
  return !types.includes("gun") && !types.includes("preset") && !types.includes("ammo");
}

function slotAllowsItem(slot, candidate, candidateCategories) {
  if (slot.excludedItemIds.includes(candidate.id)) return false;
  if (slot.excludedCategories.some((category) => candidateCategories.includes(category))) return false;
  const hasAllow = slot.allowedItemIds.length > 0 || slot.allowedCategories.length > 0;
  return hasAllow && (slot.allowedItemIds.includes(candidate.id) ||
    slot.allowedCategories.some((category) => candidateCategories.includes(category)));
}

function directFactoryAssignments(weapon, allItems, english, korean) {
  const presetId = propertiesOf(weapon).defaultPreset;
  const preset = validItemId(presetId) ? allItems[presetId] : undefined;
  const contained = Array.isArray(preset?.containsItems)
    ? preset.containsItems
    : Array.isArray(weapon.containsItems) ? weapon.containsItems : [];
  const occurrences = new Map();
  const partInstances = [];
  for (const rawEntry of contained) {
    if (!isRecord(rawEntry) || !validItemId(rawEntry.item) || rawEntry.item === weapon.id) continue;
    const part = allItems[rawEntry.item];
    if (!part || !isPartCandidate(part)) continue;
    const count = rawEntry.count === undefined ? 1 : boundedInteger(rawEntry.count);
    if (count === undefined || count > 64) {
      throw new Error(`factory part count is invalid for ${rawEntry.item}`);
    }
    for (let index = 0; index < count; index += 1) {
      const occurrence = occurrences.get(rawEntry.item) ?? 0;
      occurrences.set(rawEntry.item, occurrence + 1);
      partInstances.push({ key: `${rawEntry.item}:${occurrence}`, itemId: rawEntry.item });
    }
  }
  if (partInstances.length > 512) throw new Error(`factory preset is too large for ${weapon.id}`);

  const rootKey = `weapon:${weapon.id}`;
  const parentInstances = [{ key: rootKey, itemId: weapon.id }, ...partInstances];
  const childrenByParent = new Map(parentInstances.map(({ key }) => [key, []]));
  const edgesByPart = new Map();
  for (const instance of partInstances) {
    const part = allItems[instance.itemId];
    const partCategories = categoriesOf(part);
    const edges = [];
    for (const parentInstance of parentInstances) {
      if (parentInstance.key === instance.key) continue;
      const parent = allItems[parentInstance.itemId];
      const slots = slotsOf(parent).map((rawSlot) =>
        normalizeSlot(rawSlot, parentInstance.itemId, english, korean),
      );
      for (const slot of slots) {
        if (slotAllowsItem(slot, part, partCategories)) {
          edges.push({
            parentKey: parentInstance.key,
            parentItemId: parentInstance.itemId,
            slotId: slot.id,
          });
        }
      }
    }
    edges.sort((left, right) =>
      left.parentKey.localeCompare(right.parentKey) || left.slotId.localeCompare(right.slotId),
    );
    if (!edges.length) {
      throw new Error(`factory part ${instance.itemId} has no compatible slot on ${weapon.id}`);
    }
    edgesByPart.set(instance.key, edges);
  }

  const orderedPartKeys = partInstances.map(({ key }) => key).sort((left, right) =>
    edgesByPart.get(left).length - edgesByPart.get(right).length || left.localeCompare(right),
  );
  const assignments = new Map();
  const occupiedSlots = new Set();
  const reachesWeapon = (partKey) => {
    const visited = new Set();
    let currentKey = partKey;
    while (currentKey !== rootKey) {
      if (visited.has(currentKey)) return false;
      visited.add(currentKey);
      const edge = assignments.get(currentKey);
      if (!edge) return false;
      currentKey = edge.parentKey;
    }
    return true;
  };
  const assign = (index) => {
    if (index === orderedPartKeys.length) {
      return partInstances.every(({ key }) => reachesWeapon(key));
    }
    const partKey = orderedPartKeys[index];
    for (const edge of edgesByPart.get(partKey)) {
      const slotKey = `${edge.parentKey}:${edge.slotId}`;
      if (occupiedSlots.has(slotKey)) continue;
      assignments.set(partKey, edge);
      occupiedSlots.add(slotKey);
      if (assign(index + 1)) return true;
      occupiedSlots.delete(slotKey);
      assignments.delete(partKey);
    }
    return false;
  };
  if (!assign(0)) {
    throw new Error(`factory preset for ${weapon.id} cannot be mapped to compatible slots`);
  }
  for (const instance of partInstances) {
    childrenByParent.get(assignments.get(instance.key).parentKey).push(instance.key);
  }
  for (const childKeys of childrenByParent.values()) {
    childKeys.sort((left, right) =>
      assignments.get(left).slotId.localeCompare(assignments.get(right).slotId) ||
      left.localeCompare(right),
    );
  }
  const instanceByKey = new Map(partInstances.map((instance) => [instance.key, instance]));
  const presetNodes = (parentKey) => childrenByParent.get(parentKey).map((childKey) => {
    const instance = instanceByKey.get(childKey);
    return {
      itemId: instance.itemId,
      slotId: assignments.get(childKey).slotId,
      children: presetNodes(childKey),
    };
  });

  const uniquePartIds = [...new Set(partInstances.map(({ itemId }) => itemId))].sort();
  const legacyChildren = new Map([weapon.id, ...uniquePartIds].map((parentId) => [parentId, []]));
  for (const instance of partInstances) {
    const edge = assignments.get(instance.key);
    const childIds = legacyChildren.get(edge.parentItemId);
    if (!childIds.includes(instance.itemId)) childIds.push(instance.itemId);
  }
  for (const childIds of legacyChildren.values()) childIds.sort();
  return {
    partIds: uniquePartIds,
    children: legacyChildren,
    presetBuild: presetNodes(rootKey),
  };
}

function addSlotCandidates(queue, slot, allItems, categoryIndex) {
  for (const itemId of slot.allowedItemIds) {
    const candidate = allItems[itemId];
    if (!candidate || !isPartCandidate(candidate)) continue;
    if (slotAllowsItem(slot, candidate, categoriesOf(candidate))) queue.push(itemId);
  }
  for (const categoryId of slot.allowedCategories) {
    for (const itemId of categoryIndex.get(categoryId) ?? []) {
      const candidate = allItems[itemId];
      if (candidate && isPartCandidate(candidate) &&
          slotAllowsItem(slot, candidate, categoriesOf(candidate))) queue.push(itemId);
    }
  }
}

function assertSourceIdentity(item, key) {
  const record = requiredRecord(item, `item ${key}`);
  if (!validItemId(key) || record.id !== key) throw new Error(`item id is invalid for ${key}`);
  return record;
}

export function buildWeaponModCatalog({
  generatedAt,
  regular,
  pve,
  english,
  korean,
  tasks,
  taskEnglish,
  taskKorean,
}) {
  if (typeof generatedAt !== "string" || !Number.isFinite(Date.parse(generatedAt))) {
    throw new Error("generatedAt must be an ISO timestamp");
  }
  const dataVersion = new Date(generatedAt).toISOString();
  const allItems = sourceItems(regular);
  const pveItems = sourceItems(pve);
  const englishTranslations = translationMap(english, "english");
  const koreanTranslations = translationMap(korean, "korean");
  const allTasks = sourceTasks(tasks);
  const taskEnglishTranslations = translationMap(taskEnglish, "taskEnglish");
  const taskKoreanTranslations = translationMap(taskKorean, "taskKorean");
  const categoryIndex = new Map();
  const weaponIds = [];

  for (const [key, value] of Object.entries(allItems)) {
    // json.tarkov.dev may expose a handful of synthetic helper records. They are
    // not stable BSG item identities and cannot safely participate in saved builds.
    if (!validItemId(key)) continue;
    const item = assertSourceIdentity(value, key);
    if (propertyType(item) === "ItemPropertiesWeapon") weaponIds.push(key);
    if (!isPartCandidate(item)) continue;
    for (const categoryId of categoriesOf(item)) {
      const candidates = categoryIndex.get(categoryId) ?? [];
      candidates.push(key);
      categoryIndex.set(categoryId, candidates);
    }
  }
  weaponIds.sort();

  const included = new Set(weaponIds);
  const queue = [...weaponIds];
  const factoryAssignmentsByWeapon = new Map();
  for (const weaponId of weaponIds) {
    const assignments = directFactoryAssignments(
      allItems[weaponId], allItems, englishTranslations, koreanTranslations,
    );
    for (const partId of assignments.partIds) queue.push(partId);
    factoryAssignmentsByWeapon.set(weaponId, assignments);
  }

  while (queue.length) {
    const itemId = queue.shift();
    if (!validItemId(itemId) || !allItems[itemId]) continue;
    const alreadyProcessed = included.has(itemId);
    included.add(itemId);
    if (alreadyProcessed && !weaponIds.includes(itemId)) continue;
    const item = allItems[itemId];
    for (const rawSlot of slotsOf(item)) {
      const slot = normalizeSlot(rawSlot, itemId, englishTranslations, koreanTranslations);
      addSlotCandidates(queue, slot, allItems, categoryIndex);
    }
  }

  const items = [...included].sort().map((itemId) => {
    const item = allItems[itemId];
    const weapon = propertyType(item) === "ItemPropertiesWeapon";
    const nameEn = translation(englishTranslations, item.name, cleanText(item.normalizedName, itemId));
    const nameKo = translation(koreanTranslations, item.name, nameEn);
    const shortNameEn = translation(englishTranslations, item.shortName, nameEn);
    const shortNameKo = translation(koreanTranslations, item.shortName, shortNameEn);
    const imageUrl = safeAssetLink(
      item.inspectImageLink ?? item.baseImageLink ?? item.gridImageLink,
      itemId,
    );
    const iconUrl = safeAssetLink(item.iconLink, itemId);
    const factoryPresetId = weapon && validItemId(propertiesOf(item).defaultPreset)
      ? propertiesOf(item).defaultPreset
      : undefined;
    const factoryPreset = factoryPresetId ? allItems[factoryPresetId] : undefined;
    const factoryImageUrl = factoryPreset
      ? safeAssetLink(
          factoryPreset.inspectImageLink ?? factoryPreset.baseImageLink ?? factoryPreset.gridImageLink,
          factoryPresetId,
        )
      : undefined;
    const slots = slotsOf(item).map((rawSlot) =>
      normalizeSlot(rawSlot, itemId, englishTranslations, koreanTranslations),
    );
    const factoryAssignments = weapon ? factoryAssignmentsByWeapon.get(itemId) : undefined;
    const factoryChildren = factoryAssignments?.children;
    const factoryPartIds = factoryChildren?.get(itemId) ?? [];
    const factoryPresetBuild = factoryAssignments?.presetBuild;
    const factoryPartsByParent = factoryChildren
      ? Object.fromEntries([...factoryChildren]
          .filter(([, childIds]) => childIds.length)
          .map(([parentId, childIds]) => [parentId, childIds]))
      : undefined;
    const conflicts = conflictsOf(item);
    const pveSourceItem = pveItems[itemId];
    if (pveSourceItem !== undefined) assertSourceIdentity(pveSourceItem, itemId);
    const pvpTraderOffers = traderOffersOf(
      item, allTasks, taskEnglishTranslations, taskKoreanTranslations,
    );
    const pveTraderOffers = pveSourceItem ? traderOffersOf(
      pveSourceItem, allTasks, taskEnglishTranslations, taskKoreanTranslations,
    ) : undefined;
    const traderOffersByProfile = pvpTraderOffers || pveTraderOffers ? {
      ...(pvpTraderOffers ? { pvp: pvpTraderOffers } : {}),
      ...(pveTraderOffers ? { pve: pveTraderOffers } : {}),
    } : undefined;
    const pvpFlea = fleaOf(item, dataVersion);
    const pveFlea = pveSourceItem ? fleaOf(pveSourceItem, dataVersion) : undefined;
    const fleaByProfile = pvpFlea || pveFlea ? {
      ...(pvpFlea ? { pvp: pvpFlea } : {}),
      ...(pveFlea ? { pve: pveFlea } : {}),
    } : undefined;
    return {
      id: itemId,
      name: nameKo || nameEn,
      nameEn,
      nameKo,
      shortName: shortNameKo || shortNameEn,
      kind: weapon ? "weapon" : "part",
      categories: categoriesOf(item),
      ...(imageUrl ? { imageUrl } : {}),
      ...(iconUrl ? { iconUrl } : {}),
      ...(slots.length || weapon ? { slots } : {}),
      ...(factoryPartIds.length || weapon ? { factoryPartIds } : {}),
      ...(factoryPresetId ? { factoryPresetId } : {}),
      ...(factoryImageUrl ? { factoryImageUrl } : {}),
      ...(factoryPartsByParent && Object.keys(factoryPartsByParent).length
        ? { factoryPartsByParent }
        : {}),
      ...(factoryPresetBuild ? { factoryPresetBuild } : {}),
      ...(conflicts ? { conflicts } : {}),
      ...(traderOffersByProfile ? { traderOffersByProfile } : {}),
      ...(fleaByProfile ? { fleaByProfile } : {}),
      ...(weapon ? { baseStats: baseStatsOfWeapon(item) } : { stats: statsOfPart(item) }),
    };
  });

  return { schemaVersion: 1, dataVersion, items, weaponIds };
}

export async function readBoundedJsonResponse(response, maximumBytes) {
  if (!(response instanceof Response)) throw new Error("upstream response is invalid");
  if (!response.ok) throw new Error(`upstream returned HTTP ${response.status}`);
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("maximumBytes is invalid");
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new Error("upstream response exceeded the size limit");
  }
  if (!response.body) throw new Error("upstream response body is missing");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("upstream response exceeded the size limit");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("upstream response was not valid UTF-8 JSON");
  }
}

export async function fetchFixedJson(url, maximumBytes, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "TarkovHelper-Web-ModdingCatalog/1.0",
    },
    redirect: "error",
  });
  return readBoundedJsonResponse(response, maximumBytes);
}
