import { formatRoubles } from "../../domain/item-prices";
import type { ProfileType } from "../../types/data";
import type { TraderOffer, WeaponCatalogItem } from "../../types/weapon-modding";
import {
  getBestTraderOffer,
  getProfileFleaPrice,
  type PartCandidateFilters,
} from "./part-candidate-controls";

export function PartCandidatePrice({ activeProfile, filters, item }: {
  activeProfile: ProfileType;
  filters: PartCandidateFilters;
  item: WeaponCatalogItem;
}) {
  const trader = getBestTraderOffer(item, activeProfile, filters);
  const flea = getProfileFleaPrice(item, activeProfile);
  const traderLabel = trader
    ? `상점 · ${trader.traderName} LL${trader.loyaltyLevel}`
    : "상점 정보 없음";
  const traderPrice = trader ? formatTraderOfferPrice(trader) : "—";
  const fleaLabel = flea
    ? `플리 참고가${flea.minimumPlayerLevel ? ` · Lv.${flea.minimumPlayerLevel}` : ""}`
    : "플리 정보 없음";
  const fleaPrice = flea ? formatRoubles(flea.price) : "—";
  return (
    <span className="modding-part-commerce">
      <span
        className="modding-price-cell trader"
        data-empty={trader ? undefined : "true"}
        data-price-kind="trader"
        title={`${traderLabel} · ${traderPrice}`}
      >
        <small className="modding-price-label">{traderLabel}</small>
        <strong className="modding-price-value">{traderPrice}</strong>
        {trader?.questUnlock ? (
          <small className="modding-quest-unlock">
            {`해금 · ${trader.questUnlock.questName} 퀘스트`}
            {trader.questUnlock.minimumPlayerLevel !== undefined
              ? ` (Lv.${trader.questUnlock.minimumPlayerLevel})`
              : ""}
          </small>
        ) : null}
      </span>
      <span
        className="modding-price-cell flea"
        data-empty={flea ? undefined : "true"}
        data-price-kind="flea"
        title={`${fleaLabel} · ${fleaPrice}`}
      >
        <small className="modding-price-label">{fleaLabel}</small>
        <strong className="modding-price-value">{fleaPrice}</strong>
      </span>
    </span>
  );
}

function formatTraderOfferPrice(offer: TraderOffer): string {
  const originalPrice = formatCurrency(offer.price, offer.currency);
  if (offer.currency === "RUB" || offer.priceRoubles === undefined) return originalPrice;
  return `${originalPrice} (≈ ${formatRoubles(offer.priceRoubles)})`;
}

function formatCurrency(value: number, currency: string): string {
  if (currency === "RUB") return formatRoubles(value);
  if (currency === "USD") return `$${value.toLocaleString("en-US")}`;
  if (currency === "EUR") return `€${value.toLocaleString("en-US")}`;
  return `${value.toLocaleString("en-US")} ${currency}`;
}
