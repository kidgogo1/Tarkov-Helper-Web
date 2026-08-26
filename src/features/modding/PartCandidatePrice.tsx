import { formatRoubles } from "../../domain/item-prices";
import type { ProfileType } from "../../types/data";
import type { TraderOffer, WeaponCatalogItem } from "../../types/weapon-modding";
import {
  getBestTraderOffer,
  getProfileFleaPrice,
} from "./part-candidate-controls";

export function PartCandidatePrice({ activeProfile, item }: {
  activeProfile: ProfileType;
  item: WeaponCatalogItem;
}) {
  const trader = getBestTraderOffer(item, activeProfile);
  const flea = getProfileFleaPrice(item, activeProfile);
  return (
    <span className="modding-part-commerce">
      <span
        className="modding-price-cell trader"
        data-empty={trader ? undefined : "true"}
        data-price-kind="trader"
      >
        <small className="modding-price-label">
          {trader ? `상점 · ${trader.traderName} LL${trader.loyaltyLevel}` : "상점 정보 없음"}
        </small>
        <strong className="modding-price-value">
          {trader ? formatTraderOfferPrice(trader) : "—"}
        </strong>
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
      >
        <small className="modding-price-label">
          {flea
            ? `플리 참고가${flea.minimumPlayerLevel ? ` · Lv.${flea.minimumPlayerLevel}` : ""}`
            : "플리 정보 없음"}
        </small>
        <strong className="modding-price-value">
          {flea ? formatRoubles(flea.price) : "—"}
        </strong>
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
