import { createFactoryBuild, flattenBuildTree } from "../../domain/weapon-build";
import type { ProfileType } from "../../types/data";
import type {
  TraderOffer,
  WeaponBuild,
  WeaponCatalog,
  WeaponCatalogItem,
} from "../../types/weapon-modding";
import {
  getBestTraderOffer,
  getProfileFleaPrice,
  normalizedTraderPrice,
} from "./part-candidate-controls";

export type BuildPriceStrategy = "trader" | "flea" | "cheapest";
export type BuildPurchaseMode = "buy" | "owned";

/** Additional parts only; the factory gun is priced separately. */
export interface BuildPurchaseLine {
  itemId: string;
  name: string;
  imageUrl?: string;
  quantity: number;
  /** Unit price in roubles. Missing prices must not be presented as zero. */
  priceRoubles?: number;
  source: "trader" | "flea" | "missing";
  traderOffer?: TraderOffer;
  fleaMinimumPlayerLevel?: number;
}

export interface BuildPriceMissingItem {
  instanceId: string;
  itemId: string;
  name: string;
}

export interface BuildTraderRequirement {
  loyaltyLevel: number;
  traderId: string;
  traderName: string;
}

export interface BuildTraderQuestUnlock {
  minimumPlayerLevel?: number;
  questId: string;
  questName: string;
  traderId: string;
  traderName: string;
}

export interface BuildPriceGroupSummary {
  fleaMinimumPlayerLevel?: number;
  itemCount: number;
  knownTotalRoubles: number;
  missingItemCount: number;
  missingItems: BuildPriceMissingItem[];
  pricedItemCount: number;
  questUnlocks: BuildTraderQuestUnlock[];
  sourceCounts: { flea: number; trader: number };
  totalRoubles: number | null;
  traderRequirements: BuildTraderRequirement[];
}

export interface BuildPriceStrategySummary {
  fleaMinimumPlayerLevel?: number;
  parts: BuildPriceGroupSummary;
  purchaseLines: BuildPurchaseLine[];
  questUnlocks: BuildTraderQuestUnlock[];
  sourceCounts: { flea: number; trader: number };
  total: BuildPriceGroupSummary;
  traderRequirements: BuildTraderRequirement[];
  weapon: BuildPriceGroupSummary;
}

export interface BuildPriceSummary {
  itemCount: number;
  partCount: number;
  purchaseMode: BuildPurchaseMode;
  includedPartCount: number;
  additionalPartCount: number;
  removedFactoryPartCount: number;
  /** Informational only: neither quote guarantees the default gun assembly. */
  weaponReferences: {
    receiverTrader: BuildPriceGroupSummary;
    flea: BuildPriceGroupSummary;
  };
  strategies: Record<BuildPriceStrategy, BuildPriceStrategySummary>;
}

interface BuildPriceItem {
  instanceId: string;
  item?: WeaponCatalogItem;
  itemId: string;
}

interface BuildPurchase {
  fleaMinimumPlayerLevel?: number;
  item: BuildPriceItem;
  priceRoubles?: number;
  source: "trader" | "flea" | "missing";
  traderOffer?: TraderOffer;
}

export function summarizeBuildPrice(
  catalog: WeaponCatalog,
  build: WeaponBuild,
  activeProfile: ProfileType,
  purchaseMode: BuildPurchaseMode = "buy",
): BuildPriceSummary {
  const itemById = new Map(catalog.items.map((item) => [item.id, item]));
  const items = flattenBuildTree(build.root).map<BuildPriceItem>((node) => ({
    instanceId: node.instanceId,
    item: itemById.get(node.itemId),
    itemId: node.itemId,
  }));
  const factoryParts = flattenBuildTree(createFactoryBuild(catalog, build.weaponId).root).slice(1);
  const remainingFactoryCounts = new Map<string, number>();
  for (const part of factoryParts) {
    remainingFactoryCounts.set(part.itemId, (remainingFactoryCounts.get(part.itemId) ?? 0) + 1);
  }
  // Match by item and quantity, not slot: stock parts can be moved or reused on a new parent.
  const additionalParts = items.slice(1).filter((item) => {
    const available = remainingFactoryCounts.get(item.itemId) ?? 0;
    if (available === 0) return true;
    remainingFactoryCounts.set(item.itemId, available - 1);
    return false;
  });
  const includedPartCount = items.length - 1 - additionalParts.length;
  const weapon = items[0];
  const factoryWeapon = weapon.item?.kind === "weapon" ? {
    ...weapon,
    item: {
      ...weapon.item,
      traderOffers: undefined,
      traderOffersByProfile: weapon.item.factoryTraderOffersByProfile ?? {},
    },
  } : weapon;
  // A receiver offer or flea snapshot is not proof of a complete default preset.
  const weaponPurchases = purchaseMode === "owned" ? [] : [selectPurchase(factoryWeapon, activeProfile, "trader")];

  return {
    itemCount: items.length,
    partCount: Math.max(0, items.length - 1),
    purchaseMode,
    includedPartCount,
    additionalPartCount: additionalParts.length,
    removedFactoryPartCount: factoryParts.length - includedPartCount,
    weaponReferences: {
      receiverTrader: summarizeGroup([selectPurchase(weapon, activeProfile, "trader")]),
      flea: summarizeGroup([selectPurchase(weapon, activeProfile, "flea")]),
    },
    strategies: {
      cheapest: summarizeStrategy(additionalParts, weaponPurchases, activeProfile, "cheapest"),
      flea: summarizeStrategy(additionalParts, weaponPurchases, activeProfile, "flea"),
      trader: summarizeStrategy(additionalParts, weaponPurchases, activeProfile, "trader"),
    },
  };
}

function summarizeStrategy(
  items: readonly BuildPriceItem[],
  weaponPurchases: readonly BuildPurchase[],
  activeProfile: ProfileType,
  strategy: BuildPriceStrategy,
): BuildPriceStrategySummary {
  const purchases = items.map((item) => selectPurchase(item, activeProfile, strategy));
  const weapon = summarizeGroup(weaponPurchases);
  const parts = summarizeGroup(purchases);
  const total = summarizeGroup([...weaponPurchases, ...purchases]);
  return {
    fleaMinimumPlayerLevel: total.fleaMinimumPlayerLevel,
    parts,
    purchaseLines: aggregatePurchaseLines(purchases),
    questUnlocks: total.questUnlocks,
    sourceCounts: total.sourceCounts,
    total,
    traderRequirements: total.traderRequirements,
    weapon,
  };
}

function aggregatePurchaseLines(purchases: readonly BuildPurchase[]): BuildPurchaseLine[] {
  const byItemId = new Map<string, BuildPurchaseLine>();
  for (const purchase of purchases) {
    const existing = byItemId.get(purchase.item.itemId);
    if (existing) {
      existing.quantity += 1;
      continue;
    }
    const { item, itemId } = purchase.item;
    byItemId.set(itemId, {
      itemId,
      name: item?.nameKo ?? item?.name ?? itemId,
      imageUrl: item?.iconUrl ?? item?.imageUrl,
      quantity: 1,
      priceRoubles: purchase.priceRoubles,
      source: purchase.source,
      traderOffer: purchase.traderOffer,
      fleaMinimumPlayerLevel: purchase.fleaMinimumPlayerLevel,
    });
  }
  return [...byItemId.values()];
}

function selectPurchase(
  buildItem: BuildPriceItem,
  activeProfile: ProfileType,
  strategy: BuildPriceStrategy,
): BuildPurchase {
  if (!buildItem.item) return { item: buildItem, source: "missing" };

  const traderOffer = getBestTraderOffer(buildItem.item, activeProfile);
  const normalizedPrice = traderOffer ? normalizedTraderPrice(traderOffer) : undefined;
  const traderPrice = isUsablePrice(normalizedPrice) ? normalizedPrice : undefined;
  const flea = getProfileFleaPrice(buildItem.item, activeProfile);
  const fleaPrice = flea?.currency === "RUB" && isUsablePrice(flea.price)
    ? flea.price
    : undefined;

  if (strategy === "trader") {
    return {
      item: buildItem,
      priceRoubles: traderPrice,
      source: traderOffer ? "trader" : "missing",
      traderOffer,
    };
  }
  if (strategy === "flea") {
    return {
      fleaMinimumPlayerLevel: flea?.minimumPlayerLevel,
      item: buildItem,
      priceRoubles: fleaPrice,
      source: flea ? "flea" : "missing",
    };
  }
  if (traderPrice !== undefined && (fleaPrice === undefined || traderPrice < fleaPrice)) {
    return {
      item: buildItem,
      priceRoubles: traderPrice,
      source: "trader",
      traderOffer,
    };
  }
  if (fleaPrice !== undefined) {
    return {
      fleaMinimumPlayerLevel: flea?.minimumPlayerLevel,
      item: buildItem,
      priceRoubles: fleaPrice,
      source: "flea",
    };
  }
  return { item: buildItem, source: "missing" };
}

function summarizeGroup(purchases: readonly BuildPurchase[]): BuildPriceGroupSummary {
  const missingItems: BuildPriceMissingItem[] = [];
  const requirements = new Map<string, BuildTraderRequirement>();
  const questUnlocks = new Map<string, BuildTraderQuestUnlock>();
  const sourceCounts = { flea: 0, trader: 0 };
  let fleaMinimumPlayerLevel: number | undefined;
  let knownTotalRoubles = 0;
  let pricedItemCount = 0;

  for (const purchase of purchases) {
    if (purchase.priceRoubles === undefined) {
      missingItems.push({
        instanceId: purchase.item.instanceId,
        itemId: purchase.item.itemId,
        name: purchase.item.item?.nameKo ?? purchase.item.item?.name ?? purchase.item.itemId,
      });
    } else {
      knownTotalRoubles += purchase.priceRoubles;
      pricedItemCount += 1;
      if (purchase.source !== "missing") sourceCounts[purchase.source] += 1;
    }

    if (purchase.source === "flea" && purchase.fleaMinimumPlayerLevel !== undefined) {
      fleaMinimumPlayerLevel = Math.max(
        fleaMinimumPlayerLevel ?? 0,
        purchase.fleaMinimumPlayerLevel,
      );
    }
    if (purchase.source !== "trader" || !purchase.traderOffer) continue;
    const offer = purchase.traderOffer;
    const requirement = requirements.get(offer.traderId);
    if (!requirement || offer.loyaltyLevel > requirement.loyaltyLevel) {
      requirements.set(offer.traderId, {
        loyaltyLevel: offer.loyaltyLevel,
        traderId: offer.traderId,
        traderName: offer.traderName,
      });
    }
    if (offer.questUnlock) {
      questUnlocks.set(`${offer.traderId}:${offer.questUnlock.questId}`, {
        minimumPlayerLevel: offer.questUnlock.minimumPlayerLevel,
        questId: offer.questUnlock.questId,
        questName: offer.questUnlock.questName,
        traderId: offer.traderId,
        traderName: offer.traderName,
      });
    }
  }

  return {
    fleaMinimumPlayerLevel,
    itemCount: purchases.length,
    knownTotalRoubles,
    missingItemCount: missingItems.length,
    missingItems,
    pricedItemCount,
    questUnlocks: [...questUnlocks.values()].sort(compareQuestUnlocks),
    sourceCounts,
    totalRoubles: missingItems.length ? null : knownTotalRoubles,
    traderRequirements: [...requirements.values()].sort((left, right) =>
      left.traderName.localeCompare(right.traderName),
    ),
  };
}

function compareQuestUnlocks(
  left: BuildTraderQuestUnlock,
  right: BuildTraderQuestUnlock,
): number {
  return left.traderName.localeCompare(right.traderName) ||
    left.questName.localeCompare(right.questName);
}

function isUsablePrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}
