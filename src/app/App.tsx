import { AlertTriangle, CheckCircle2, FileClock, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { Dialog } from "../components/Dialog";
import { EmptyState } from "../components/EmptyState";
import {
  collapseQuestLogEvents,
  detectMapFromLogLine,
  parseQuestLogContent,
} from "../domain/map";
import {
  applyAlternativeQuestSelections,
  collectAlternativeQuestGroups,
  type AlternativeQuestGroupPlan,
} from "../domain/quest-sync";
import { completeQuest } from "../domain/quests";
import { CollectorPage } from "../features/collector/CollectorPage";
import { HideoutPage } from "../features/hideout/HideoutPage";
import { ItemsPage } from "../features/items/ItemsPage";
import { MapPage } from "../features/map/MapPage";
import { MapMiniMapSettingsDialog } from "../features/map/MapMiniMapSettingsDialog";
import { QuestsPage } from "../features/quests/QuestsPage";
import { InProgressQuestDialog } from "../features/settings/InProgressQuestDialog";
import { SettingsDialog } from "../features/settings/SettingsDialog";
import { usePublicUpdate } from "../features/settings/usePublicUpdate";
import type { ProfileType, TarkovData } from "../types/data";
import type { SavedQuestStatus } from "../types/state";
import { AppShell, type AppTab } from "./AppShell";
import { loadTarkovData } from "./data";
import { useAppStore } from "./store";

interface LogPreviewRecord {
  questId: string;
  questName: string;
  eventType: "started" | "completed" | "failed";
  sourceFile: string;
  timestamp: Date;
  known: boolean;
  selected: boolean;
}

interface LogImportPreview {
  records: LogPreviewRecord[];
  alternativeGroups: AlternativeQuestGroupPlan[];
  alternativeSelections: Record<string, string>;
  detectedMapKey: string | null;
  fileCount: number;
}

const VALID_TABS: readonly AppTab[] = ["quests", "hideout", "items", "collector", "map"];

function tabFromHash(): AppTab {
  const candidate = window.location.hash.replace(/^#\/?/, "") as AppTab;
  return VALID_TABS.includes(candidate) ? candidate : "quests";
}

function applyAppearance(fontFamily: string, fontSize: number): void {
  const families: Record<string, string> = {
    system: '"Segoe UI", "Noto Sans KR", Arial, sans-serif',
    sans: 'Arial, "Noto Sans KR", sans-serif',
    serif: 'Georgia, "Noto Serif KR", serif',
    mono: 'Consolas, "Cascadia Mono", monospace',
  };
  if (fontFamily !== "uploaded") {
    document.documentElement.style.setProperty("--font-ui", families[fontFamily] ?? families.system);
  }
  document.documentElement.style.setProperty("--font-size-base", `${fontSize}px`);
}

function eventQuestIds(records: readonly LogPreviewRecord[]): string[] {
  return records
    .filter(
      (record) =>
        record.known &&
        record.selected &&
        record.eventType !== "started",
    )
    .map((record) => record.questId);
}

function defaultAlternativeSelections(
  groups: readonly AlternativeQuestGroupPlan[],
  current: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return Object.fromEntries(
    groups.flatMap((group) => {
      const currentQuestId = current[group.key];
      const currentChoice = group.choices.find(
        ({ quest, status }) => quest.id === currentQuestId && status !== "failed",
      );
      const questId = currentChoice?.quest.id ?? group.defaultQuestId;
      return questId ? [[group.key, questId]] : [];
    }),
  );
}

export function App() {
  const store = useAppStore();
  const publicUpdate = usePublicUpdate();
  const [data, setData] = useState<TarkovData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(tabFromHash);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [miniMapSettingsOpen, setMiniMapSettingsOpen] = useState(false);
  const [inProgressQuestsOpen, setInProgressQuestsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [mapFocusQuestId, setMapFocusQuestId] = useState<string>();
  const [questFocusId, setQuestFocusId] = useState<string>();
  const [itemFocusId, setItemFocusId] = useState<string>();
  const [logPreview, setLogPreview] = useState<LogImportPreview | null>(null);
  const [readingLogs, setReadingLogs] = useState(false);
  const [logImportError, setLogImportError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadTarkovData(controller.signal)
      .then(setData)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoadError(error instanceof Error ? error.message : "데이터를 불러오지 못했습니다.");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const onHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    applyAppearance(store.settings.fontFamily, store.settings.fontSize);
  }, [store.settings.fontFamily, store.settings.fontSize]);

  const changeTab = (tab: AppTab) => {
    setActiveTab(tab);
    const nextHash = `#/${tab}`;
    if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
  };

  const openMap = (mapKey?: string, questId?: string) => {
    if (mapKey) store.updateMapSettings({ lastMapKey: mapKey });
    setMapFocusQuestId(questId);
    changeTab("map");
  };

  const openQuest = (questId: string) => {
    // A quest selected from the map should keep the map visible so its
    // objective marker can be inspected immediately. Other callers still
    // open the quest list as before.
    if (activeTab === "map") {
      setMapFocusQuestId(questId);
      return;
    }
    setQuestFocusId(questId);
    changeTab("quests");
  };

  const openItem = (itemId: string) => {
    setItemFocusId(itemId);
    changeTab("items");
  };

  const handleLogFiles = async (files: File[]) => {
    if (!data || !files.length) return;
    setLogImportError(null);
    setReadingLogs(true);
    try {
      const collected: LogPreviewRecord[] = [];
      let detectedMapKey: string | null = null;
      for (const file of files) {
        const content = await file.text();
        for (const event of parseQuestLogContent(content, file.name)) {
          const quest = data.quests.find(
            (candidate) => candidate.bsgId === event.questId || candidate.id === event.questId,
          );
          collected.push({
            questId: quest?.id ?? event.questId,
            questName: quest ? (quest.nameKo?.trim() || quest.name) : event.questId,
            eventType: event.eventType,
            sourceFile: file.name,
            timestamp: event.timestamp,
            known: Boolean(quest),
            selected: Boolean(quest) && event.eventType !== "started",
          });
        }
        for (const line of content.split(/\r?\n/)) {
          const detected = detectMapFromLogLine(line);
          if (!detected) continue;
          const config = data.mapConfigs.find((map) =>
            [map.key, map.displayName, ...map.aliases]
              .some((name) => name.toLocaleLowerCase() === detected.toLocaleLowerCase()),
          );
          if (config) detectedMapKey = config.key;
        }
      }
      const records = collapseQuestLogEvents(collected);
      const alternativeGroups = collectAlternativeQuestGroups(
        eventQuestIds(records),
        data.quests,
        store.profile.questProgress,
      );
      setLogPreview({
        records,
        alternativeGroups,
        alternativeSelections: defaultAlternativeSelections(alternativeGroups),
        detectedMapKey,
        fileCount: files.length,
      });
      setSettingsOpen(false);
    } catch (error: unknown) {
      const detail = error instanceof Error && error.message ? ` (${error.message})` : "";
      setLogImportError(`로그 파일을 읽지 못했습니다${detail}. 파일 권한과 상태를 확인해 주세요.`);
      setLogPreview(null);
    } finally {
      setReadingLogs(false);
    }
  };

  const applyLogPreview = () => {
    if (!data || !logPreview) return;
    let progress: Record<string, SavedQuestStatus> = { ...store.profile.questProgress };
    for (const record of logPreview.records) {
      if (!record.known || !record.selected || record.eventType === "started") continue;
      if (record.eventType === "completed") {
        progress = completeQuest(record.questId, data.quests, progress, {
          completePrerequisites: false,
        });
      } else {
        progress[record.questId] = "failed";
      }
    }
    progress = applyAlternativeQuestSelections(
      progress,
      logPreview.alternativeGroups,
      logPreview.alternativeSelections,
    );
    const allKeys = new Set([...Object.keys(store.profile.questProgress), ...Object.keys(progress)]);
    for (const id of allKeys) store.setQuestStatus(id, progress[id] ?? null);
    if (logPreview.detectedMapKey) store.updateMapSettings({ lastMapKey: logPreview.detectedMapKey });
    setLogPreview(null);
  };

  const mapPage = data ? (
    <MapPage
      data={data}
      focusQuestId={mapFocusQuestId}
      onOpenQuest={openQuest}
      onOpenMiniMapSettings={() => setMiniMapSettingsOpen(true)}
      onQuestFocusConsumed={() => setMapFocusQuestId(undefined)}
    />
  ) : null;

  const page = (() => {
    if (!data) return null;
    switch (activeTab) {
      case "quests":
        return (
          <QuestsPage
            data={data}
            focusQuestId={questFocusId}
            onOpenItem={openItem}
            onOpenMap={openMap}
            onOpenQuest={openQuest}
            onQuestFocusConsumed={() => setQuestFocusId(undefined)}
          />
        );
      case "hideout":
        return <HideoutPage data={data} />;
      case "items":
        return (
          <ItemsPage
            data={data}
            focusItemId={itemFocusId}
            onItemFocusConsumed={() => setItemFocusId(undefined)}
          />
        );
      case "collector":
        return <CollectorPage data={data} />;
      case "map":
        return null;
    }
  })();

  if (loadError) {
    return (
      <div className="startup-state error">
        <AlertTriangle aria-hidden="true" size={34} />
        <h1>번들 데이터 오류</h1>
        <p>{loadError}</p>
        <button onClick={() => window.location.reload()} type="button">다시 시도</button>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="startup-state">
        <LoaderCircle aria-hidden="true" className="spin" size={34} />
        <strong>저장소 데이터를 불러오는 중…</strong>
        <span>외부 API에 연결하지 않습니다.</span>
      </div>
    );
  }

  return (
    <>
      <AppShell
        activeProfile={store.activeProfile}
        activeTab={activeTab}
        level={store.profile.level}
        onLevelChange={(level) => store.updateProfile({ level })}
        onProfileChange={(profile: ProfileType) => store.setActiveProfile(profile)}
        onReset={() => setResetOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        onTabChange={changeTab}
      >
        <div
          aria-hidden={activeTab === "map" ? undefined : true}
          className={activeTab === "map" ? "app-page-layer" : "app-page-layer app-page-layer--preserved"}
        >
          {mapPage}
        </div>
        {activeTab !== "map" ? <div className="app-page-layer">{page}</div> : null}
      </AppShell>

      <SettingsDialog
        dataMeta={data.meta}
        logImportError={logImportError}
        onClose={() => setSettingsOpen(false)}
        onLogFiles={handleLogFiles}
        onOpenInProgressQuests={() => {
          setSettingsOpen(false);
          setInProgressQuestsOpen(true);
        }}
        onUpdateMapSettings={store.updateMapSettings}
        onUpdateProfile={store.updateProfile}
        onUpdateSettings={store.updateSettings}
        open={settingsOpen}
        profile={store.profile}
        publicUpdate={publicUpdate}
        settings={store.settings}
      />

      <MapMiniMapSettingsDialog
        mapSettings={store.settings.map}
        onClose={() => setMiniMapSettingsOpen(false)}
        onUpdateMapSettings={store.updateMapSettings}
        open={miniMapSettingsOpen}
      />

      <InProgressQuestDialog
        onApply={(_selectedQuestIds, prerequisiteQuestIds) => {
          for (const questId of prerequisiteQuestIds) {
            store.setQuestStatus(questId, "done");
          }
        }}
        onClose={() => setInProgressQuestsOpen(false)}
        open={inProgressQuestsOpen}
        progress={store.profile.questProgress}
        quests={data.quests}
      />

      <Dialog
        footer={(
          <>
            <button onClick={() => setResetOpen(false)} type="button">취소</button>
            <button
              className="danger"
              onClick={() => {
                store.resetProgress();
                setResetOpen(false);
              }}
              type="button"
            >
              현재 {store.activeProfile.toUpperCase()} 초기화
            </button>
          </>
        )}
        onClose={() => setResetOpen(false)}
        open={resetOpen}
        title="진행도 초기화"
      >
        <div className="confirm-content">
          <AlertTriangle aria-hidden="true" size={27} />
          <div>
            <strong>현재 프로필의 퀘스트·목표·은신처 진행도를 지웁니다.</strong>
            <p>인벤토리 수량과 커스텀 지도 마커는 유지됩니다. 다른 모드에는 영향을 주지 않습니다.</p>
          </div>
        </div>
      </Dialog>

      <Dialog
        footer={(
          <>
            <button onClick={() => setLogPreview(null)} type="button">취소</button>
            <button
              className="primary"
              disabled={!logPreview?.records.some((record) => record.selected)}
              onClick={applyLogPreview}
              type="button"
            >
              선택 변경 적용
            </button>
          </>
        )}
        onClose={() => setLogPreview(null)}
        open={Boolean(logPreview)}
        title="로그 가져오기 미리보기"
        wide
      >
        {logPreview ? (
          <div className="log-preview">
            <div className="log-preview-summary">
              <span><FileClock aria-hidden="true" size={16} /> 파일 {logPreview.fileCount}개</span>
              <span><CheckCircle2 aria-hidden="true" size={16} /> 이벤트 {logPreview.records.length}개</span>
              {logPreview.detectedMapKey ? <span>감지 지도: {logPreview.detectedMapKey}</span> : null}
            </div>
            {logPreview.records.length ? (
              <div className="log-event-list">
                {logPreview.records.map((record, index) => (
                  <div className={record.known ? "log-event" : "log-event unknown"} key={`${record.sourceFile}-${record.questId}-${index}`}>
                    <input
                      aria-label={`${record.questName} 변경 선택`}
                      checked={record.selected}
                      disabled={!record.known || record.eventType === "started"}
                      onChange={(event) => {
                        const selected = event.target.checked;
                        setLogPreview((current) => {
                          if (!current) return current;
                          const records = current.records.map((candidate, candidateIndex) =>
                            candidateIndex === index ? { ...candidate, selected } : candidate,
                          );
                          const alternativeGroups = collectAlternativeQuestGroups(
                            eventQuestIds(records),
                            data.quests,
                            store.profile.questProgress,
                          );
                          return {
                            ...current,
                            records,
                            alternativeGroups,
                            alternativeSelections: defaultAlternativeSelections(
                              alternativeGroups,
                              current.alternativeSelections,
                            ),
                          };
                        });
                      }}
                      title={record.eventType === "started" ? "시작 이벤트는 진행도를 변경하지 않습니다." : undefined}
                      type="checkbox"
                    />
                    <span className={`badge ${record.eventType === "completed" ? "success" : record.eventType === "failed" ? "danger" : ""}`}>
                      {record.eventType === "completed" ? "완료" : record.eventType === "failed" ? "실패" : "시작"}
                    </span>
                    <strong>{record.questName}</strong>
                    <small>{record.sourceFile}</small>
                    {!record.known ? <span className="badge danger">알 수 없는 ID</span> : null}
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState title="적용할 퀘스트 이벤트가 없습니다" description="선택한 파일의 로그 형식을 확인하세요." />
            )}
            {logPreview.alternativeGroups.length ? (
              <section className="alternative-quest-groups" aria-labelledby="alternative-quest-title">
                <h3 id="alternative-quest-title">상호 배타적 선행 퀘스트</h3>
                <p>동시에 완료할 수 없는 선행 퀘스트입니다. 실제로 완료한 경로를 선택하세요.</p>
                {logPreview.alternativeGroups.map((group, index) => (
                  <fieldset
                    aria-label={`상호 배타적 선행 퀘스트 선택 ${index + 1}`}
                    key={group.key}
                    role="radiogroup"
                  >
                    <legend>대안 그룹 {index + 1}</legend>
                    {group.choices.map(({ quest, status }) => {
                      const name = quest.nameKo?.trim() || quest.name;
                      return (
                        <label key={quest.id}>
                          <input
                            checked={logPreview.alternativeSelections[group.key] === quest.id}
                            disabled={status === "failed"}
                            name={`alternative-${group.key}`}
                            onChange={() => {
                              setLogPreview((current) => current ? {
                                ...current,
                                alternativeSelections: {
                                  ...current.alternativeSelections,
                                  [group.key]: quest.id,
                                },
                              } : current);
                            }}
                            type="radio"
                            value={quest.id}
                          />
                          <span>
                            <strong>{name}</strong>
                            {name !== quest.name ? <small>{quest.name}</small> : null}
                          </span>
                          {status === "failed" ? <span className="badge danger">실패 처리됨</span> : null}
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      {readingLogs ? <div className="busy-overlay"><LoaderCircle className="spin" size={24} /> 로그 읽는 중…</div> : null}
    </>
  );
}
