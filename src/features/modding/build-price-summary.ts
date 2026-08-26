import { flattenBuildTree } from "../../domain/weapon-build";
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
  questUnlocks: BuildTraderQuestUnlock[];
  sourceCounts: { flea: number; trader: number };
  total: BuildPriceGroupSummary;
  traderRequirements: BuildTraderRequirement[];
  weapon: BuildPriceGroupSummary;
}

export interface BuildPriceSummary {
  itemCount: number;
  partCount: number;
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
): BuildPriceSummary {
  const itemById = new Map(catalog.items.map((item) => [item.id, item]));
  const items = flattenBuildTree(build.root).map<BuildPriceItem>((node) => ({
    instanceId: node.instanceId,
    item: itemById.get(node.itemId),
    itemId: node.itemId,
  }));

  return {
    itemCount: items.length,
    partCount: Math.max(0, items.length - 1),
    strategies: {
      cheapest: summarizeStrategy(items, activeProfile, "cheapest"),
      flea: summarizeStrategy(items, activeProfile, "flea"),
      trader: summarizeStrategy(items, activeProfile, "trader"),
    },
  };
}

function summarizeStrategy(
  items: readonly BuildPriceItem[],
  activeProfile: ProfileType,
  strategy: BuildPriceStrategy,
): BuildPriceStrategySummary {
  const purchases = items.map((item) => selectPurchase(item, activeProfile, strategy));
  const weapon = summarizeGroup(purchases.slice(0, 1));
  const parts = summarizeGroup(purchases.slice(1));
  const total = summarizeGroup(purchases);
  return {
    fleaMinimumPlayerLevel: total.fleaMinimumPlayerLevel,
    parts,
    questUnlocks: total.questUnlocks,
    sourceCounts: total.sourceCounts,
    total,
    traderRequirements: total.traderRequirements,
    weapon,
  };
}

function selectPurchase(
  buildItem: BuildPriceItem,
  activeProfile: ProfileType,
  strategy: BuildPriceStrategy,
): BuildPurchase {
  if (!buildItem.item) return { item: buildItem, source: "missing" };

  const traderOffer = getBestTraderOffer(buildItem.item, activeProfile);
  const traderPrice = traderOffer ? normalizedTraderPrice(traderOffer) : undefined;
  const flea = getProfileFleaPrice(buildItem.item, activeProfile);
  const fleaPrice = flea?.currency === "RUB" && isUsablePrice(flea.price)
    ? flea.price
    : undefined;

  if (strategy === "trader") {
    return {
      item: buildItem,
      priceRoubles: isUsablePrice(traderPrice) ? traderPrice : undefined,
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
  if (traderPrice !== undefined && (fleaPrice === undefined || traderPrice <= fleaPrice)) {
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
