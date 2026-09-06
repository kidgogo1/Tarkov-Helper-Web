import { Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAppStore } from "../../app/store";
import { Dialog } from "../../components/Dialog";
import {
  completeQuest,
  createQuestStatusResolver,
  getQuestStatistics,
  isFactionRequirementMet,
  resetQuest,
} from "../../domain/quests";
import type { QuestData, TarkovData } from "../../types/data";
import type { QuestStatus, SavedQuestStatus } from "../../types/state";
import "../../styles/quests.css";
import { QuestDetail } from "./QuestDetail";
import {
  alternateQuestDisplayName,
  normalizeQuestSearchText,
  questDisplayName,
  questLegacyNames,
  questRequiredItemSearchText,
  questRewardSearchText,
  questSearchText,
  type QuestLanguage,
} from "./quest-language";

interface QuestsPageProps {
  data: TarkovData;
  focusQuestId?: string;
  focusRequested?: boolean;
  onOpenItem?: (itemId: string) => void;
  onOpenMap: (mapKey?: string, questId?: string) => void;
  onOpenQuest?: (questId: string) => void;
  onQuestSelect?: (questId: string, preserveFocus?: boolean) => void;
  onQuestFocusConsumed?: () => void;
}

const STATUS_LABELS: Record<QuestStatus, string> = {
  active: "진행 가능",
  locked: "잠김",
  levelLocked: "레벨 제한",
  unavailable: "이용 불가",
  done: "완료",
  failed: "실패",
};

const COMPLETABLE_STATUSES = new Set<QuestStatus>([
  "active",
  "locked",
  "levelLocked",
]);

function canCompleteQuest(status: QuestStatus | undefined): boolean {
  return status !== undefined && COMPLETABLE_STATUSES.has(status);
}

function normalize(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
}

function questMaps(quest: QuestData): string[] {
  return [
    ...quest.locations,
    ...quest.objectives
      .map((objective) => objective.mapName)
      .filter((mapName): mapName is string => Boolean(mapName)),
  ];
}

function findQuest(quests: readonly QuestData[], questId: string | undefined) {
  if (!questId) return undefined;
  const normalizedId = normalize(questId);
  return quests.find(
    (quest) =>
      normalize(quest.id) === normalizedId ||
      normalize(quest.normalizedName) === normalizedId ||
      normalize(quest.bsgId ?? "") === normalizedId,
  );
}

export function QuestsPage({
  data,
  focusQuestId,
  focusRequested: requestedFocus,
  onOpenItem,
  onOpenMap,
  onOpenQuest,
  onQuestSelect,
  onQuestFocusConsumed,
}: QuestsPageProps) {
  const focusRequested = requestedFocus ?? Boolean(focusQuestId);
  const {
    profile,
    setObjectiveProgress,
    setQuestTracked,
    setQuestStatus,
    updateProfile,
  } = useAppStore();
  const [query, setQuery] = useState("");
  const [requiredItemQuery, setRequiredItemQuery] = useState("");
  const [rewardQuery, setRewardQuery] = useState("");
  const [kappaOnly, setKappaOnly] = useState(false);
  const [itemOnly, setItemOnly] = useState(false);
  const [traderFilter, setTraderFilter] = useState("all");
  const [mapFilter, setMapFilter] = useState("all");
  const focusedQuest = findQuest(data.quests, focusQuestId);
  const [statusFilter, setStatusFilter] = useState<QuestStatus | "all">("all");
  const [language, setLanguage] = useState<QuestLanguage>("ko");
  const [pendingCompletion, setPendingCompletion] = useState<{
    quest: QuestData;
    alternatives: QuestData[];
  } | null>(null);
  const [selectedQuestId, setSelectedQuestId] = useState(
    focusedQuest?.id ?? data.quests[0]?.id ?? "",
  );
  const routeFocusKey = `${focusQuestId ?? ""}:${focusRequested ? "focus" : "selection"}`;
  const [handledQuestFocusKey, setHandledQuestFocusKey] = useState(routeFocusKey);
  const consumedQuestFocusRef = useRef<string | undefined>(undefined);
  const questButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  if (routeFocusKey !== handledQuestFocusKey) {
    setHandledQuestFocusKey(routeFocusKey);
    if (focusedQuest && selectedQuestId !== focusedQuest.id) {
      if (focusRequested) {
        setQuery("");
        setRequiredItemQuery("");
        setRewardQuery("");
        setKappaOnly(false);
        setItemOnly(false);
        setTraderFilter("all");
        setMapFilter("all");
        setStatusFilter("all");
      }
      setSelectedQuestId(focusedQuest.id);
    }
  }

  useEffect(() => {
    if (!focusRequested || !focusQuestId) {
      consumedQuestFocusRef.current = undefined;
      return;
    }
    if (consumedQuestFocusRef.current === focusQuestId) return;
    consumedQuestFocusRef.current = focusQuestId;
    const button = focusedQuest ? questButtonRefs.current.get(focusedQuest.id) : undefined;
    button?.scrollIntoView?.({ block: "nearest" });
    button?.focus();
    onQuestFocusConsumed?.();
  }, [focusQuestId, focusRequested, focusedQuest, onQuestFocusConsumed]);

  const statusResolver = useMemo(
    () => createQuestStatusResolver(data.quests, profile),
    [data.quests, profile],
  );
  const statuses = useMemo(
    () =>
      new Map(
        data.quests.map((quest) => [
          quest.id,
          statusResolver.getStatus(quest),
        ]),
      ),
    [data.quests, statusResolver],
  );
  const statistics = useMemo(
    () => getQuestStatistics(data.quests, profile, statusResolver),
    [data.quests, profile, statusResolver],
  );
  const traders = useMemo(
    () =>
      Array.from(new Set(data.quests.map((quest) => quest.trader))).sort(),
    [data.quests],
  );
  const maps = useMemo(
    () =>
      Array.from(new Set(data.quests.flatMap(questMaps))).sort(),
    [data.quests],
  );
  const itemsById = useMemo(
    () => new Map(data.items.map((item) => [item.id, item])),
    [data.items],
  );
  const hasActiveQuestFilters = Boolean(
    query ||
    requiredItemQuery ||
    rewardQuery ||
    kappaOnly ||
    itemOnly ||
    traderFilter !== "all" ||
    mapFilter !== "all" ||
    statusFilter !== "all",
  );

  const nameMatchedQuests = useMemo(() => {
    const needle = normalizeQuestSearchText(query);
    return needle
      ? data.quests.filter((quest) =>
          normalizeQuestSearchText(questSearchText(quest)).includes(needle))
      : data.quests;
  }, [data.quests, query]);

  const filteredQuests = useMemo(() => {
    const requiredItemNeedle = normalize(requiredItemQuery);
    const rewardNeedle = normalize(rewardQuery);
    const matches = nameMatchedQuests.filter((quest) => {
      const searchableRequiredItems = normalize(questRequiredItemSearchText(quest, itemsById));
      const searchableRewards = normalize(questRewardSearchText(quest, itemsById));
      return (
        (!requiredItemNeedle || searchableRequiredItems.includes(requiredItemNeedle)) &&
        (!rewardNeedle || searchableRewards.includes(rewardNeedle)) &&
        (!kappaOnly || quest.kappaRequired) &&
        (!itemOnly || quest.requiredItems.length > 0) &&
        (traderFilter === "all" || quest.trader === traderFilter) &&
        (mapFilter === "all" || questMaps(quest).includes(mapFilter)) &&
        (statusFilter === "unavailable" ||
          isFactionRequirementMet(quest, profile)) &&
        (statusFilter === "all" || statuses.get(quest.id) === statusFilter)
      );
    });
    if (
      focusRequested &&
      !hasActiveQuestFilters &&
      focusedQuest &&
      !matches.some((quest) => quest.id === focusedQuest.id)
    ) {
      return [focusedQuest, ...matches];
    }
    return matches;
  }, [
    focusRequested,
    focusedQuest,
    hasActiveQuestFilters,
    itemOnly,
    itemsById,
    kappaOnly,
    mapFilter,
    nameMatchedQuests,
    profile,
    requiredItemQuery,
    rewardQuery,
    statusFilter,
    statuses,
    traderFilter,
  ]);

  const hiddenSearchMatchCount = useMemo(() => {
    if (!normalizeQuestSearchText(query)) return 0;
    const visibleIds = new Set(filteredQuests.map((quest) => quest.id));
    return nameMatchedQuests.filter((quest) =>
      !visibleIds.has(quest.id) && isFactionRequirementMet(quest, profile)).length;
  }, [filteredQuests, nameMatchedQuests, profile, query]);

  const activeFilterLabels = [
    requiredItemQuery && "제출 아이템",
    rewardQuery && "보상",
    kappaOnly && "카파 필수",
    itemOnly && "아이템 필요",
    traderFilter !== "all" && `상인: ${traderFilter}`,
    mapFilter !== "all" && `지도: ${mapFilter}`,
    statusFilter !== "all" && `상태: ${STATUS_LABELS[statusFilter]}`,
  ].filter(Boolean).join(" · ");

  const clearOtherFilters = () => {
    setRequiredItemQuery("");
    setRewardQuery("");
    setKappaOnly(false);
    setItemOnly(false);
    setTraderFilter("all");
    setMapFilter("all");
    setStatusFilter("all");
  };

  const selectedQuest =
    filteredQuests.find((quest) => quest.id === selectedQuestId) ??
    filteredQuests[0];

  const nextSelectedQuestId = selectedQuest?.id ?? "";
  if (nextSelectedQuestId && nextSelectedQuestId !== selectedQuestId) {
    setSelectedQuestId(nextSelectedQuestId);
  }

  useLayoutEffect(() => {
    if (nextSelectedQuestId && nextSelectedQuestId !== focusQuestId) {
      const preserveFocus = focusRequested && focusedQuest?.id === nextSelectedQuestId;
      onQuestSelect?.(nextSelectedQuestId, preserveFocus);
    }
  }, [focusQuestId, focusRequested, focusedQuest?.id, nextSelectedQuestId, onQuestSelect]);

  const applyQuestProgress = (
    nextProgress: Record<string, SavedQuestStatus>,
  ) => {
    const keys = new Set([
      ...Object.keys(profile.questProgress),
      ...Object.keys(nextProgress),
    ]);
    keys.forEach((key) => {
      const next = nextProgress[key] ?? null;
      if (profile.questProgress[key] !== next) setQuestStatus(key, next);
    });
  };

  const completeSelectedQuest = (quest: QuestData) => {
    if (!canCompleteQuest(statuses.get(quest.id))) return;
    applyQuestProgress(
      completeQuest(quest.id, data.quests, profile.questProgress),
    );
  };

  const handleComplete = (quest: QuestData) => {
    if (!canCompleteQuest(statuses.get(quest.id))) return;
    const alternatives = quest.alternativeQuestIds
      .map((alternativeId) => findQuest(data.quests, alternativeId))
      .filter((alternative): alternative is QuestData => {
        if (!alternative) return false;
        const alternativeStatus = statuses.get(alternative.id);
        return alternativeStatus !== "done" && alternativeStatus !== "failed";
      });

    if (alternatives.length > 0) {
      setPendingCompletion({ quest, alternatives });
      return;
    }
    completeSelectedQuest(quest);
  };

  const handleReset = (quest: QuestData) => {
    applyQuestProgress(resetQuest(profile.questProgress, quest));
    quest.objectives.forEach((objective) =>
      setObjectiveProgress(objective.id, false),
    );
  };

  const handleOpenQuest = (questId: string) => {
    if (onOpenQuest) {
      onOpenQuest(questId);
      return;
    }
    setQuery("");
    setRequiredItemQuery("");
    setRewardQuery("");
    setKappaOnly(false);
    setItemOnly(false);
    setTraderFilter("all");
    setMapFilter("all");
    setStatusFilter("all");
    setSelectedQuestId(questId);
  };

  return (
    <section className="quests-page">
      <header className="quests-page-header">
        <div>
          <p className="section-title">QUEST TRACKER</p>
          <h1>퀘스트</h1>
          <p>진행 조건, 아이템, 목표와 후속 임무를 한곳에서 관리합니다.</p>
        </div>
        <div aria-label="진영" className="faction-switch" role="group">
          <button
            aria-pressed={profile.faction === "usec"}
            className={profile.faction === "usec" ? "active" : ""}
            onClick={() => updateProfile({ faction: "usec" })}
            type="button"
          >
            USEC
          </button>
          <button
            aria-pressed={profile.faction === "bear"}
            className={profile.faction === "bear" ? "active" : ""}
            onClick={() => updateProfile({ faction: "bear" })}
            type="button"
          >
            BEAR
          </button>
        </div>
        <div aria-label="퀘스트 언어" className="faction-switch quest-language-switch" role="group">
          <button
            aria-pressed={language === "ko"}
            className={language === "ko" ? "active" : ""}
            onClick={() => setLanguage("ko")}
            type="button"
          >
            한국어
          </button>
          <button
            aria-pressed={language === "en"}
            className={language === "en" ? "active" : ""}
            onClick={() => setLanguage("en")}
            type="button"
          >
            English
          </button>
        </div>
      </header>

      <section aria-label="전체 퀘스트 통계" className="quest-statistics">
        {(
          [
            ["전체", statistics.total, "total"],
            ["진행 가능", statistics.active, "active"],
            ["잠김", statistics.locked + statistics.levelLocked, "locked"],
            ["완료", statistics.done, "done"],
            ["실패", statistics.failed, "failed"],
            ["이용 불가", statistics.unavailable, "unavailable"],
          ] as const
        ).map(([label, value, tone]) => (
          <div className={`panel stat-${tone}`} key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </section>

      <div className="quest-workspace">
        <aside className="quest-browser panel">
          <div className="quest-filters">
            <label className="quest-search">
              <span className="sr-only">퀘스트 검색</span>
              <Search aria-hidden="true" size={15} />
              <input
                aria-label="퀘스트 검색"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="퀘스트 이름 검색"
                type="search"
                value={query}
              />
            </label>
            <label className="quest-search">
              <span className="sr-only">제출 아이템 검색</span>
              <Search aria-hidden="true" size={15} />
              <input
                aria-label="제출 아이템 검색"
                onChange={(event) => setRequiredItemQuery(event.target.value)}
                placeholder="퀘스트 제출 아이템 검색"
                type="search"
                value={requiredItemQuery}
              />
            </label>
            <label className="quest-search">
              <span className="sr-only">보상 검색</span>
              <Search aria-hidden="true" size={15} />
              <input
                aria-label="보상 검색"
                onChange={(event) => setRewardQuery(event.target.value)}
                placeholder="보상 아이템·보상 내용 검색"
                type="search"
                value={rewardQuery}
              />
            </label>
            <div className="quest-select-filters">
              <label>
                <span>상인</span>
                <select
                  aria-label="상인"
                  onChange={(event) => setTraderFilter(event.target.value)}
                  value={traderFilter}
                >
                  <option value="all">전체 상인</option>
                  {traders.map((trader) => (
                    <option key={trader} value={trader}>{trader}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>지도</span>
                <select
                  aria-label="지도"
                  onChange={(event) => setMapFilter(event.target.value)}
                  value={mapFilter}
                >
                  <option value="all">전체 지도</option>
                  {maps.map((map) => (
                    <option key={map} value={map}>{map}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>상태</span>
                <select
                  aria-label="상태"
                  onChange={(event) =>
                    setStatusFilter(event.target.value as QuestStatus | "all")
                  }
                  value={statusFilter}
                >
                  <option value="all">전체 상태</option>
                  {Object.entries(STATUS_LABELS).map(([status, label]) => (
                    <option key={status} value={status}>{label}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="quest-check-filters">
              <label>
                <input
                  checked={kappaOnly}
                  onChange={(event) => setKappaOnly(event.target.checked)}
                  type="checkbox"
                />
                카파 필수
              </label>
              <label>
                <input
                  checked={itemOnly}
                  onChange={(event) => setItemOnly(event.target.checked)}
                  type="checkbox"
                />
                아이템 필요
              </label>
            </div>
          </div>

          <div className="quest-list-summary">
            <strong>{filteredQuests.length}</strong>
            <span> / {data.quests.length} 퀘스트</span>
          </div>
          {hiddenSearchMatchCount > 0 ? (
            <div className="quest-filter-notice" role="status">
              <span>
                검색어와 일치하는 퀘스트 {hiddenSearchMatchCount}개가 다른 필터로 숨겨져 있습니다.
              </span>
              <small>적용 중: {activeFilterLabels}</small>
              <button onClick={clearOtherFilters} type="button">다른 필터 해제</button>
            </div>
          ) : null}
          <section aria-label="퀘스트 목록" className="quest-list-region">
            {filteredQuests.length > 0 ? (
              <ul className="quest-list">
                {filteredQuests.map((quest) => {
                  const status = statuses.get(quest.id) ?? "active";
                  return (
                    <li key={quest.id}>
                      <button
                        aria-current={selectedQuest?.id === quest.id ? "true" : undefined}
                        className={selectedQuest?.id === quest.id ? "selected" : ""}
                        onClick={() => {
                          setHandledQuestFocusKey(`${quest.id}:selection`);
                          setSelectedQuestId(quest.id);
                          onQuestSelect?.(quest.id);
                        }}
                        ref={(element) => {
                          if (element) questButtonRefs.current.set(quest.id, element);
                          else questButtonRefs.current.delete(quest.id);
                        }}
                        type="button"
                      >
                        <span className="quest-list-main">
                          <strong>{questDisplayName(quest, language)}</strong>
                          {alternateQuestDisplayName(quest, language) ? (
                            <small>{alternateQuestDisplayName(quest, language)}</small>
                          ) : null}
                          {questLegacyNames(quest).map((name) => (
                            <small className="quest-legacy-name" key={name}>
                              이전 이름: {name}
                            </small>
                          ))}
                        </span>
                        <span className="quest-list-meta">
                          <span>{quest.trader}</span>
                          {quest.kappaRequired ? <span className="badge kappa">K</span> : null}
                          <span className={`badge quest-status status-${status}`}>
                            {STATUS_LABELS[status]}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <div className="quest-list-empty" role="status">
                <strong>조건에 맞는 퀘스트가 없습니다.</strong>
                <span>검색어나 필터를 변경해 보세요.</span>
              </div>
            )}
          </section>
        </aside>

        {selectedQuest ? (
          <QuestDetail
            data={data}
            onComplete={handleComplete}
            onObjectiveChange={setObjectiveProgress}
            onOpenItem={(itemId) => onOpenItem?.(itemId)}
            onOpenMap={onOpenMap}
            onOpenQuest={handleOpenQuest}
            onReset={handleReset}
            onTrackedChange={(questId, tracked) =>
              setQuestTracked(questId, tracked, data.quests.map((quest) => quest.id))}
            profile={profile}
            quest={selectedQuest}
            status={statuses.get(selectedQuest.id) ?? "active"}
            statusResolver={statusResolver}
            tracked={profile.trackedQuestIds.includes(selectedQuest.id)}
            language={language}
          />
        ) : (
          <div className="quest-detail panel quest-detail-empty" role="status">
            표시할 퀘스트가 없습니다.
          </div>
        )}
      </div>

      <Dialog
        description="이 퀘스트를 완료하면 아래 대안 퀘스트가 실패로 기록됩니다. 이 변경은 퀘스트별 초기화로 되돌릴 수 있습니다."
        footer={
          <>
            <button onClick={() => setPendingCompletion(null)} type="button">
              취소
            </button>
            <button
              className="primary"
              onClick={() => {
                if (!pendingCompletion) return;
                completeSelectedQuest(pendingCompletion.quest);
                setPendingCompletion(null);
              }}
              type="button"
            >
              완료하고 대안 실패 처리
            </button>
          </>
        }
        onClose={() => setPendingCompletion(null)}
        open={pendingCompletion !== null}
        title="대안 퀘스트 실패 처리 확인"
      >
        <ul className="quest-completion-warning-list">
          {pendingCompletion?.alternatives.map((alternative) => (
            <li key={alternative.id}>{questDisplayName(alternative, language)}</li>
          ))}
        </ul>
      </Dialog>
    </section>
  );
}
