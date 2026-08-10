import { CircleDollarSign, Database, Radio, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { formatPriceTime, formatRoubles } from "../../domain/item-prices";
import { loadItemPriceCatalog, fetchItemPriceQuote } from "../../services/item-prices";
import type { ProfileType } from "../../types/data";
import type {
  ItemPriceCatalogItem,
  ItemPriceSnapshot,
  LiveItemPriceQuote,
} from "../../types/prices";

interface ItemMarketSummaryProps {
  itemId: string;
  itemName: string;
  itemEnglishName?: string;
  remainingCount: number;
}

type MarketMode = ProfileType;

interface ModePrice {
  snapshot?: ItemPriceSnapshot;
  quote: LiveItemPriceQuote | null;
}

interface MarketState {
  loading: boolean;
  catalogItem?: ItemPriceCatalogItem;
  prices: Partial<Record<MarketMode, ModePrice>>;
  unavailable: boolean;
}

const MODES: readonly MarketMode[] = ["pvp", "pve"];

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

function findCatalogItem(
  items: readonly ItemPriceCatalogItem[],
  itemId: string,
  itemName: string,
  itemEnglishName?: string,
): ItemPriceCatalogItem | undefined {
  const candidates = [itemId, itemName, itemEnglishName]
    .filter((value): value is string => Boolean(value?.trim()))
    .map(normalize);
  if (!candidates.length) return undefined;
  return items.find((item) => [item.id, item.nameKo, item.nameEn, item.shortNameKo, item.shortNameEn, item.normalizedName]
    .some((value) => candidates.includes(normalize(value))));
}

function getPrice(modePrice: ModePrice | undefined): ItemPriceSnapshot | undefined {
  return modePrice?.quote?.flea ?? modePrice?.snapshot;
}

function sourceLabel(modePrice: ModePrice | undefined): string {
  if (modePrice?.quote) {
    if (modePrice.quote.source === "LIVE") return "실시간";
    if (modePrice.quote.source === "STALE_CACHE" || modePrice.quote.isStale) return "오래된 캐시";
    return "로컬 캐시";
  }
  return "번들 시세";
}

export function ItemMarketSummary({
  itemId,
  itemName,
  itemEnglishName,
  remainingCount,
}: ItemMarketSummaryProps) {
  const [state, setState] = useState<MarketState>({
    loading: true,
    prices: {},
    unavailable: false,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    queueMicrotask(() => {
      if (active) setState({ loading: true, prices: {}, unavailable: false });
    });
    void (async () => {
      try {
        const catalog = await loadItemPriceCatalog(controller.signal);
        if (controller.signal.aborted || !active) return;

        const catalogItem = findCatalogItem(catalog.items, itemId, itemName, itemEnglishName);
        if (!catalogItem) {
          setState({ loading: false, prices: {}, unavailable: true });
          return;
        }

        const results = await Promise.all(MODES.map(async (mode) => ({
          mode,
          snapshot: catalogItem.prices[mode],
          quote: await fetchItemPriceQuote(catalogItem.id, mode, controller.signal),
        })));
        if (controller.signal.aborted || !active) return;

        setState({
          loading: false,
          catalogItem,
          prices: Object.fromEntries(results.map(({ mode, snapshot, quote }) => [mode, { snapshot, quote }])),
          unavailable: results.every(({ snapshot, quote }) => !snapshot && !quote),
        });
      } catch {
        if (controller.signal.aborted || !active) return;
        setState({ loading: false, prices: {}, unavailable: true });
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [itemEnglishName, itemId, itemName]);

  const count = Number.isFinite(remainingCount) ? Math.max(0, Math.floor(remainingCount)) : 0;
  const hasAnyPrice = MODES.some((mode) => Boolean(getPrice(state.prices[mode])));
  const itemLabel = state.catalogItem?.nameKo || itemName;

  return (
    <section className="item-market-summary" aria-label="시세 요약" aria-live="polite">
      <header className="item-market-summary-header">
        <div>
          <h3><CircleDollarSign aria-hidden="true" size={16} /> 시세 요약</h3>
          <p>남은 필요 수량 {count.toLocaleString("ko-KR")}개를 현재 시세로 계산한 예상 금액입니다.</p>
        </div>
        {state.catalogItem ? <small>업데이트 {formatPriceTime(state.catalogItem.prices.pvp?.updatedAt ?? state.catalogItem.prices.pve?.updatedAt)}</small> : null}
      </header>

      {state.loading ? <p className="item-market-status" role="status">시세를 불러오는 중입니다…</p> : null}
      {!state.loading && state.unavailable ? (
        <p className="item-market-status warning" role="status">
          <TriangleAlert aria-hidden="true" size={15} /> 이 아이템의 시세 정보가 없습니다.
        </p>
      ) : null}

      {!state.loading && !state.unavailable && hasAnyPrice ? (
        <div className="item-market-cards">
          {MODES.map((mode) => (
            <MarketModeCard
              count={count}
              itemLabel={itemLabel}
              key={mode}
              mode={mode}
              modePrice={state.prices[mode]}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function MarketModeCard({
  count,
  itemLabel,
  mode,
  modePrice,
}: {
  count: number;
  itemLabel: string;
  mode: MarketMode;
  modePrice: ModePrice | undefined;
}) {
  const price = getPrice(modePrice);
  const unitPrice = price?.lastLowPrice;
  const totalPrice = unitPrice == null ? undefined : unitPrice * count;
  const change = price?.changeLast48hPercent;

  const modeLabel = mode.toUpperCase();
  return (
    <article className={`item-market-card ${mode}`} aria-label={`${modeLabel} 시세`}>
      <header>
        <div>
          <h4>{modeLabel}</h4>
          <span>{sourceLabel(modePrice)}</span>
        </div>
        {modePrice?.quote ? <Radio aria-label="실시간 가격" className="item-market-live" size={14} /> : <Database aria-label="번들 가격" size={14} />}
      </header>

      <div className="item-market-primary">
        <div>
          <small>개당 현재 최저가</small>
          <strong>{formatRoubles(unitPrice)}</strong>
        </div>
        <div>
          <small>남은 필요 총액</small>
          <strong>{formatRoubles(totalPrice)}</strong>
        </div>
      </div>
      <p className="item-market-calculation">{itemLabel} {count.toLocaleString("ko-KR")}개 × 개당 가격</p>

      <dl className="item-market-stats">
        <MarketMetric label="24시간 평균" value={formatRoubles(price?.avg24hPrice)} />
        <MarketMetric label="24시간 최저" value={formatRoubles(price?.low24hPrice)} />
        <MarketMetric label="24시간 최고" value={formatRoubles(price?.high24hPrice)} />
        <MarketMetric label="48시간 변동" value={change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(2)}%`} />
        <MarketMetric label="등록 매물" value={price?.offerCount == null ? "—" : `${price.offerCount.toLocaleString("ko-KR")}개`} />
        <MarketMetric label="상인 최저가" value={formatRoubles(modePrice?.snapshot?.bestTraderOffer?.priceRUB)} />
        <MarketMetric label="갱신 시각" value={formatPriceTime(price?.updatedAt)} />
      </dl>
    </article>
  );
}

function MarketMetric({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
