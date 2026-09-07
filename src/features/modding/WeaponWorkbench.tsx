import {
  ChevronLeft,
  ChevronRight,
  ListTree,
  Redo2,
  RotateCcw,
  SlidersHorizontal,
  Trash2,
  Undo2,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  calculateBuildStats,
  createFactoryBuild,
  evaluateCandidateCompatibility,
  flattenBuildTree,
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
import { BuildPriceSummary } from "./BuildPriceSummary";
import { BuildStats } from "./BuildStats";
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
import { WeaponVisualPreview } from "./WeaponVisualPreview";
import { summarizeBuildPrice, type BuildPurchaseMode } from "./build-price-summary";
import { displayWeaponSlotName } from "./weapon-slot-display";
import "../../styles/weapon-preset-editor.css";

interface WeaponWorkbenchProps {
  activeProfile: ProfileType;
  build: WeaponBuild;
  catalog: WeaponCatalog;
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  selectedSlot: SlotSelection | null;
  onBuildChange: (build: WeaponBuild) => void;
  onReset: () => void;
  onSlotSelect: (selection: SlotSelection | null) => void;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
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
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
}: WeaponWorkbenchProps) {
  const partPickerRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  const previewTriggerRef = useRef<HTMLButtonElement>(null);
  const [swapNotice, setSwapNotice] = useState<{ assemblyKey: string; message: string } | null>(null);
  const [previewItem, setPreviewItem] = useState<WeaponPartItem | null>(null);
  const [candidateFilters, setCandidateFilters] = useState({
    ...DEFAULT_PART_CANDIDATE_FILTERS,
  });
  const [traderFilterByContext, setTraderFilterByContext] = useState<Record<string, string>>({});
  const [candidateSortKeys, setCandidateSortKeys] = useState<CandidateSortKey[]>([]);
  const [purchaseMode, setPurchaseMode] = useState<BuildPurchaseMode>("buy");
  const [panel, setPanel] = useState<"parts" | "tree">("parts");
  const weapon = itemById.get(build.weaponId);
  const flatNodes = useMemo(() => flattenBuildTree(build.root), [build]);
  const assemblyKey = useMemo(() => JSON.stringify(build.root), [build.root]);
  const selectedParent = itemById.get(flatNodes.find(
    (node) => node.instanceId === selectedSlot?.parentInstanceId,
  )?.itemId ?? "");
  const selectedSlotRule = selectedParent?.slots?.find((slot) => slot.id === selectedSlot?.slotId);
  const selectedPartNode = flatNodes.find((node) => selectedSlot &&
    node.parentInstanceId === selectedSlot.parentInstanceId && node.slotId === selectedSlot.slotId);
  const selectedPartId = selectedPartNode?.itemId;
  const selectedPart = selectedPartId ? itemById.get(selectedPartId) : undefined;
  const stats = useMemo(() => calculateBuildStats(catalog, build), [build, catalog]);
  const factoryStats = useMemo(
    () => calculateBuildStats(catalog, createFactoryBuild(catalog, build.weaponId)),
    [catalog, build.weaponId],
  );
  const priceSummary = useMemo(
    () => summarizeBuildPrice(catalog, build, activeProfile, purchaseMode),
    [activeProfile, build, catalog, purchaseMode],
  );
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
      const replacement: BuildMutationResult = candidate.id === selectedPartId
        ? { ok: true, build, removedNodes: [] }
        : replaceBuildSlotResolvingConflicts(
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
    selectedPartId,
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
    setPanel("parts");
    onSlotSelect(selection);
    requestAnimationFrame(() => {
      const picker = partPickerRef.current;
      picker?.focus({ preventScroll: true });
      // In the stacked layout, the candidate panel follows the stats and costs.
      // Bring the result of the user's click into view without scrolling desktop layouts.
      if (window.matchMedia?.("(max-width: 1100px)").matches) {
        picker?.parentElement?.scrollIntoView({ block: "start", behavior: "auto" });
      }
    });
  };

  const replacePart = (choice: CandidateChoice) => {
    if (!selectedSlot || !choice.replacement.ok || choice.candidate.id === selectedPartId) return;
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
      ? { assemblyKey: JSON.stringify(choice.replacement.build.root), message: `${candidateName} 장착 · ${conflictNames} 자동 해제` }
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
    <div className="modding-workbench modding-preset-editor">
      <div className="modding-editor-toolbar">
        <div className="modding-editor-title"><strong>프리셋 편집</strong><span>부위 선택 → 부품 장착 → 하위 부위 편집</span></div>
        <div className="modding-edit-history" role="group" aria-label="편집 기록">
          <button type="button" onClick={() => { setSwapNotice(null); onUndo?.(); }} disabled={!canUndo} aria-label="실행 취소" title="직전 조립 변경 되돌리기">
            <Undo2 size={16} aria-hidden="true" />실행 취소</button>
          <button type="button" onClick={() => { setSwapNotice(null); onRedo?.(); }} disabled={!canRedo} aria-label="다시 실행" title="되돌린 조립 변경 다시 적용">
            <Redo2 size={16} aria-hidden="true" />다시 실행</button>
        </div>
      </div>
      <section className="modding-weapon-stage" ref={stageRef}>
        <header>
          <div>
            <span className="modding-mode-badge">{activeProfile.toUpperCase()}</span>
            <h2>{weapon.nameKo ?? weapon.name}</h2>
            {weapon.nameKo && weapon.nameKo !== weapon.name ? <p>{weapon.name}</p> : null}
          </div>
          <div className="modding-stage-actions">
            <span className="modding-image-note">부위 선택 · 조립 외형</span>
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

        <WeaponVisualPreview key={weapon.id} weapon={weapon} itemById={itemById}
          onSelect={selectSlot} root={build.root} selectedSlot={selectedSlot} />

        <BuildStats itemById={itemById} stats={stats} factoryStats={factoryStats} validation={validation} />
        <BuildPriceSummary activeProfile={activeProfile} summary={priceSummary}
          purchaseMode={purchaseMode} onPurchaseModeChange={setPurchaseMode}
          factoryPriceUpdatedAt={weapon.factoryPriceUpdatedAt} />
      </section>

      <div className="modding-editor-side">
      <button type="button" className="modding-back-to-assembly" onClick={() => {
        const card = stageRef.current?.querySelector<HTMLElement>('.modding-assembly-slot-card[aria-pressed="true"]');
        if (card) {
          card.focus({ preventScroll: true });
          card.scrollIntoView({ block: "center", behavior: "auto" });
        } else stageRef.current?.scrollIntoView({ block: "start", behavior: "auto" });
      }}><ChevronLeft size={15} aria-hidden="true" />총기 부위로 돌아가기</button>
      <div className="modding-editor-panel-switch" role="group" aria-label="편집 패널 선택">
        <button type="button" aria-label="부품 선택 패널" aria-pressed={panel === "parts"}
          onClick={() => setPanel("parts")}><SlidersHorizontal size={16} aria-hidden="true" />부품 선택</button>
        <button type="button" aria-label="전체 장착 트리" aria-pressed={panel === "tree"}
          onClick={() => setPanel("tree")}><ListTree size={16} aria-hidden="true" />전체 장착 트리</button>
      </div>
      <aside aria-label="장착·필수 파츠" className="modding-installed-parts" role="region" hidden={panel !== "tree"}>
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
        hidden={panel !== "parts"}
      >
        <header aria-live="polite">
          <span>부품 선택</span>
          <small>{candidateCountLabel}</small>
        </header>
        {selectedSlotRule ? (
          <section aria-label="선택한 부위" className="modding-selection-context">
            <span className="modding-selection-path">{weapon.shortName ?? weapon.name}<ChevronRight size={12} aria-hidden="true" />
              {selectedParent?.shortName ?? selectedParent?.name}</span>
            <strong>{displayWeaponSlotName(selectedSlotRule)}{selectedSlotRule.required ? " · 필수" : ""}</strong>
            <small>현재 장착: {selectedPart?.shortName ?? selectedPart?.name ?? "비어 있음"}</small>
            {selectedPart && selectedSlot && <button type="button" className="modding-selected-remove" aria-label="선택 부품 제거"
              onClick={() => removePart(selectedSlot.parentInstanceId, selectedSlotRule)}>
              <Trash2 size={13} aria-hidden="true" />장착 해제{selectedSlotRule.required ? " · 필수 부품" : ""}</button>}
            {selectedPartNode && Boolean(selectedPart?.slots?.length) && <ChildSlotShortcuts
              parentInstanceId={selectedPartNode.instanceId} slots={selectedPart?.slots ?? []} onSelect={selectSlot} />}
          </section>
        ) : null}
        {swapNotice?.assemblyKey === assemblyKey ? <p className="modding-swap-notice" role="status">{swapNotice.message}</p> : null}
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
              <div className="modding-candidate-results" aria-live="polite">
                <span>표시 {visibleCandidateChoices.length} / 전체 {candidateChoices.length}개</span>
                {visibleCandidateChoices.length < candidateChoices.length ? (
                  <button type="button" onClick={() => updateCandidateFilters({ ...DEFAULT_PART_CANDIDATE_FILTERS })}>
                    검색·필터 해제
                  </button>
                ) : null}
              </div>
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
                        equipped={candidate.id === selectedPartId}
                        filters={activeCandidateFilters}
                        performanceDelta={choice.performanceDelta}
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
      </div>
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

function ChildSlotShortcuts({ parentInstanceId, slots, onSelect }: {
  parentInstanceId: string;
  slots: readonly WeaponSlotRule[];
  onSelect: (selection: SlotSelection) => void;
}) {
  return <div className="modding-child-slots" role="group" aria-label="장착한 부품의 하위 부위">
    <span>이 부품에 추가 장착</span>
    {slots.map((slot) => <button type="button" key={slot.id}
      aria-label={`하위 부위: ${displayWeaponSlotName(slot)}`}
      onClick={() => onSelect({ parentInstanceId, slotId: slot.id })}>
      {displayWeaponSlotName(slot)}<ChevronRight size={13} aria-hidden="true" /></button>)}
  </div>;
}
