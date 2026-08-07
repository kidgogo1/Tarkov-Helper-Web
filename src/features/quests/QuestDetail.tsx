import { ExternalLink, MapPin, RotateCcw } from "lucide-react";

import type { QuestData, QuestRequirement, TarkovData } from "../../types/data";
import type { ProfileState, QuestStatus } from "../../types/state";

interface QuestDetailProps {
  data: TarkovData;
  profile: ProfileState;
  quest: QuestData;
  status: QuestStatus;
  onComplete: (quest: QuestData) => void;
  onObjectiveChange: (objectiveId: string, completed: boolean) => void;
  onOpenMap: (mapKey?: string, questId?: string) => void;
  onReset: (quest: QuestData) => void;
}

const STATUS_LABELS: Record<QuestStatus, string> = {
  active: "진행 가능",
  locked: "선행 조건 잠김",
  levelLocked: "레벨 제한",
  unavailable: "이용 불가",
  done: "완료",
  failed: "실패",
};

function questName(quest: QuestData): string {
  return quest.nameKo || quest.name || quest.nameEn;
}

function requirementLabel(requirement: QuestRequirement): string {
  const type = requirement.requirementType.toLocaleLowerCase("en-US");
  if (type === "fail" || type === "failed") return "실패 필요";
  if (type === "active" || type === "start" || type === "accept") {
    return "수락 필요";
  }
  return "완료 필요";
}

function RelatedQuestList({
  data,
  ids,
}: {
  data: TarkovData;
  ids: readonly string[];
}) {
  return (
    <ul className="quest-related-list">
      {ids.map((id) => {
        const related = data.quests.find(
          (candidate) => candidate.id === id || candidate.normalizedName === id,
        );
        return <li key={id}>{related ? questName(related) : id}</li>;
      })}
    </ul>
  );
}

function PrerequisiteList({
  data,
  requirements,
}: {
  data: TarkovData;
  requirements: readonly QuestRequirement[];
}) {
  return (
    <ul className="quest-related-list">
      {requirements.map((requirement) => {
        const related = data.quests.find(
          (candidate) =>
            candidate.id === requirement.questId ||
            candidate.normalizedName === requirement.questId,
        );
        return (
          <li key={`${requirement.groupId}-${requirement.questId}`}>
            <span>{related ? questName(related) : requirement.questId}</span>
            <small>{requirementLabel(requirement)}</small>
          </li>
        );
      })}
    </ul>
  );
}

function resolveMapKey(data: TarkovData, quest: QuestData): string | undefined {
  const location =
    quest.locations[0] ||
    quest.objectives.find((objective) => objective.mapName)?.mapName;
  if (!location) return undefined;

  const normalized = location.toLocaleLowerCase("en-US");
  return data.mapConfigs.find(
    (map) =>
      map.key.toLocaleLowerCase("en-US") === normalized ||
      map.displayName.toLocaleLowerCase("en-US") === normalized ||
      map.aliases.some(
        (alias) => alias.toLocaleLowerCase("en-US") === normalized,
      ),
  )?.key;
}

export function QuestDetail({
  data,
  profile,
  quest,
  status,
  onComplete,
  onObjectiveChange,
  onOpenMap,
  onReset,
}: QuestDetailProps) {
  const directRequirements = quest.requirements.filter(
    (requirement) => requirement.groupId === 0,
  );
  const alternativeGroups = Array.from(
    new Set(
      quest.requirements
        .filter((requirement) => requirement.groupId > 0)
        .map((requirement) => requirement.groupId),
    ),
  );
  const mapKey = resolveMapKey(data, quest);

  return (
    <article className="quest-detail panel" aria-label="퀘스트 상세">
      <header className="quest-detail-header">
        <div>
          <div className="quest-detail-badges">
            <span className={`badge quest-status status-${status}`}>
              {STATUS_LABELS[status]}
            </span>
            {quest.kappaRequired ? <span className="badge kappa">KAPPA</span> : null}
            <span className="badge">{quest.trader}</span>
          </div>
          <h2>{questName(quest)}</h2>
          {quest.nameEn && quest.nameEn !== questName(quest) ? (
            <p className="quest-english-name">{quest.nameEn}</p>
          ) : null}
        </div>
        <div className="quest-detail-actions">
          <button
            className="primary"
            disabled={status === "done"}
            onClick={() => onComplete(quest)}
            type="button"
          >
            퀘스트 완료
          </button>
          <button onClick={() => onReset(quest)} type="button">
            <RotateCcw aria-hidden="true" size={14} />
            완료 초기화
          </button>
        </div>
      </header>

      <div className="quest-facts">
        <span>요구 레벨 <strong>{quest.minLevel ?? 1}</strong></span>
        <span>지역 <strong>{quest.locations.join(", ") || "제한 없음"}</strong></span>
        <span>목표 <strong>{quest.objectives.length}</strong></span>
      </div>

      {quest.objectives.length > 0 ? (
        <section className="quest-detail-section">
          <h3>목표</h3>
          <ul className="quest-objectives">
            {[...quest.objectives]
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((objective) => (
                <li key={objective.id}>
                  <label>
                    <input
                      checked={Boolean(profile.objectiveProgress[objective.id])}
                      onChange={(event) =>
                        onObjectiveChange(objective.id, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <span>{objective.description}</span>
                  </label>
                  {objective.mapName ? <small>{objective.mapName}</small> : null}
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {quest.requiredItems.length > 0 ? (
        <section className="quest-detail-section">
          <h3>필수 아이템</h3>
          <ul className="quest-required-items">
            {[...quest.requiredItems]
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((requirement) => {
                const inventory = profile.inventory[requirement.itemId] ?? {
                  fir: 0,
                  nonFir: 0,
                };
                const owned = requirement.requiresFir
                  ? inventory.fir
                  : inventory.fir + inventory.nonFir;
                const fulfilled = owned >= requirement.count;
                const item = data.items.find(
                  (candidate) => candidate.id === requirement.itemId,
                );
                return (
                  <li className={fulfilled ? "fulfilled" : ""} key={requirement.id}>
                    <div>
                      <strong>{item?.nameKo || requirement.itemName}</strong>
                      {item?.nameEn && item.nameEn !== item.nameKo ? (
                        <small>{item.nameEn}</small>
                      ) : null}
                    </div>
                    <span>보유 {owned} / 필요 {requirement.count}</span>
                    <span className="item-fulfillment">
                      {fulfilled ? "충족" : `${requirement.count - owned}개 부족`}
                    </span>
                    {requirement.requiresFir ? <span className="badge">FIR</span> : null}
                  </li>
                );
              })}
          </ul>
        </section>
      ) : null}

      {directRequirements.length > 0 ? (
        <section className="quest-detail-section">
          <h3>선행 퀘스트</h3>
          <PrerequisiteList data={data} requirements={directRequirements} />
        </section>
      ) : null}

      {alternativeGroups.length > 0 ? (
        <section className="quest-detail-section">
          <h3>선택 선행 조건 (OR)</h3>
          {alternativeGroups.map((groupId) => (
            <div className="quest-or-group" key={groupId}>
              <small>그룹 {groupId} 중 하나</small>
              <PrerequisiteList
                data={data}
                requirements={quest.requirements.filter(
                  (requirement) => requirement.groupId === groupId,
                )}
              />
            </div>
          ))}
        </section>
      ) : null}

      <div className="quest-link-grid">
        {quest.alternativeQuestIds.length > 0 ? (
          <section className="quest-detail-section">
            <h3>대안 퀘스트</h3>
            <RelatedQuestList data={data} ids={quest.alternativeQuestIds} />
          </section>
        ) : null}
        {quest.followUpQuestIds.length > 0 ? (
          <section className="quest-detail-section">
            <h3>후속 퀘스트</h3>
            <RelatedQuestList data={data} ids={quest.followUpQuestIds} />
          </section>
        ) : null}
      </div>

      <footer className="quest-detail-footer">
        <button onClick={() => onOpenMap(mapKey, quest.id)} type="button">
          <MapPin aria-hidden="true" size={15} />
          지도에서 보기
        </button>
        {quest.wikiPageLink ? (
          <a
            className="button"
            href={quest.wikiPageLink}
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink aria-hidden="true" size={14} />
            위키 열기
          </a>
        ) : null}
      </footer>
    </article>
  );
}
