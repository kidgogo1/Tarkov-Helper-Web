export interface WeaponStats {
  verticalRecoil: number;
  horizontalRecoil: number;
  ergonomics: number;
  weight: number;
  accuracy?: number;
  muzzleVelocity?: number;
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
}

export interface TraderOffer {
  traderId: string;
  traderName: string;
  price: number;
  currency: string;
  loyaltyLevel: number;
  questUnlock?: TraderUnlock;
}

export interface FleaMarketSnapshot {
  price: number;
  currency: string;
  updatedAt: string;
  lowPrice?: number;
  average24h?: number;
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
  flea?: FleaMarketSnapshot;
}

export interface WeaponItem extends WeaponCatalogItemBase {
  kind: "weapon";
  slots: WeaponSlotRule[];
  factoryPartIds: string[];
  baseStats: WeaponStats;
}

export interface WeaponPartItem extends WeaponCatalogItemBase {
  kind: "part";
  stats?: Partial<WeaponStats>;
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
