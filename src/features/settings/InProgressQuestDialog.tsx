import { useMemo, useState } from "react";

import { Dialog } from "../../components/Dialog";
import { getManualPrerequisites } from "../../domain/quest-sync";
import type { QuestData } from "../../types/data";
import type { SavedQuestStatus } from "../../types/state";
import { normalizeQuestSearchText } from "../quests/quest-language";

interface InProgressQuestDialogProps {
  open: boolean;
  quests: readonly QuestData[];
  progress: Readonly<Record<string, SavedQuestStatus>>;
  onClose: () => void;
  onApply: (selectedQuestIds: string[], prerequisiteQuestIds: string[]) => void;
}

function displayName(quest: QuestData): string {
  return quest.nameKo?.trim() || quest.name;
}

function savedStatus(
  quest: QuestData,
  progress: Readonly<Record<string, SavedQuestStatus>>,
): SavedQuestStatus | undefined {
  const aliases = new Set(
    [quest.id, quest.normalizedName]
      .map((value) => value.trim().toLocaleLowerCase("en-US"))
      .filter(Boolean),
  );
  return Object.entries(progress).find(
    ([key]) => aliases.has(key.trim().toLocaleLowerCase("en-US")),
  )?.[1];
}

export function InProgressQuestDialog({
  open,
  quests,
  progress,
  onClose,
  onApply,
}: InProgressQuestDialogProps) {
  const [search, setSearch] = useState("");
  const [trader, setTrader] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const availableQuests = useMemo(
    () => quests
      .filter((quest) => savedStatus(quest, progress) === undefined)
      .sort((left, right) => {
        const traderOrder = left.trader.localeCompare(right.trader, "en");
        return traderOrder || displayName(left).localeCompare(displayName(right), "ko");
      }),
    [progress, quests],
  );
  const traders = useMemo(
    () => [...new Set(availableQuests.map((quest) => quest.trader).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, "en")),
    [availableQuests],
  );
  const filteredQuests = useMemo(() => {
    const term = normalizeQuestSearchText(search);
    return availableQuests.filter((quest) => {
      const matchesTrader = trader === "all" || quest.trader === trader;
      const matchesSearch = !term || [
        quest.name,
        quest.nameEn,
        quest.nameKo,
        quest.nameJa,
        ...(quest.nameAliases ?? []),
      ].some((name) => name && normalizeQuestSearchText(name).includes(term));
      return matchesTrader && matchesSearch;
    });
  }, [availableQuests, search, trader]);
  const selectedQuestIds = useMemo(
    () => quests.filter((quest) => selectedIds.has(quest.id)).map((quest) => quest.id),
    [quests, selectedIds],
  );
  const prerequisites = useMemo(
    () => getManualPrerequisites(selectedQuestIds, quests, progress),
    [progress, quests, selectedQuestIds],
  );

  const close = () => {
    setSearch("");
    setTrader("all");
    setSelectedIds(new Set());
    onClose();
  };

  return (
    <Dialog
      description="현재 진행 중인 퀘스트를 고르면 아직 완료되지 않은 모든 선행 퀘스트를 미리 보여 줍니다. 선택한 퀘스트 자체는 완료 처리하지 않습니다."
      footer={(
        <>
          <button onClick={close} type="button">취소</button>
          <button
            className="primary"
            disabled={selectedQuestIds.length === 0}
            onClick={() => {
              onApply(selectedQuestIds, prerequisites.map((quest) => quest.id));
              close();
            }}
            type="button"
          >
            선행 퀘스트 완료 적용
          </button>
        </>
      )}
      onClose={close}
      open={open}
      title="진행 중인 퀘스트 입력"
      wide
    >
      <div className="in-progress-controls">
        <label>
          <span>검색</span>
          <input
            aria-label="퀘스트 검색"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="퀘스트 이름"
            type="search"
            value={search}
          />
        </label>
        <label>
          <span>상인</span>
          <select
            aria-label="상인 필터"
            onChange={(event) => setTrader(event.target.value)}
            value={trader}
          >
            <option value="all">전체 상인</option>
            {traders.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>

      <div className="in-progress-layout">
        <section aria-label="진행 중인 퀘스트 선택" className="in-progress-selection">
          <header>
            <strong>퀘스트 선택</strong>
            <span>{selectedQuestIds.length}개 선택</span>
          </header>
          {filteredQuests.length ? (
            <ul>
              {filteredQuests.map((quest) => (
                <li key={quest.id}>
                  <label>
                    <input
                      checked={selectedIds.has(quest.id)}
                      onChange={(event) => {
                        const checked = event.target.checked;
                        setSelectedIds((current) => {
                          const next = new Set(current);
                          if (checked) next.add(quest.id);
                          else next.delete(quest.id);
                          return next;
                        });
                      }}
                      type="checkbox"
                    />
                    <span>
                      <strong>{displayName(quest)}</strong>
                      {quest.name !== displayName(quest) ? <small>{quest.name}</small> : null}
                    </span>
                    <small>{quest.trader}</small>
                  </label>
                </li>
              ))}
            </ul>
          ) : <p className="settings-note">선택할 수 있는 퀘스트가 없습니다.</p>}
        </section>

        <section aria-label="완료할 선행 퀘스트" className="in-progress-prerequisites">
          <header>
            <strong>완료할 선행 퀘스트</strong>
            <span>{prerequisites.length}개</span>
          </header>
          {prerequisites.length ? (
            <ul>
              {prerequisites.map((quest) => (
                <li key={quest.id}>
                  <span>
                    <strong>{displayName(quest)}</strong>
                    {quest.name !== displayName(quest) ? <small>{quest.name}</small> : null}
                  </span>
                  <small>{quest.trader}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p className="settings-note">
              퀘스트를 선택하면 완료 처리될 선행 퀘스트가 여기에 표시됩니다.
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}
