import {
  CircleAlert,
  RotateCcw,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  calculateBuildStats,
  evaluateCandidateCompatibility,
  getSlotCandidates,
  removeBuildSlot,
  replaceBuildSlotResolvingConflicts,
  validateWeaponBuild,
} from "../../domain/weapon-build";
import type { ProfileType } from "../../types/data";
import type {
  BuildMutationResult,
  WeaponBuild,
  WeaponCatalog,
  WeaponCatalogItem,
  WeaponPartItem,
  WeaponSlotRule,
} from "../../types/weapon-modding";
import { PartCandidateControls } from "./PartCandidateControls";
import { PartCandidateRow } from "./PartCandidateRow";
import { PartImagePreviewDialog } from "./PartImagePreviewDialog";
import {
  DEFAULT_PART_CANDIDATE_FILTERS,
  filterAndSortPartCandidates,
  getProfileTraderOffers,
  type CandidateSortKey,
  type PartCandidateRecord,
} from "./part-candidate-controls";
import { WeaponSlotTree, type SlotSelection } from "./WeaponSlotTree";
import { WeaponHotspots } from "./WeaponHotspots";
import { WeaponItemImage } from "./WeaponItemImage";

interface WeaponWorkbenchProps {
  activeProfile: ProfileType;
  build: WeaponBuild;
  catalog: WeaponCatalog;
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  selectedSlot: SlotSelection | null;
  onBuildChange: (build: WeaponBuild) => void;
  onReset: () => void;
  onSlotSelect: (selection: SlotSelection | null) => void;
}

interface CandidateChoice extends PartCandidateRecord {
  conflictItemNames: string[];
  replacement: BuildMutationResult;
}

export function WeaponWorkbench({
  activeProfile,
  build,
  catalog,
  itemById,
  selectedSlot,
  onBuildChange,
  onReset,
  onSlotSelect,
}: WeaponWorkbenchProps) {
  const partPickerRef = useRef<HTMLElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const [swapNotice, setSwapNotice] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<WeaponPartItem | null>(null);
  const [candidateFilters, setCandidateFilters] = useState({
    ...DEFAULT_PART_CANDIDATE_FILTERS,
  });
  const [traderFilterByContext, setTraderFilterByContext] = useState<Record<string, string>>({});
  const [candidateSortKeys, setCandidateSortKeys] = useState<CandidateSortKey[]>([]);
  const weapon = itemById.get(build.weaponId);
  const stats = useMemo(() => calculateBuildStats(catalog, build), [build, catalog]);
  const candidateChoices = useMemo<CandidateChoice[]>(() => {
    if (!selectedSlot) return [];
    return getSlotCandidates(
      catalog,
      build,
      selectedSlot.parentInstanceId,
      selectedSlot.slotId,
    ).map((candidate) => {
      const compatibility = evaluateCandidateCompatibility(
        catalog,
        build,
        selectedSlot.parentInstanceId,
        selectedSlot.slotId,
        candidate.id,
      );
      const replacement = replaceBuildSlotResolvingConflicts(
        catalog,
        build,
        selectedSlot.parentInstanceId,
        selectedSlot.slotId,
        candidate.id,
      );
      const replacementStats = replacement.ok
        ? calculateBuildStats(catalog, replacement.build)
        : undefined;
      const conflictItemNames = [...new Set(compatibility.issues.flatMap((issue) => {
        if (
          issue.code !== "ITEM_CONFLICT" &&
          issue.code !== "SLOT_CONFLICT"
        ) return [];
        const relatedItem = issue.relatedItemId
          ? itemById.get(issue.relatedItemId)
          : undefined;
        return [relatedItem?.nameKo ?? relatedItem?.name ?? issue.relatedItemId]
          .filter((name): name is string => Boolean(name));
      }))];
      return {
        availability: compatibility.isValid
          ? "compatible"
          : replacement.ok ? "auto-resolvable" : "blocked",
        candidate,
        conflictItemNames,
        performanceDelta: replacementStats ? {
          accuracy: stats.accuracyMoa !== undefined &&
              replacementStats.accuracyMoa !== undefined
            ? replacementStats.accuracyMoa - stats.accuracyMoa
            : undefined,
          ergonomics: replacementStats.ergonomics - stats.ergonomics,
          recoil: replacementStats.verticalRecoil - stats.verticalRecoil,
          velocity: (replacementStats.muzzleVelocityModifier ?? 0) -
            (stats.muzzleVelocityModifier ?? 0),
          weight: replacementStats.weight - stats.weight,
        } : {},
        replacement,
      };
    });
  }, [
    build,
    catalog,
    itemById,
    selectedSlot,
    stats,
  ]);
  const traderOptions = useMemo(() => {
    const traders = new Map<string, string>();
    for (const { candidate } of candidateChoices) {
      for (const offer of getProfileTraderOffers(candidate, activeProfile)) {
        traders.set(offer.traderId, offer.traderName);
      }
    }
    return [...traders].map(([id, name]) => ({ id, name })).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
  }, [activeProfile, candidateChoices]);
  const traderFilterContext = selectedSlot
    ? `${activeProfile}:${selectedSlot.parentInstanceId}:${selectedSlot.slotId}`
    : `${activeProfile}:no-slot`;
  const configuredTraderId = traderFilterByContext[traderFilterContext] ?? "";
  const activeTraderId = traderOptions.some(({ id }) => id === configuredTraderId)
    ? configuredTraderId
    : "";
  const activeCandidateFilters = useMemo(() => ({
    ...candidateFilters,
    traderId: activeTraderId,
  }), [activeTraderId, candidateFilters]);
  const visibleCandidateChoices = useMemo(() => filterAndSortPartCandidates(
    candidateChoices,
    activeProfile,
    activeCandidateFilters,
    candidateSortKeys,
  ), [
    activeProfile,
    activeCandidateFilters,
    candidateChoices,
    candidateSortKeys,
  ]);
  if (!weapon || weapon.kind !== "weapon") return null;

  const validation = validateWeaponBuild(catalog, build);
  const selectableCandidateCount = candidateChoices.filter(
    ({ replacement }) => replacement.ok,
  ).length;
  let candidateCountLabel = "먼저 부위를 선택하세요";
  if (selectedSlot) {
    candidateCountLabel = selectableCandidateCount === candidateChoices.length
      ? `${selectableCandidateCount}개 장착 가능`
      : `${selectableCandidateCount}개 장착 가능 · 전체 ${candidateChoices.length}개`;
  }

  const selectSlot = (selection: SlotSelection) => {
    setSwapNotice(null);
    onSlotSelect(selection);
    partPickerRef.current?.focus();
  };

  const replacePart = (choice: CandidateChoice) => {
    if (!selectedSlot || !choice.replacement.ok) return;
    const candidateName = choice.candidate.nameKo ?? choice.candidate.name;
    const conflictNames = choice.conflictItemNames.length
      ? choice.conflictItemNames.join(", ")
      : "충돌하는 기존 부품";
    if (
      choice.availability === "auto-resolvable" &&
      !window.confirm(
        `${candidateName}을 장착하면 ${conflictNames}이 자동으로 해제됩니다. 계속할까요?`,
      )
    ) return;

    onBuildChange(choice.replacement.build);
    setSwapNotice(choice.availability === "auto-resolvable"
      ? `${candidateName} 장착 · ${conflictNames} 자동 해제`
      : null);
  };

  const openPreview = (candidate: WeaponPartItem, trigger: HTMLButtonElement) => {
    previewTriggerRef.current = trigger;
    setPreviewItem(candidate);
  };

  const closePreview = () => {
    const trigger = previewTriggerRef.current;
    setPreviewItem(null);
    requestAnimationFrame(() => trigger?.focus());
  };

  const updateCandidateFilters = (nextFilters: typeof candidateFilters) => {
    setCandidateFilters({ ...nextFilters, traderId: "" });
    setTraderFilterByContext((current) => {
      if (nextFilters.traderId) {
        return { ...current, [traderFilterContext]: nextFilters.traderId };
      }
      if (!(traderFilterContext in current)) return current;
      const next = { ...current };
      delete next[traderFilterContext];
      return next;
    });
  };

  const removePart = (parentInstanceId: string, slot: WeaponSlotRule) => {
    const result = removeBuildSlot(build, parentInstanceId, slot.id);
    if (!result.ok) return;
    setSwapNotice(null);
    onBuildChange(result.build);
    if (selectedSlot && result.removedNodes.some(
      (node) => node.instanceId === selectedSlot.parentInstanceId,
    )) {
      onSlotSelect(null);
    }
  };

  return (
    <div className="modding-workbench">
      <section className="modding-weapon-stage">
        <header>
          <div>
            <span className="modding-mode-badge">{activeProfile.toUpperCase()}</span>
            <h2>{weapon.nameKo ?? weapon.name}</h2>
            {weapon.nameKo && weapon.nameKo !== weapon.name ? <p>{weapon.name}</p> : null}
          </div>
          <div className="modding-stage-actions">
            <span className="modding-image-note">상점 기본 외형 · 참고 이미지</span>
            <button
              onClick={() => {
                setSwapNotice(null);
                onReset();
              }}
              type="button"
            >
              <RotateCcw aria-hidden="true" size={14} />
              기본 구성으로 초기화
            </button>
          </div>
        </header>

        <div className="modding-weapon-image">
          <WeaponItemImage
            alt={`${weapon.nameKo ?? weapon.name} 상점 기본 외형`}
            fallbackSize={64}
            src={weapon.factoryImageUrl ?? weapon.imageUrl}
          />
          <WeaponHotspots
            itemById={itemById}
            onSelect={selectSlot}
            root={build.root}
            selectedSlot={selectedSlot}
            slots={weapon.slots}
          />
        </div>

        <BuildStats stats={stats} validation={validation} />
      </section>

      <aside aria-label="장착·필수 파츠" className="modding-installed-parts" role="region">
        <header>
          <span>장착·필수 파츠</span>
          <small>부위를 눌러 교체</small>
        </header>
        <div className="modding-installed-parts-body">
          <WeaponSlotTree
            itemById={itemById}
            node={build.root}
            onRemove={removePart}
            onSelect={(parentInstanceId, slot) => selectSlot({
              parentInstanceId,
              slotId: slot.id,
            })}
            selectedSlot={selectedSlot}
          />
        </div>
      </aside>

      <aside
        aria-label="호환 부품 선택"
        className="modding-part-picker"
        ref={partPickerRef}
        tabIndex={-1}
      >
        <header aria-live="polite">
          <span>부품 선택</span>
          <small>{candidateCountLabel}</small>
        </header>
        {swapNotice ? <p className="modding-swap-notice" role="status">{swapNotice}</p> : null}
        {selectedSlot ? (
          candidateChoices.length ? (
            <>
              <PartCandidateControls
                filters={activeCandidateFilters}
                onFiltersChange={updateCandidateFilters}
                onSortKeysChange={setCandidateSortKeys}
                sortKeys={candidateSortKeys}
                totalCount={candidateChoices.length}
                traderOptions={traderOptions}
                visibleCount={visibleCandidateChoices.length}
              />
              {visibleCandidateChoices.length ? (
                <ul aria-label="호환 부품 목록" className="modding-part-list">
                  {visibleCandidateChoices.map((choice) => {
                    const { availability, candidate, replacement } = choice;
                    return (
                      <PartCandidateRow
                        activeProfile={activeProfile}
                        availability={availability}
                        candidate={candidate}
                        conflictMessage={candidateConflictMessage(choice)}
                        disabled={!replacement.ok}
                        filters={activeCandidateFilters}
                        key={candidate.id}
                        onPreview={openPreview}
                        onSelect={() => replacePart(choice)}
                      />
                    );
                  })}
                </ul>
              ) : (
                <p className="modding-picker-empty" role="status">
                  선택한 필터에 맞는 부품이 없습니다.
                </p>
              )}
            </>
          ) : <p className="modding-picker-empty">이 슬롯에 등록된 부품이 없습니다.</p>
        ) : <p className="modding-picker-empty">총기 이미지 주변이나 장착 트리에서 부위를 선택하세요.</p>}
      </aside>
      <PartImagePreviewDialog item={previewItem} onClose={closePreview} />
    </div>
  );
}

function candidateConflictMessage(choice: CandidateChoice): string | null {
  if (choice.availability === "compatible") return null;
  const conflictNames = choice.conflictItemNames.join(", ");
  if (choice.availability === "auto-resolvable") {
    return `선택 시 자동 해제: ${conflictNames || "충돌하는 기존 부품"}`;
  }
  return conflictNames
    ? `장착 불가: ${conflictNames}과 충돌`
    : "장착 불가: 현재 총기 또는 상위 부품과 충돌";
}

function BuildStats({ stats, validation }: {
  stats: ReturnType<typeof calculateBuildStats>;
  validation: ReturnType<typeof validateWeaponBuild>;
}) {
  return (
    <aside className="modding-stats" aria-label="무기 능력치" role="region">
      <header>
        <span>현재 빌드</span>
        <strong className={validation.isValid ? "valid" : "invalid"}>
          {validation.isValid ? "사용 가능" : "확인 필요"}
        </strong>
      </header>
      <dl>
        <Stat label="수직 반동" value={formatNumber(stats.verticalRecoil)} />
        <Stat label="수평 반동" value={formatNumber(stats.horizontalRecoil)} />
        <Stat label="인체공학" value={formatNumber(stats.ergonomics)} />
        <Stat label="무게" value={`${formatNumber(stats.weight, 2)} kg`} />
        {stats.accuracyMoa != null ? (
          <Stat label="정확도" value={`${formatNumber(stats.accuracyMoa, 2)} MOA`} />
        ) : null}
        {stats.muzzleVelocityModifier != null ? (
          <Stat
            label="총구 속도 보정"
            value={`${stats.muzzleVelocityModifier > 0 ? "+" : ""}${formatNumber(stats.muzzleVelocityModifier, 2)}%`}
          />
        ) : null}
      </dl>
      {!validation.isValid ? (
        <div className="modding-issues">
          {validation.issues.slice(0, 6).map((issue, index) => (
            <p key={`${issue.code}:${index}`}>
              <CircleAlert aria-hidden="true" size={14} />{issue.message}
            </p>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatNumber(value: number, digits = 0): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}
