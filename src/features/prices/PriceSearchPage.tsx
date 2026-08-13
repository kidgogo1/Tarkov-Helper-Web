import { BadgeRussianRuble, LoaderCircle, Search, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { searchPriceCatalog, selectCatalogSnapshot } from "../../domain/item-prices";
import {
  fetchItemPriceQuote,
  loadItemPriceCatalog,
  type ItemPriceQuoteFailureHandler,
} from "../../services/item-prices";
import { recordClientDiagnostic } from "../../services/client-diagnostics";
import type { ProfileType } from "../../types/data";
import type { ItemPriceCatalog, ItemPriceCatalogItem, LiveItemPriceQuote } from "../../types/prices";
import { PriceDetails } from "./PriceDetails";

type PriceQuoteRequest = (
  itemId: string,
  mode: ProfileType,
  signal?: AbortSignal,
  onFailure?: ItemPriceQuoteFailureHandler,
) => Promise<LiveItemPriceQuote | null>;

const fetchLiveQuote: PriceQuoteRequest = (itemId, mode, signal, onFailure) =>
  fetchItemPriceQuote(itemId, mode, signal, globalThis.fetch, onFailure);

interface PriceSearchPageProps {
  activeProfile: ProfileType;
  loadCatalog?: (signal?: AbortSignal) => Promise<ItemPriceCatalog>;
  fetchQuote?: PriceQuoteRequest;
}

export function PriceSearchPage({
  activeProfile,
  loadCatalog = loadItemPriceCatalog,
  fetchQuote = fetchLiveQuote,
}: PriceSearchPageProps) {
  const [catalog, setCatalog] = useState<ItemPriceCatalog | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [searchText, setSearchText] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const [quote, setQuote] = useState<LiveItemPriceQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [liveAttempted, setLiveAttempted] = useState(false);
  const [quoteRequestKey, setQuoteRequestKey] = useState<string>();
  const quoteGeneration = useRef(0);
  const resultRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const controller = new AbortController();
    loadCatalog(controller.signal).then(setCatalog).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      recordClientDiagnostic({
        source: "optional-resource",
        code: "PRICE_CATALOG_LOAD_FAILED",
        level: "warning",
        error,
        message: "포함된 시세 카탈로그를 불러오지 못했습니다.",
      });
      setLoadError(error instanceof Error ? error.message : "시세 카탈로그를 불러오지 못했습니다.");
    });
    return () => controller.abort();
  }, [loadCatalog]);

  const results = useMemo(
    () => catalog ? searchPriceCatalog(catalog.items, searchText) : [],
    [catalog, searchText],
  );
  const selectedItem = useMemo(
    () => catalog?.items.find((item) => item.id === selectedId),
    [catalog, selectedId],
  );

  const refreshQuote = (item: ItemPriceCatalogItem) => {
    const controller = new AbortController();
    const generation = ++quoteGeneration.current;
    setQuoteRequestKey(`${item.id}:${activeProfile}`);
    setQuoteLoading(true);
    setLiveAttempted(false);
    setQuote(null);
    const recordQuoteFailure: ItemPriceQuoteFailureHandler = () => {
      recordClientDiagnostic({
        source: "optional-resource",
        code: "PRICE_QUOTE_FETCH_FAILED",
        level: "warning",
        message: "A live item price quote request failed.",
        operation: "FETCH_LIVE_QUOTE",
      });
    };
    fetchQuote(item.id, activeProfile, controller.signal, recordQuoteFailure)
      .then((nextQuote) => {
        if (quoteGeneration.current !== generation) return;
        setQuote(nextQuote);
        setLiveAttempted(true);
      })
      .catch((error: unknown) => {
        if (quoteGeneration.current !== generation) return;
        const wasCancelled = controller.signal.aborted ||
          (error instanceof DOMException && error.name === "AbortError");
        if (!wasCancelled) recordQuoteFailure("REQUEST_FAILED");
        setQuote(null);
        setLiveAttempted(true);
      })
      .finally(() => {
        if (quoteGeneration.current === generation) setQuoteLoading(false);
      });
    return () => controller.abort();
  };

  useEffect(() => {
    if (!selectedItem) return;
    let cancelRequest: (() => void) | undefined;
    const timer = window.setTimeout(() => {
      cancelRequest = refreshQuote(selectedItem);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      cancelRequest?.();
    };
    // The request must refresh whenever the active PVP/PVE profile changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProfile, selectedItem]);

  const handleResultKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowDown") nextIndex = Math.min(index + 1, results.length - 1);
    else if (event.key === "ArrowUp") nextIndex = Math.max(index - 1, 0);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = results.length - 1;
    else return;
    event.preventDefault();
    resultRefs.current[nextIndex]?.focus();
  };

  if (loadError) {
    return <section className="prices-page"><div className="prices-load-state error"><TriangleAlert aria-hidden="true" /><strong>시세 데이터를 불러오지 못했습니다.</strong><span>{loadError}</span></div></section>;
  }
  if (!catalog) {
    return <section className="prices-page"><div className="prices-load-state"><LoaderCircle aria-hidden="true" className="spin" /><strong>시세 카탈로그를 준비하는 중입니다.</strong></div></section>;
  }

  return (
    <section className="prices-page" aria-labelledby="prices-title">
      <header className="prices-page-header">
        <div>
          <p className="section-title">FLEA MARKET</p>
          <h1 id="prices-title">아이템 시세 검색</h1>
          <p>한글·영문·약칭으로 검색하고 현재 {activeProfile.toUpperCase()} 시세를 확인합니다.</p>
        </div>
        <div className="prices-catalog-stat"><BadgeRussianRuble aria-hidden="true" size={18} /><strong>{catalog.meta.itemCount.toLocaleString("ko-KR")}</strong><span>개 아이템</span></div>
      </header>

      <div className="prices-workspace">
        <aside className="price-search-panel" aria-label="아이템 시세 검색 결과">
          <label className="price-search-field">
            <Search aria-hidden="true" size={18} />
            <span className="sr-only">아이템 시세 검색</span>
            <input
              aria-label="아이템 시세 검색"
              autoComplete="off"
              onChange={(event) => setSearchText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && results.length) {
                  event.preventDefault();
                  resultRefs.current[0]?.focus();
                }
              }}
              placeholder="아이템 이름, 영문명, 약칭 검색"
              type="search"
              value={searchText}
            />
          </label>

          {!searchText.trim() ? <p className="price-search-help">검색어를 입력하면 서버 요청 없이 즉시 검색합니다.</p> : null}
          {searchText.trim() && !results.length ? <p className="price-search-empty">검색 결과가 없습니다.</p> : null}
          {results.length ? (
            <ul className="price-search-results">
              {results.map((item, index) => {
                const snapshot = selectCatalogSnapshot(item, activeProfile);
                return (
                  <li key={item.id}>
                    <button
                      aria-label={`${item.nameKo} (${item.nameEn})`}
                      className={selectedId === item.id ? "active" : ""}
                      onClick={() => setSelectedId(item.id)}
                      onKeyDown={(event) => handleResultKeyDown(event, index)}
                      ref={(element) => {
                        resultRefs.current[index] = element;
                      }}
                      type="button"
                    >
                      {item.localIcon ? <img alt="" src={`${import.meta.env.BASE_URL}${item.localIcon}`} /> : <span aria-hidden="true" className="price-result-icon">₽</span>}
                      <span><strong>{item.nameKo}</strong><small>{item.nameEn}</small></span>
                      <b>{snapshot?.lastLowPrice == null ? "—" : `₽${snapshot.lastLowPrice.toLocaleString("en-US")}`}</b>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </aside>

        <div className="price-detail-panel">
          {selectedItem ? (
            <PriceDetails
              item={selectedItem}
              liveAttempted={liveAttempted && quoteRequestKey === `${selectedItem.id}:${activeProfile}`}
              loading={quoteLoading}
              mode={activeProfile}
              onRefresh={() => refreshQuote(selectedItem)}
              quote={quoteRequestKey === `${selectedItem.id}:${activeProfile}` ? quote : null}
              snapshot={selectCatalogSnapshot(selectedItem, activeProfile)}
            />
          ) : (
            <div className="price-detail-placeholder"><BadgeRussianRuble aria-hidden="true" size={34} /><strong>아이템을 선택하세요.</strong><span>출시 시점 스냅샷은 항상 표시되며, 바로 실행 버전은 최신 시세도 확인합니다.</span></div>
          )}
        </div>
      </div>
      <p className="price-disclaimer">시세는 참고용이며 실제 게임 내 거래가는 빠르게 달라질 수 있습니다. 검색어와 진행 정보는 외부로 전송되지 않습니다.</p>
    </section>
  );
}
