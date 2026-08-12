import { useMemo } from "react";
import { ListChecks, MapPin, X } from "lucide-react";

import type { ProfileType, QuestData } from "../../types/data";
import type { ProfileState } from "../../types/state";
import { objectiveDisplayText } from "../quests/quest-language";

export interface QuestOverlaySurfaceProps {
  activeProfile: ProfileType;
  onClose: () => void;
  onObjectiveChange: (objectiveId: string, completed: boolean) => void;
  onQuestTrackedChange: (questId: string, tracked: boolean) => void;
  presentation: "dock" | "popup";
  profile: ProfileState;
  quests: readonly QuestData[];
}

function questName(quest: QuestData): string {
  return quest.nameKo?.trim() || quest.name;
}

export function QuestOverlaySurface({
  activeProfile,
  onClose,
  onObjectiveChange,
  onQuestTrackedChange,
  presentation,
  profile,
  quests,
}: QuestOverlaySurfaceProps) {
  const questsById = useMemo(
    () => new Map(quests.map((quest) => [quest.id, quest])),
    [quests],
  );
  const trackedQuests = profile.trackedQuestIds.flatMap((questId) => {
    const quest = questsById.get(questId);
    return quest ? [quest] : [];
  });

  return (
    <aside
      aria-label="퀘스트 창"
      className={`quest-overlay quest-overlay--${presentation}`}
      data-presentation={presentation}
      role="complementary"
    >
      <header className="quest-overlay-header">
        <div>
          <p>{activeProfile.toUpperCase()} 선택 퀘스트</p>
          <h2>퀘스트 목표</h2>
        </div>
        <span className="quest-overlay-count">{trackedQuests.length}개</span>
        <button aria-label="퀘스트 창 닫기" onClick={onClose} type="button">
          <X aria-hidden="true" size={18} />
        </button>
      </header>

      {presentation === "dock" ? (
        <p className="quest-overlay-notice" role="status">
          팝업이 차단되어 페이지 안에 열었습니다. 브라우저에서 팝업을 허용하면 별도 창으로 사용할 수 있습니다.
        </p>
      ) : null}

      <div className="quest-overlay-body">
        {trackedQuests.length ? (
          trackedQuests.map((quest) => {
            const orderedObjectives = [...quest.objectives]
              .sort((left, right) => left.sortOrder - right.sortOrder);
            const completedCount = orderedObjectives.filter(
              (objective) => profile.objectiveProgress[objective.id],
            ).length;
            const name = questName(quest);
            const status = profile.questProgress[quest.id];
            return (
              <article aria-label={`${name} 퀘스트 목표`} className="quest-overlay-card" key={quest.id}>
                <header>
                  <div>
                    <span className="quest-overlay-trader">{quest.trader}</span>
                    {status ? (
                      <span className={`quest-overlay-status quest-overlay-status--${status}`}>
                        {status === "done" ? "완료" : "실패"}
                      </span>
                    ) : null}
                    <h3>{name}</h3>
                    {quest.name !== name ? <small>{quest.name}</small> : null}
                  </div>
                  <button
                    aria-label={`${name} 퀘스트 창에서 제거`}
                    className="quest-overlay-remove"
                    onClick={() => onQuestTrackedChange(quest.id, false)}
                    title="퀘스트 창에서 제거"
                    type="button"
                  >
                    <X aria-hidden="true" size={14} />
                  </button>
                </header>
                <div className="quest-overlay-card-summary">
                  <span>{completedCount} / {orderedObjectives.length} 완료</span>
                  {quest.locations.length ? (
                    <span><MapPin aria-hidden="true" size={12} />{quest.locations.join(", ")}</span>
                  ) : null}
                </div>
                {orderedObjectives.length ? (
                  <ul className="quest-overlay-objectives">
                    {orderedObjectives.map((objective) => {
                      const text = objectiveDisplayText(objective, "ko");
                      const completed = Boolean(profile.objectiveProgress[objective.id]);
                      return (
                        <li className={completed ? "completed" : ""} key={objective.id}>
                          <label>
                            <input
                              checked={completed}
                              onChange={(event) => onObjectiveChange(objective.id, event.target.checked)}
                              type="checkbox"
                            />
                            <span>{text}</span>
                          </label>
                          {objective.mapName ? <small>{objective.mapName}</small> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="quest-overlay-card-empty">표시할 목표가 없습니다.</p>
                )}
              </article>
            );
          })
        ) : (
          <div className="quest-overlay-empty" role="status">
            <ListChecks aria-hidden="true" size={32} />
            <strong>표시할 퀘스트가 없습니다.</strong>
            <span>퀘스트 상세에서 ‘퀘스트 창에 표시’를 체크해 주세요.</span>
          </div>
        )}
      </div>
    </aside>
  );
}
