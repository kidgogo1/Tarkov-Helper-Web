import type { ProfileType } from "../../types/data";
import type {
  FleaMarketSnapshot,
  TraderOffer,
  WeaponCatalogItem,
  WeaponPartItem,
} from "../../types/weapon-modding";

export type CandidateAvailability = "compatible" | "auto-resolvable" | "blocked";
export type CandidateAvailabilityFilter = CandidateAvailability | "all";
export type CandidateEffectFilter =
  | "recoil"
  | "ergonomics"
  | "lighter"
  | "accuracy"
  | "velocity";
export type CandidateFeatureFilter = "subslots" | "required-slots";
export type CandidatePurchaseFilter = "trader" | "flea";
export type CandidateQuestFilter = "all" | "required" | "not-required";
export type CandidateSortKey =
  | "availability"
  | "trader-price"
  | "flea-price"
  | "recoil"
  | "ergonomics"
  | "weight"
  | "accuracy"
  | "velocity"
  | "loyalty-level"
  | "name";

export interface PartCandidatePerformanceDelta {
  /** Vertical recoil change after the complete replacement; lower is better. */
  recoil?: number;
  /** Ergonomics change after the complete replacement; higher is better. */
  ergonomics?: number;
  /** Build weight change in kilograms; lower is better. */
  weight?: number;
  /** Accuracy change in MOA; lower is better. */
  accuracy?: number;
  /** Muzzle velocity modifier change in percent; higher is better. */
  velocity?: number;
}

export interface PartCandidateRecord {
  availability: CandidateAvailability;
  candidate: WeaponPartItem;
  performanceDelta: PartCandidatePerformanceDelta;
}

export interface PartCandidateFilters {
  query: string;
  availability: CandidateAvailabilityFilter;
  purchaseFilters: readonly CandidatePurchaseFilter[];
  effectFilters: readonly CandidateEffectFilter[];
  featureFilters: readonly CandidateFeatureFilter[];
  questRequirement: CandidateQuestFilter;
  traderId: string;
  maxTraderPrice?: number;
  maxFleaPrice?: number;
  maxLoyaltyLevel?: number;
}

export const DEFAULT_PART_CANDIDATE_FILTERS: PartCandidateFilters = {
  query: "",
  availability: "all",
  purchaseFilters: [],
  effectFilters: [],
  featureFilters: [],
  questRequirement: "all",
  traderId: "",
};

const EPSILON = 1e-6;

export function filterAndSortPartCandidates<T extends PartCandidateRecord>(
  candidates: readonly T[],
  activeProfile: ProfileType,
  filters: PartCandidateFilters,
  sortKeys: readonly CandidateSortKey[],
): T[] {
  return candidates
    .map((candidate, originalIndex) => ({ candidate, originalIndex }))
    .filter(({ candidate }) => candidateMatchesFilters(candidate, activeProfile, filters))
    .sort((left, right) => {
      for (const sortKey of sortKeys) {
        const difference = compareCandidates(
          left.candidate,
          right.candidate,
          activeProfile,
          filters,
          sortKey,
        );
        if (difference !== 0) return difference;
      }
      return left.originalIndex - right.originalIndex;
    })
    .map(({ candidate }) => candidate);
}

export function moveCandidateSort(
  sortKeys: readonly CandidateSortKey[],
  sortKey: CandidateSortKey,
  direction: -1 | 1,
): CandidateSortKey[] {
  const currentIndex = sortKeys.indexOf(sortKey);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= sortKeys.length) {
    return [...sortKeys];
  }
  const nextKeys = [...sortKeys];
  [nextKeys[currentIndex], nextKeys[nextIndex]] = [
    nextKeys[nextIndex],
    nextKeys[currentIndex],
  ];
  return nextKeys;
}

export function getProfileTraderOffers(
  item: WeaponCatalogItem,
  activeProfile: ProfileType,
): TraderOffer[] {
  return item.traderOffersByProfile?.[activeProfile] ?? item.traderOffers ?? [];
}

export function getProfileFleaPrice(
  item: WeaponCatalogItem,
  activeProfile: ProfileType,
): FleaMarketSnapshot | undefined {
  return item.fleaByProfile?.[activeProfile] ?? item.flea;
}

export function getBestTraderOffer(
  item: WeaponCatalogItem,
  activeProfile: ProfileType,
  filters?: Pick<PartCandidateFilters, "traderId" | "maxLoyaltyLevel" | "questRequirement">,
): TraderOffer | undefined {
  return eligibleTraderOffers(item, activeProfile, filters).reduce<TraderOffer | undefined>(
    (best, candidate) => {
      if (!best) return candidate;
      const bestPrice = normalizedTraderPrice(best);
      const candidatePrice = normalizedTraderPrice(candidate);
      if (bestPrice === undefined) return candidate;
      if (candidatePrice === undefined) return best;
      if (candidatePrice !== bestPrice) return candidatePrice < bestPrice ? candidate : best;
      if (candidate.loyaltyLevel !== best.loyaltyLevel) {
        return candidate.loyaltyLevel < best.loyaltyLevel ? candidate : best;
      }
      return candidate.traderId.localeCompare(best.traderId) < 0 ? candidate : best;
    },
    undefined,
  );
}

export function normalizedTraderPrice(offer: TraderOffer): number | undefined {
  if (offer.priceRoubles !== undefined) return offer.priceRoubles;
  if (offer.currency === "RUB") return offer.price;
  return undefined;
}

function candidateMatchesFilters(
  record: PartCandidateRecord,
  activeProfile: ProfileType,
  filters: PartCandidateFilters,
): boolean {
  const { candidate, performanceDelta } = record;
  const needle = normalizeSearch(filters.query);
  if (needle && ![
    candidate.name,
    candidate.nameEn,
    candidate.nameKo,
    candidate.shortName,
  ].some((value) => value && normalizeSearch(value).includes(needle))) return false;
  if (filters.availability !== "all" && record.availability !== filters.availability) {
    return false;
  }

  const trader = getBestTraderOffer(candidate, activeProfile, filters);
  const flea = getProfileFleaPrice(candidate, activeProfile);
  if (filters.purchaseFilters.includes("trader") && !trader) return false;
  if (filters.purchaseFilters.includes("flea") && !flea) return false;
  if (filters.maxTraderPrice !== undefined) {
    const price = trader ? normalizedTraderPrice(trader) : undefined;
    if (price === undefined || price > filters.maxTraderPrice) return false;
  }
  if (filters.maxFleaPrice !== undefined && (!flea || flea.price > filters.maxFleaPrice)) {
    return false;
  }
  if (!filters.effectFilters.every((filter) => effectMatches(performanceDelta, filter))) {
    return false;
  }
  if (!filters.featureFilters.every((filter) => featureMatches(candidate, filter))) {
    return false;
  }
  return true;
}

function eligibleTraderOffers(
  item: WeaponCatalogItem,
  activeProfile: ProfileType,
  filters?: Pick<PartCandidateFilters, "traderId" | "maxLoyaltyLevel" | "questRequirement">,
): TraderOffer[] {
  return getProfileTraderOffers(item, activeProfile).filter((offer) => {
    if (filters?.traderId && offer.traderId !== filters.traderId) return false;
    if (
      filters?.maxLoyaltyLevel !== undefined &&
      offer.loyaltyLevel > filters.maxLoyaltyLevel
    ) return false;
    if (filters?.questRequirement === "required" && !offer.questUnlock) return false;
    if (filters?.questRequirement === "not-required" && offer.questUnlock) return false;
    return normalizedTraderPrice(offer) !== undefined;
  });
}

function effectMatches(
  performance: PartCandidatePerformanceDelta,
  filter: CandidateEffectFilter,
): boolean {
  if (filter === "recoil") return (performance.recoil ?? 0) < -EPSILON;
  if (filter === "ergonomics") return (performance.ergonomics ?? 0) > EPSILON;
  if (filter === "lighter") return (performance.weight ?? 0) < -EPSILON;
  if (filter === "accuracy") return (performance.accuracy ?? 0) < -EPSILON;
  return (performance.velocity ?? 0) > EPSILON;
}

function featureMatches(candidate: WeaponPartItem, filter: CandidateFeatureFilter): boolean {
  if (filter === "subslots") return Boolean(candidate.slots?.length);
  return Boolean(candidate.slots?.some((slot) => slot.required));
}

function compareCandidates(
  left: PartCandidateRecord,
  right: PartCandidateRecord,
  activeProfile: ProfileType,
  filters: PartCandidateFilters,
  sortKey: CandidateSortKey,
): number {
  if (sortKey === "availability") {
    return availabilityRank(left.availability) - availabilityRank(right.availability);
  }
  if (sortKey === "trader-price") {
    return compareOptionalNumbers(
      traderPrice(left.candidate, activeProfile, filters),
      traderPrice(right.candidate, activeProfile, filters),
      "ascending",
    );
  }
  if (sortKey === "flea-price") {
    return compareOptionalNumbers(
      getProfileFleaPrice(left.candidate, activeProfile)?.price,
      getProfileFleaPrice(right.candidate, activeProfile)?.price,
      "ascending",
    );
  }
  if (sortKey === "loyalty-level") {
    return compareOptionalNumbers(
      getBestTraderOffer(left.candidate, activeProfile, filters)?.loyaltyLevel,
      getBestTraderOffer(right.candidate, activeProfile, filters)?.loyaltyLevel,
      "ascending",
    );
  }
  if (sortKey === "name") {
    return (left.candidate.nameKo ?? left.candidate.name).localeCompare(
      right.candidate.nameKo ?? right.candidate.name,
      "ko",
    );
  }
  const direction = sortKey === "ergonomics" || sortKey === "velocity"
    ? "descending"
    : "ascending";
  return compareOptionalNumbers(
    performanceValue(left.performanceDelta, sortKey),
    performanceValue(right.performanceDelta, sortKey),
    direction,
  );
}

function traderPrice(
  candidate: WeaponPartItem,
  activeProfile: ProfileType,
  filters: PartCandidateFilters,
): number | undefined {
  const offer = getBestTraderOffer(candidate, activeProfile, filters);
  return offer ? normalizedTraderPrice(offer) : undefined;
}

function performanceValue(
  performance: PartCandidatePerformanceDelta,
  sortKey: CandidateSortKey,
): number | undefined {
  if (sortKey === "recoil") return performance.recoil;
  if (sortKey === "ergonomics") return performance.ergonomics;
  if (sortKey === "weight") return performance.weight;
  if (sortKey === "accuracy") return performance.accuracy;
  if (sortKey === "velocity") return performance.velocity;
  return undefined;
}

function compareOptionalNumbers(
  left: number | undefined,
  right: number | undefined,
  direction: "ascending" | "descending",
): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  const difference = left - right;
  if (Math.abs(difference) <= EPSILON) return 0;
  return direction === "ascending" ? difference : -difference;
}

function availabilityRank(availability: CandidateAvailability): number {
  if (availability === "compatible") return 0;
  if (availability === "auto-resolvable") return 1;
  return 2;
}

function normalizeSearch(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}
