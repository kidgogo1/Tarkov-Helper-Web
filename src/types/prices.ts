import type { ProfileType } from "./data";

export interface ItemTraderOffer {
  traderId: string;
  price: number;
  priceRUB: number;
  currency: string;
}

export interface ItemPriceSnapshot {
  updatedAt?: string | null;
  lastLowPrice?: number | null;
  avg24hPrice?: number | null;
  low24hPrice?: number | null;
  high24hPrice?: number | null;
  changeLast48hPercent?: number | null;
  offerCount?: number | null;
  noFlea?: boolean;
  bestTraderOffer?: ItemTraderOffer | null;
}

export interface ItemPriceCatalogItem {
  id: string;
  normalizedName: string;
  nameEn: string;
  nameKo: string;
  shortNameEn: string;
  shortNameKo: string;
  wikiLink?: string;
  tarkovDevLink?: string;
  localIcon?: string;
  prices: Partial<Record<ProfileType, ItemPriceSnapshot>>;
}

export interface ItemPriceCatalog {
  meta: {
    schemaVersion: 1;
    generatedAt: string;
    source: "https://json.tarkov.dev/endpoints";
    itemCount: number;
    pvpQuoteCount: number;
    pveQuoteCount: number;
  };
  items: ItemPriceCatalogItem[];
}

export interface LiveItemPriceQuote {
  protocolVersion: 1;
  itemId: string;
  gameMode: ProfileType;
  source: "LIVE" | "CACHE" | "STALE_CACHE";
  fetchedAt: string;
  expiresAt: string;
  isStale: boolean;
  flea: ItemPriceSnapshot;
}
