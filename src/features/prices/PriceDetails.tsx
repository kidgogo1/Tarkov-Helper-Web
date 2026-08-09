import { ExternalLink, RefreshCw, TriangleAlert } from "lucide-react";

import { formatPriceTime, formatRoubles } from "../../domain/item-prices";
import type { ProfileType } from "../../types/data";
import type { ItemPriceCatalogItem, ItemPriceSnapshot, LiveItemPriceQuote } from "../../types/prices";

interface PriceDetailsProps {
  item: ItemPriceCatalogItem;
  mode: ProfileType;
  snapshot: ItemPriceSnapshot | undefined;
  quote: LiveItemPriceQuote | null;
  liveAttempted: boolean;
  loading: boolean;
  onRefresh: () => void;
}

export function PriceDetails({
  item,
  mode,
  snapshot,
  quote,
  liveAttempted,
  loading,
  onRefresh,
}: PriceDetailsProps) {
  const price = quote?.flea ?? snapshot;
  const sourceLabel = quote
    ? quote.source === "LIVE" ? "실시간" : quote.isStale ? "오래된 로컬 캐시" : "로컬 캐시"
    : "번들 스냅샷";

  return (
    <article className="price-detail" aria-labelledby="price-detail-title">
      <header className="price-detail-header">
        <div className="price-item-identity">
          {item.localIcon ? (
            <img alt="" src={`${import.meta.env.BASE_URL}${item.localIcon}`} />
          ) : <div aria-hidden="true" className="price-item-placeholder">₽</div>}
          <div>
            <span className={`price-mode-badge ${mode}`}>{mode.toUpperCase()}</span>
            <h2 id="price-detail-title">{item.nameKo}</h2>
            <p>{item.nameEn}</p>
          </div>
        </div>
        <button disabled={loading} onClick={onRefresh} type="button">
          <RefreshCw aria-hidden="true" className={loading ? "spin" : undefined} size={16} />
          {loading ? "확인 중" : "실시간 새로고침"}
        </button>
      </header>

      <div className="price-source-line" role="status">
        <span className={quote?.isStale ? "stale" : ""}>{sourceLabel}</span>
        <span>{formatPriceTime(quote?.flea.updatedAt ?? snapshot?.updatedAt)}</span>
      </div>

      {liveAttempted && !quote ? (
        <p className="price-fallback-note">
          <TriangleAlert aria-hidden="true" size={15} />
          실시간 시세를 사용할 수 없어 앱에 포함된 번들 시세를 표시합니다.
        </p>
      ) : null}

      <dl className="price-metrics">
        <Metric emphasis label="현재 최저가" value={formatRoubles(price?.lastLowPrice)} />
        <Metric label="24시간 평균" value={formatRoubles(price?.avg24hPrice)} />
        <Metric label="24시간 최저" value={formatRoubles(price?.low24hPrice)} />
        <Metric label="24시간 최고" value={formatRoubles(price?.high24hPrice)} />
        <Metric
          label="48시간 변동"
          value={price?.changeLast48hPercent == null ? "—" : `${price.changeLast48hPercent > 0 ? "+" : ""}${price.changeLast48hPercent.toFixed(2)}%`}
        />
        <Metric label="등록 매물" value={price?.offerCount == null ? "—" : `${price.offerCount.toLocaleString("ko-KR")}개`} />
      </dl>

      {snapshot?.bestTraderOffer ? (
        <div className="price-trader-offer">
          <span>상인 최고 매입가</span>
          <strong>{formatRoubles(snapshot.bestTraderOffer.priceRUB)}</strong>
        </div>
      ) : null}

      <footer className="price-links">
        {item.tarkovDevLink ? <a href={item.tarkovDevLink} rel="noreferrer" target="_blank">Tarkov.dev <ExternalLink aria-hidden="true" size={14} /></a> : null}
        {item.wikiLink ? <a href={item.wikiLink} rel="noreferrer" target="_blank">위키 <ExternalLink aria-hidden="true" size={14} /></a> : null}
      </footer>
    </article>
  );
}

function Metric({ emphasis = false, label, value }: { emphasis?: boolean; label: string; value: string }) {
  return <div className={emphasis ? "emphasis" : ""}><dt>{label}</dt><dd>{value}</dd></div>;
}
