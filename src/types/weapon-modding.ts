export interface WeaponBaseStats {
  verticalRecoil: number;
  horizontalRecoil: number;
  ergonomics: number;
  weight: number;
  centerOfImpact?: number;
}

export interface WeaponStats {
  verticalRecoil: number;
  horizontalRecoil: number;
  ergonomics: number;
  weight: number;
  accuracyMoa?: number;
  muzzleVelocityModifier?: number;
}

export interface WeaponPartStats {
  recoilModifier?: number;
  ergonomics?: number;
  weight?: number;
  centerOfImpact?: number;
  muzzleVelocityModifier?: number;
}

export interface WeaponSlotRule {
  id: string;
  name: string;
  required?: boolean;
  allowedItemIds?: string[];
  allowedCategories?: string[];
  excludedItemIds?: string[];
  excludedCategories?: string[];
}

export interface WeaponConflictRule {
  itemIds?: string[];
  categories?: string[];
  slotIds?: string[];
}

export interface TraderUnlock {
  questId: string;
  questName: string;
  minimumPlayerLevel?: number;
}

export interface TraderOffer {
  traderId: string;
  traderName: string;
  price: number;
  /** Offer price normalized to roubles by the source data, for cross-currency comparison. */
  priceRoubles?: number;
  currency: string;
  loyaltyLevel: number;
  questUnlock?: TraderUnlock;
}

export interface TraderOffersByProfile {
  pvp?: TraderOffer[];
  pve?: TraderOffer[];
}

export interface FleaMarketSnapshot {
  price: number;
  currency: string;
  updatedAt: string;
  minimumPlayerLevel?: number;
  lowPrice?: number;
  average24h?: number;
}

export interface FleaMarketSnapshots {
  pvp?: FleaMarketSnapshot;
  pve?: FleaMarketSnapshot;
}

export interface FactoryPresetNode {
  itemId: string;
  slotId: string;
  children: FactoryPresetNode[];
}

interface WeaponCatalogItemBase {
  id: string;
  name: string;
  nameEn?: string;
  nameKo?: string;
  shortName?: string;
  categories: string[];
  imageUrl?: string;
  iconUrl?: string;
  slots?: WeaponSlotRule[];
  factoryPartIds?: string[];
  conflicts?: WeaponConflictRule;
  traderOffers?: TraderOffer[];
  traderOffersByProfile?: TraderOffersByProfile;
  fleaByProfile?: FleaMarketSnapshots;
  /** Legacy single-profile snapshot retained for old generated packs. */
  flea?: FleaMarketSnapshot;
}

export interface WeaponItem extends WeaponCatalogItemBase {
  kind: "weapon";
  slots: WeaponSlotRule[];
  factoryPartIds: string[];
  factoryPresetId?: string;
  factoryImageUrl?: string;
  /** Cash quotes for this exact default preset, never receiver-only or cross-profile prices. */
  factoryTraderOffersByProfile?: TraderOffersByProfile;
  /** Collection time of factory package quotes; may differ from the catalog data version. */
  factoryPriceUpdatedAt?: string;
  /** Default-preset children scoped to this weapon, keyed by parent item id. */
  factoryPartsByParent?: Record<string, string[]>;
  /** Exact slot tree for the default preset, including repeated identical parts. */
  factoryPresetBuild?: FactoryPresetNode[];
  baseStats: WeaponBaseStats;
}

export interface WeaponPartItem extends WeaponCatalogItemBase {
  kind: "part";
  stats?: WeaponPartStats;
}

export type WeaponCatalogItem = WeaponItem | WeaponPartItem;

export interface WeaponCatalog {
  schemaVersion: 1;
  dataVersion: string;
  items: WeaponCatalogItem[];
  weaponIds: string[];
}

export interface BuildNode {
  instanceId: string;
  itemId: string;
  /** The slot on the parent node occupied by this node. Omitted on the root. */
  slotId?: string;
  children: BuildNode[];
}

export interface WeaponBuild {
  schemaVersion: 1;
  catalogDataVersion: string;
  weaponId: string;
  root: BuildNode;
}

export interface FlatBuildNode {
  instanceId: string;
  itemId: string;
  parentInstanceId: string | null;
  slotId: string | null;
  depth: number;
}

export type BuildIssueCode =
  | "UNKNOWN_WEAPON"
  | "UNKNOWN_ITEM"
  | "UNKNOWN_PARENT"
  | "UNKNOWN_SLOT"
  | "ROOT_ITEM_MISMATCH"
  | "DUPLICATE_INSTANCE_ID"
  | "DUPLICATE_SLOT"
  | "MISSING_REQUIRED_SLOT"
  | "ITEM_NOT_ALLOWED"
  | "ITEM_EXCLUDED"
  | "ITEM_CONFLICT"
  | "SLOT_CONFLICT";

export interface BuildIssue {
  code: BuildIssueCode;
  message: string;
  instanceId?: string;
  itemId?: string;
  parentInstanceId?: string;
  slotId?: string;
  relatedInstanceId?: string;
  relatedItemId?: string;
}

export interface BuildValidationResult {
  isValid: boolean;
  issues: BuildIssue[];
}

export type BuildMutationResult =
  | {
      ok: true;
      build: WeaponBuild;
      removedNodes: FlatBuildNode[];
    }
  | {
      ok: false;
      build: WeaponBuild;
      issues: BuildIssue[];
    };
