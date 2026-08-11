import {
  Check,
  CircleDashed,
  ClipboardList,
  ExternalLink,
  Hammer,
  Package,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { EmptyState } from "../../components/EmptyState";
import { QuantityStepper } from "../../components/QuantityStepper";
import {
  filterAndSortItems,
  formatCountDisplay,
  formatOwnedDisplay,
  type AggregatedItemRequirement,
  type ItemFilterOptions,
} from "../../domain/items";
import type { ItemData } from "../../types/data";
import type { InventoryAmount } from "../../types/state";
import { ItemMarketSummary } from "./ItemMarketSummary";

interface ItemTrackerViewProps {
  items: readonly AggregatedItemRequirement[];
  itemData: readonly ItemData[];
  focusItemId?: string;
  focusRequested?: boolean;
  onItemFocusConsumed?: () => void;
  onItemSelect?: (itemId: string, preserveFocus?: boolean) => void;
  onInventoryChange: (itemId: string, amount: InventoryAmount) => void;
  onOpenQuest?: (questId: string) => void;
  onOpenHideout?: (stationId: string, level?: number) => void;
  listLabel: string;
  showSourceFilter?: boolean;
  showCategoryFilter?: boolean;
  showHideoutSort?: boolean;
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  Provisions: "식량",
  Medical: "의료",
  Gear: "장비",
  Barter: "교환 물품",
  "Info & Keys": "정보·열쇠",
  Containers: "보관함",
  Money: "화폐",
  Ammo: "탄약",
  "Weapon Mods": "무기 부품",
  Optics: "조준경",
  Tactical: "전술 장비",
  "Helmet Mods": "헬멧 부품",
  Weapons: "무기",
  "Quest Items": "퀘스트 아이템",
  Misc: "기타",
  Other: "기타",
};

function localizeCategory(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

function localizeItemRequirements(
  requirements: readonly AggregatedItemRequirement[],
  items: readonly ItemData[],
): AggregatedItemRequirement[] {
  const lookup = new Map(items.map((item) => [item.id, item]));
  return requirements.map((requirement) => {
    const item = lookup.get(requirement.itemId);
    const displayName = item?.nameKo?.trim() || item?.name || requirement.displayName;
    const englishName = item?.nameEn?.trim() || item?.name || requirement.displayName;
    return {
      ...requirement,
      displayName,
      subtitleName: englishName === displayName ? "" : englishName,
    };
  });
}

export function ItemTrackerView({
  items,
  itemData,
  focusItemId,
  focusRequested: requestedFocus,
  onItemFocusConsumed,
  onItemSelect,
  onInventoryChange,
  onOpenQuest,
  onOpenHideout,
  listLabel,
  showSourceFilter = true,
  showCategoryFilter = true,
  showHideoutSort = true,
}: ItemTrackerViewProps) {
  const focusRequested = requestedFocus ?? Boolean(focusItemId);
  const [searchText, setSearchText] = useState("");
  const [source, setSource] = useState<ItemFilterOptions["source"]>("all");
  const [category, setCategory] = useState("All");
  const [fulfillment, setFulfillment] =
    useState<ItemFilterOptions["fulfillment"]>("all");
  const [sortBy, setSortBy] = useState<ItemFilterOptions["sortBy"]>("name");
  const [firOnly, setFirOnly] = useState(false);
  const [hideFulfilled, setHideFulfilled] = useState(false);
  const initialFocusedItemId = focusItemId && items.some((item) => item.itemId === focusItemId)
    ? focusItemId
    : items[0]?.itemId ?? "";
  const [selectedItemId, setSelectedItemId] = useState(initialFocusedItemId);
  const routeFocusKey = `${focusItemId ?? ""}:${focusRequested ? "focus" : "selection"}`;
  const [handledItemFocusKey, setHandledItemFocusKey] = useState(routeFocusKey);
  const consumedItemFocusRef = useRef<string | undefined>(undefined);
  const itemButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const localizedItems = useMemo(
    () => localizeItemRequirements(items, itemData),
    [itemData, items],
  );
  const categories = useMemo(
    () =>
      Array.from(
        new Set(localizedItems.map((item) => item.parentCategory)),
      ).sort(),
    [localizedItems],
  );
  const focusedItem = localizedItems.find((item) => item.itemId === focusItemId);

  if (routeFocusKey !== handledItemFocusKey) {
    setHandledItemFocusKey(routeFocusKey);
    if (focusedItem && selectedItemId !== focusedItem.itemId) {
      if (focusRequested) {
        setSearchText("");
        setSource("all");
        setCategory("All");
        setFulfillment("all");
        setSortBy("name");
        setFirOnly(false);
        setHideFulfilled(false);
      }
      setSelectedItemId(focusedItem.itemId);
    }
  }

  const filteredItems = useMemo(
    () =>
      filterAndSortItems(localizedItems, {
        searchText,
        source,
        category,
        fulfillment,
        firOnly,
        hideFulfilled,
        sortBy,
      }),
    [
      category,
      firOnly,
      fulfillment,
      hideFulfilled,
      localizedItems,
      searchText,
      sortBy,
      source,
    ],
  );
  const selectedItem =
    filteredItems.find((item) => item.itemId === selectedItemId) ??
    filteredItems[0] ??
    null;

  const nextSelectedItemId = selectedItem?.itemId;
  if (nextSelectedItemId && nextSelectedItemId !== selectedItemId) {
    setSelectedItemId(nextSelectedItemId);
  }

  const selectedItemRouteId = selectedItem?.itemId;
  useEffect(() => {
    if (selectedItemRouteId && selectedItemRouteId !== focusItemId) {
      const preserveFocus = focusRequested && focusedItem?.itemId === selectedItemRouteId;
      onItemSelect?.(selectedItemRouteId, preserveFocus);
    }
  }, [focusItemId, focusRequested, focusedItem?.itemId, onItemSelect, selectedItemRouteId]);

  useEffect(() => {
    if (!focusRequested || !focusItemId) {
      consumedItemFocusRef.current = undefined;
      return;
    }
    if (consumedItemFocusRef.current === focusItemId) return;
    consumedItemFocusRef.current = focusItemId;
    const button = itemButtonRefs.current.get(focusItemId);
    button?.scrollIntoView?.({ block: "nearest" });
    button?.focus();
    onItemFocusConsumed?.();
  }, [focusItemId, focusRequested, onItemFocusConsumed]);

  return (
    <div className="item-tracker">
      <div className="item-filter-bar panel">
        <label className="item-search-field">
          <Search aria-hidden="true" size={16} />
          <span className="sr-only">아이템 검색</span>
          <input
            aria-label="아이템 검색"
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="한글·영문·약칭 검색"
            type="search"
            value={searchText}
          />
        </label>

        <div className="item-select-filters">
          {showSourceFilter ? (
            <label>
              <span>출처</span>
              <select
                aria-label="아이템 출처"
                onChange={(event) =>
                  setSource(event.target.value as ItemFilterOptions["source"])
                }
                value={source}
              >
                <option value="all">전체</option>
                <option value="quest">퀘스트</option>
                <option value="hideout">은신처</option>
              </select>
            </label>
          ) : null}
          {showCategoryFilter ? (
            <label>
              <span>분류</span>
              <select
                aria-label="아이템 분류"
                onChange={(event) => setCategory(event.target.value)}
                value={category}
              >
                <option value="All">전체</option>
                {categories.map((value) => (
                  <option key={value} value={value}>{localizeCategory(value)}</option>
                ))}
              </select>
            </label>
          ) : null}
          <label>
            <span>상태</span>
            <select
              aria-label="충족 상태"
              onChange={(event) =>
                setFulfillment(
                  event.target.value as ItemFilterOptions["fulfillment"],
                )
              }
              value={fulfillment}
            >
              <option value="all">모든 상태</option>
              <option value="notStarted">미수집</option>
              <option value="inProgress">진행 중</option>
              <option value="fulfilled">완료</option>
            </select>
          </label>
          <label>
            <span>정렬</span>
            <select
              aria-label="아이템 정렬"
              onChange={(event) =>
                setSortBy(event.target.value as ItemFilterOptions["sortBy"])
              }
              value={sortBy}
            >
              <option value="name">이름</option>
              <option value="total">총 필요량</option>
              <option value="quest">퀘스트 필요량</option>
              {showHideoutSort ? <option value="hideout">은신처 필요량</option> : null}
              <option value="progress">진행률</option>
            </select>
          </label>
        </div>

        <div className="item-check-filters">
          <label>
            <input
              checked={firOnly}
              onChange={(event) => setFirOnly(event.target.checked)}
              type="checkbox"
            />
            FIR만
          </label>
          <label>
            <input
              checked={hideFulfilled}
              onChange={(event) => setHideFulfilled(event.target.checked)}
              type="checkbox"
            />
            충족 숨기기
          </label>
        </div>
      </div>

      {filteredItems.length ? (
        <div className="item-workspace">
          <section className="item-list-panel panel" aria-label={listLabel}>
            <div className="item-list-summary">
              <span><strong>{filteredItems.length}</strong> / {localizedItems.length}종</span>
              <span>필요 {filteredItems.reduce((sum, item) => sum + item.totalCount, 0)}개</span>
            </div>
            <ul className="item-list">
              {filteredItems.map((item) => (
                <ItemListRow
                  buttonRef={(button) => {
                    if (button) itemButtonRefs.current.set(item.itemId, button);
                    else itemButtonRefs.current.delete(item.itemId);
                  }}
                  item={item}
                  key={item.itemId}
                  onSelect={() => {
                    setHandledItemFocusKey(`${item.itemId}:selection`);
                    setSelectedItemId(item.itemId);
                    onItemSelect?.(item.itemId);
                  }}
                  selected={selectedItem?.itemId === item.itemId}
                />
              ))}
            </ul>
          </section>

          <ItemDetail
            item={selectedItem!}
            onInventoryChange={onInventoryChange}
            onOpenHideout={onOpenHideout}
            onOpenQuest={onOpenQuest}
          />
        </div>
      ) : (
        <div className="item-empty panel" role="status">
          <EmptyState
            icon={<Search size={26} />}
            title="조건에 맞는 아이템이 없습니다"
            description="검색어나 필터를 바꿔 다시 확인해 보세요."
          />
        </div>
      )}
    </div>
  );
}

function ItemListRow({
  buttonRef,
  item,
  selected,
  onSelect,
}: {
  buttonRef: (button: HTMLButtonElement | null) => void;
  item: AggregatedItemRequirement;
  selected: boolean;
  onSelect: () => void;
}) {
  const isReferenceOnly = item.allRequiredCount === 0;
  return (
    <li>
      <button
        aria-label={`${item.displayName} 상세 보기`}
        aria-pressed={selected}
        className={selected ? "selected" : ""}
        onClick={onSelect}
        ref={buttonRef}
        type="button"
      >
        <ItemIcon item={item} />
        <span className="item-list-name">
          <strong>{item.displayName}</strong>
          {item.subtitleName ? <small>{item.subtitleName}</small> : null}
        </span>
        <span className="item-list-counts">
          <strong>
            {item.totalCount > 0
              ? `${formatCountDisplay(item.totalCount, item.totalFirCount)} 필요`
              : `완료 ${formatCountDisplay(item.allRequiredCount, item.allRequiredFirCount)}`}
          </strong>
          <small>보유 {formatOwnedDisplay({ fir: item.ownedFir, nonFir: item.ownedNonFir })}</small>
        </span>
        <span
          aria-label={isReferenceOnly ? "참조 아이템" : item.isFulfilled ? "충족" : "미충족"}
          className={`item-status-icon${item.isFulfilled && !isReferenceOnly ? " fulfilled" : ""}`}
          role="img"
        >
          {isReferenceOnly ? (
            <Package aria-hidden="true" size={15} />
          ) : item.isFulfilled ? (
            <Check aria-hidden="true" size={15} />
          ) : (
            <CircleDashed aria-hidden="true" size={15} />
          )}
        </span>
      </button>
    </li>
  );
}

function ItemDetail({
  item,
  onInventoryChange,
  onOpenQuest,
  onOpenHideout,
}: {
  item: AggregatedItemRequirement;
  onInventoryChange: (itemId: string, amount: InventoryAmount) => void;
  onOpenQuest?: (questId: string) => void;
  onOpenHideout?: (stationId: string, level?: number) => void;
}) {
  const inventory = { fir: item.ownedFir, nonFir: item.ownedNonFir };
  const isReferenceOnly = item.allRequiredCount === 0;
  const statusLabel = isReferenceOnly
    ? "참조"
    : item.isFulfilled
    ? "충족"
    : item.fulfillmentStatus === "partiallyFulfilled"
      ? "진행 중"
      : "미수집";

  return (
    <aside className="item-detail panel" aria-label="아이템 상세" aria-live="polite">
      <header className="item-detail-header">
        <ItemIcon item={item} large />
        <div>
          <span className="eyebrow">아이템 요구 사항</span>
          <h2>{item.displayName}</h2>
          {item.subtitleName ? <p>{item.subtitleName}</p> : null}
        </div>
        <span className={`badge${item.isFulfilled && !isReferenceOnly ? " success" : ""}`}>{statusLabel}</span>
      </header>

      <div className="item-detail-metrics">
        <span><small>전체 필요</small><strong>{formatCountDisplay(item.allRequiredCount, item.allRequiredFirCount)}</strong></span>
        <span><small>완료 처리</small><strong>{formatCountDisplay(item.completedCount, item.completedFirCount)}</strong></span>
        <span><small>남은 필요</small><strong>{formatCountDisplay(item.totalCount, item.totalFirCount)}</strong></span>
        <span><small>부족</small><strong>{item.shortage}</strong></span>
      </div>

      <ItemMarketSummary
        itemEnglishName={item.subtitleName}
        itemId={item.itemId}
        itemName={item.displayName}
        remainingCount={item.totalCount}
      />

      {isReferenceOnly ? (
        <p className="item-reference-note">현재 남은 요구 사항 없음</p>
      ) : null}

      <section className="item-inventory-section">
        <div className="item-section-heading">
          <div>
            <h3>보유 수량</h3>
            <p>FIR과 일반 아이템을 프로필별로 기록합니다.</p>
          </div>
          <strong>{isReferenceOnly ? "—" : `${item.progressPercent.toFixed(0)}%`}</strong>
        </div>
        {!isReferenceOnly ? (
          <progress aria-label={`${item.displayName} 충족 진행률`} max={100} value={item.progressPercent} />
        ) : null}
        <div className="item-inventory-editors">
          <div className="item-inventory-editor fir">
            <span>FIR</span>
            <QuantityStepper
              compact
              label={`${item.displayName} FIR 보유량`}
              onChange={(fir) => onInventoryChange(item.itemId, { ...inventory, fir })}
              value={inventory.fir}
            />
          </div>
          <div className="item-inventory-editor">
            <span>일반</span>
            <QuantityStepper
              compact
              label={`${item.displayName} 일반 보유량`}
              onChange={(nonFir) =>
                onInventoryChange(item.itemId, { ...inventory, nonFir })
              }
              value={inventory.nonFir}
            />
          </div>
        </div>
      </section>

      <div className="item-source-columns">
        <SourceSection
          icon={<ClipboardList aria-hidden="true" size={15} />}
          title="퀘스트 출처"
        >
          <SourceGroup emptyText="남은 퀘스트 요구 사항이 없습니다." title="남은 요구">
            {item.questSources.map((source, index) => (
              <ItemSourceRow
                key={`${source.questId}-${index}`}
                label={`${source.questName} 퀘스트 열기`}
                onOpen={onOpenQuest ? () => onOpenQuest(source.questId) : undefined}
              >
                <span>
                  <strong>{source.questName}</strong>
                  <small>{source.traderName}</small>
                </span>
                <span className="source-badges">
                  {source.kappaRequired ? <span className="badge kappa">카파 필수</span> : null}
                  {source.requiresFir ? <span className="badge danger">FIR</span> : null}
                  <strong>x{source.requiredCount}</strong>
                </span>
              </ItemSourceRow>
            ))}
          </SourceGroup>
          <SourceGroup completed emptyText="완료한 퀘스트 요구 사항이 없습니다." title="완료 기록">
            {item.completedQuestSources.map((source, index) => (
              <ItemSourceRow
                key={`${source.questId}-${index}`}
                label={`${source.questName} 퀘스트 열기`}
                onOpen={onOpenQuest ? () => onOpenQuest(source.questId) : undefined}
              >
                <span>
                  <strong>{source.questName}</strong>
                  <small>{source.traderName}</small>
                </span>
                <span className="source-badges">
                  {source.kappaRequired ? <span className="badge kappa">카파 필수</span> : null}
                  {source.requiresFir ? <span className="badge danger">FIR</span> : null}
                  <strong>x{source.requiredCount}</strong>
                </span>
              </ItemSourceRow>
            ))}
          </SourceGroup>
        </SourceSection>

        <SourceSection
          icon={<Hammer aria-hidden="true" size={15} />}
          title="은신처 출처"
        >
          <SourceGroup emptyText="남은 은신처 요구 사항이 없습니다." title="남은 요구">
            {item.hideoutSources.map((source, index) => (
              <ItemSourceRow
                key={`${source.stationId}-${source.level}-${index}`}
                label={`${source.stationName} 은신처 열기`}
                onOpen={onOpenHideout ? () => onOpenHideout(source.stationId, source.level) : undefined}
              >
                <span>
                  <strong>{source.stationName}</strong>
                  <small>레벨 {source.level}</small>
                </span>
                <span className="source-badges">
                  {source.requiresFir ? <span className="badge danger">FIR</span> : null}
                  <strong>x{source.requiredCount}</strong>
                </span>
              </ItemSourceRow>
            ))}
          </SourceGroup>
          <SourceGroup completed emptyText="완료한 은신처 요구 사항이 없습니다." title="완료 기록">
            {item.completedHideoutSources.map((source, index) => (
              <ItemSourceRow
                key={`${source.stationId}-${source.level}-${index}`}
                label={`${source.stationName} 은신처 열기`}
                onOpen={onOpenHideout ? () => onOpenHideout(source.stationId, source.level) : undefined}
              >
                <span>
                  <strong>{source.stationName}</strong>
                  <small>레벨 {source.level}</small>
                </span>
                <span className="source-badges">
                  {source.requiresFir ? <span className="badge danger">FIR</span> : null}
                  <strong>x{source.requiredCount}</strong>
                </span>
              </ItemSourceRow>
            ))}
          </SourceGroup>
        </SourceSection>
      </div>

      {item.wikiPageLink ? (
        <footer className="item-detail-footer">
          <a
            className="button"
            href={item.wikiPageLink}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" size={14} /> 위키 열기
          </a>
        </footer>
      ) : null}
    </aside>
  );
}

function ItemIcon({
  item,
  large = false,
}: {
  item: AggregatedItemRequirement;
  large?: boolean;
}) {
  return (
    <span className={`item-icon${large ? " large" : ""}`}>
      {item.localIcon ? (
        <img alt="" src={item.localIcon} />
      ) : (
        <Package aria-hidden="true" size={large ? 26 : 19} />
      )}
    </span>
  );
}

function SourceSection({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="item-source-section">
      <h3>{icon}{title}</h3>
      {children}
    </section>
  );
}

function SourceGroup({
  title,
  completed = false,
  emptyText,
  children,
}: {
  title: string;
  completed?: boolean;
  emptyText: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <div className={`item-source-group${completed ? " completed" : ""}`}>
      <h4>{title}</h4>
      {hasChildren ? children : <p className="item-source-empty">{emptyText}</p>}
    </div>
  );
}

function ItemSourceRow({
  children,
  label,
  onOpen,
}: {
  children: React.ReactNode;
  label: string;
  onOpen?: () => void;
}) {
  if (!onOpen) return <div className="item-source-row">{children}</div>;

  return (
    <button aria-label={label} className="item-source-row" onClick={onOpen} type="button">
      {children}
    </button>
  );
}
