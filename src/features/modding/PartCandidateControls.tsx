import {
  ArrowDown,
  ArrowUp,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import { useId, useState } from "react";
import { PartFilterPresets } from "./PartFilterPresets";

import {
  DEFAULT_PART_CANDIDATE_FILTERS,
  moveCandidateSort,
  type CandidateEffectFilter,
  type CandidateFeatureFilter,
  type CandidateSortKey,
  type PartCandidateFilters,
} from "./part-candidate-controls";

interface TraderOption {
  id: string;
  name: string;
}

interface PartCandidateControlsProps {
  filters: PartCandidateFilters;
  onFiltersChange: (filters: PartCandidateFilters) => void;
  onSortKeysChange: (sortKeys: CandidateSortKey[]) => void;
  sortKeys: readonly CandidateSortKey[];
  totalCount: number;
  traderOptions: readonly TraderOption[];
  visibleCount: number;
}

const EFFECT_FILTERS: ReadonlyArray<[CandidateEffectFilter, string]> = [
  ["recoil", "반동 감소"],
  ["ergonomics", "인체공학 증가"],
  ["lighter", "장착 후 경량화"],
  ["accuracy", "정확도 향상"],
  ["velocity", "탄속 증가"],
];

const FEATURE_FILTERS: ReadonlyArray<[CandidateFeatureFilter, string]> = [
  ["subslots", "추가 장착 슬롯 있음"],
  ["required-slots", "추가 필수 파츠 필요"],
];

const SORT_OPTIONS: ReadonlyArray<[CandidateSortKey, string]> = [
  ["availability", "바로 장착 가능한 순"],
  ["trader-price", "상점가 낮은 순"],
  ["flea-price", "플리 참고가 낮은 순"],
  ["recoil", "반동 감소 큰 순"],
  ["ergonomics", "인체공학 높은 순"],
  ["weight", "장착 후 가벼운 순"],
  ["accuracy", "정확도 향상 큰 순"],
  ["velocity", "탄속 증가 큰 순"],
  ["loyalty-level", "낮은 상인 LL 순"],
  ["name", "이름 가나다순"],
];

export function PartCandidateControls({
  filters,
  onFiltersChange,
  onSortKeysChange,
  sortKeys,
  totalCount,
  traderOptions,
  visibleCount,
}: PartCandidateControlsProps) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [sortNotice, setSortNotice] = useState("");
  const enabledSorts = new Set(sortKeys);
  const orderedSortOptions = [
    ...sortKeys.flatMap((sortKey) => {
      const option = SORT_OPTIONS.find(([key]) => key === sortKey);
      return option ? [option] : [];
    }),
    ...SORT_OPTIONS.filter(([sortKey]) => !enabledSorts.has(sortKey)),
  ];

  const updateFilters = (change: Partial<PartCandidateFilters>) => {
    onFiltersChange({ ...filters, ...change });
  };
  const toggleSort = (sortKey: CandidateSortKey) => {
    const nextKeys = sortKeys.includes(sortKey)
      ? sortKeys.filter((candidate) => candidate !== sortKey)
      : [...sortKeys, sortKey];
    onSortKeysChange(nextKeys);
    setSortNotice("");
  };
  const moveSort = (sortKey: CandidateSortKey, direction: -1 | 1) => {
    const nextKeys = moveCandidateSort(sortKeys, sortKey, direction);
    onSortKeysChange(nextKeys);
    const option = SORT_OPTIONS.find(([key]) => key === sortKey);
    const position = nextKeys.indexOf(sortKey) + 1;
    setSortNotice(`${option?.[1] ?? sortKey}이 ${position}순위가 되었습니다`);
  };
  const reset = () => {
    onFiltersChange({ ...DEFAULT_PART_CANDIDATE_FILTERS });
    onSortKeysChange([]);
    setSortNotice("필터와 정렬을 초기화했습니다");
  };

  return (
    <div className="modding-candidate-controls">
      <div className="modding-candidate-toolbar">
        <label>
          <Search aria-hidden="true" size={14} />
          <input
            aria-label="부품 검색"
            onChange={(event) => updateFilters({ query: event.target.value })}
            placeholder="이름·약칭 검색"
            type="search"
            value={filters.query}
          />
        </label>
        <button
          aria-controls={panelId}
          aria-expanded={open}
          aria-label="필터·정렬"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <SlidersHorizontal aria-hidden="true" size={14} />
          필터·정렬
          {activeControlCount(filters, sortKeys) > 0 ? (
            <strong>{activeControlCount(filters, sortKeys)}</strong>
          ) : null}
        </button>
      </div>

      {open ? (
        <section aria-label="부품 필터와 정렬" className="modding-filter-panel" id={panelId}>
          <PartFilterPresets filters={filters} sortKeys={sortKeys} traderOptions={traderOptions}
            onApply={(settings) => {
              onFiltersChange(settings.filters);
              onSortKeysChange(settings.sortKeys);
              setSortNotice("");
            }} />
          <div className="modding-filter-fields">
            <label>
              <span>장착 상태</span>
              <select
                aria-label="장착 상태"
                onChange={(event) => updateFilters({
                  availability: event.target.value as PartCandidateFilters["availability"],
                })}
                value={filters.availability}
              >
                <option value="all">전체</option>
                <option value="compatible">즉시 장착</option>
                <option value="auto-resolvable">충돌 자동 해제</option>
                <option value="blocked">장착 불가</option>
              </select>
            </label>
            <label>
              <span>상인</span>
              <select
                aria-label="상인"
                onChange={(event) => updateFilters({ traderId: event.target.value })}
                value={filters.traderId}
              >
                <option value="">전체 상인</option>
                {traderOptions.map((trader) => (
                  <option key={trader.id} value={trader.id}>{trader.name}</option>
                ))}
              </select>
            </label>
            <NumberFilter
              label="최대 상점가 (₽ 환산)"
              onChange={(maxTraderPrice) => updateFilters({ maxTraderPrice })}
              value={filters.maxTraderPrice}
            />
            <NumberFilter
              label="최대 플리 참고가"
              onChange={(maxFleaPrice) => updateFilters({ maxFleaPrice })}
              value={filters.maxFleaPrice}
            />
            <label>
              <span>퀘스트 해금</span>
              <select
                aria-label="퀘스트 해금"
                onChange={(event) => updateFilters({
                  questRequirement: event.target.value as PartCandidateFilters["questRequirement"],
                })}
                value={filters.questRequirement}
              >
                <option value="all">전체</option>
                <option value="not-required">퀘스트 불필요</option>
                <option value="required">퀘스트 필요</option>
              </select>
            </label>
            <label>
              <span>최대 상인 LL</span>
              <select
                aria-label="최대 상인 LL"
                onChange={(event) => updateFilters({
                  maxLoyaltyLevel: optionalNumber(event.target.value),
                })}
                value={filters.maxLoyaltyLevel ?? ""}
              >
                <option value="">전체</option>
                {[1, 2, 3, 4].map((level) => (
                  <option key={level} value={level}>{`LL ${level}`}</option>
                ))}
              </select>
            </label>
          </div>

          <p className="modding-filter-and-note">
            성능 필터·정렬은 현재 빌드에서 교체한 뒤의 변화 기준이며,
            복수 필터는 모두 충족해야 표시됩니다.
          </p>

          <FilterChecks
            filters={filters.purchaseFilters}
            legend="구매 정보"
            onChange={(purchaseFilters) => updateFilters({ purchaseFilters })}
            options={[["trader", "상점 가격 있음"], ["flea", "플리 참고가 있음"]]}
          />
          <FilterChecks
            filters={filters.effectFilters}
            legend="장착 후 성능 개선"
            onChange={(effectFilters) => updateFilters({ effectFilters })}
            options={EFFECT_FILTERS}
          />
          <FilterChecks
            filters={filters.featureFilters}
            legend="부품 구조"
            onChange={(featureFilters) => updateFilters({ featureFilters })}
            options={FEATURE_FILTERS}
          />

          <section aria-label="정렬 우선순위" className="modding-sort-priorities">
            <header>
              <strong>정렬 우선순위</strong>
              <small>2순위부터는 앞 기준이 같을 때 적용</small>
            </header>
            <ol>
              {orderedSortOptions.map(([sortKey, label]) => {
                const index = sortKeys.indexOf(sortKey);
                const enabled = index >= 0;
                return (
                  <li className={enabled ? "enabled" : ""} key={sortKey}>
                    <label>
                      <input
                        checked={enabled}
                        onChange={() => toggleSort(sortKey)}
                        type="checkbox"
                      />
                      <span>{label}</span>
                    </label>
                    {enabled ? <strong>{index + 1}순위</strong> : null}
                    <button
                      aria-label={`${label} 우선순위 올리기`}
                      disabled={!enabled || index === 0}
                      onClick={() => moveSort(sortKey, -1)}
                      type="button"
                    ><ArrowUp aria-hidden="true" size={13} /></button>
                    <button
                      aria-label={`${label} 우선순위 내리기`}
                      disabled={!enabled || index === sortKeys.length - 1}
                      onClick={() => moveSort(sortKey, 1)}
                      type="button"
                    ><ArrowDown aria-hidden="true" size={13} /></button>
                  </li>
                );
              })}
            </ol>
          </section>

          <footer>
            <span>{`${visibleCount} / ${totalCount}개 표시`}</span>
            <button onClick={reset} type="button">필터 초기화</button>
          </footer>
          <p aria-label="정렬 변경 알림" aria-live="polite" className="sr-only" role="status">{sortNotice}</p>
        </section>
      ) : null}
    </div>
  );
}

function FilterChecks<T extends string>({ filters, legend, onChange, options }: {
  filters: readonly T[];
  legend: string;
  onChange: (filters: T[]) => void;
  options: ReadonlyArray<readonly [T, string]>;
}) {
  return (
    <fieldset className="modding-filter-checks">
      <legend>{legend}</legend>
      {options.map(([value, label]) => (
        <label key={value}>
          <input
            checked={filters.includes(value)}
            onChange={() => onChange(filters.includes(value)
              ? filters.filter((filter) => filter !== value)
              : [...filters, value])}
            type="checkbox"
          />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

function NumberFilter({ label, onChange, value }: {
  label: string;
  onChange: (value: number | undefined) => void;
  value?: number;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        aria-label={label}
        inputMode="numeric"
        min="0"
        onChange={(event) => onChange(optionalNumber(event.target.value))}
        placeholder="제한 없음"
        type="number"
        value={value ?? ""}
      />
    </label>
  );
}

function optionalNumber(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function activeControlCount(
  filters: PartCandidateFilters,
  sortKeys: readonly CandidateSortKey[],
): number {
  return Number(Boolean(filters.query.trim())) +
    Number(filters.availability !== "all") +
    filters.purchaseFilters.length +
    filters.effectFilters.length +
    filters.featureFilters.length +
    Number(filters.questRequirement !== "all") +
    Number(Boolean(filters.traderId)) +
    Number(filters.maxTraderPrice !== undefined) +
    Number(filters.maxFleaPrice !== undefined) +
    Number(filters.maxLoyaltyLevel !== undefined) +
    sortKeys.length;
}
