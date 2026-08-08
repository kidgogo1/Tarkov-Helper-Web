import { ExternalLink, MapPin, RotateCcw } from "lucide-react";

import { ProgressBar } from "../../components/ProgressBar";
import {
  groupQuestRequirementsForDisplay,
  isScavKarmaRequirementMet,
  type QuestStatusResolver,
} from "../../domain/quests";
import type { QuestData, QuestRequirement, TarkovData } from "../../types/data";
import type { ProfileState, QuestStatus } from "../../types/state";
import {
  alternateQuestDisplayName,
  objectiveDisplayText,
  questDisplayName,
  type QuestLanguage,
} from "./quest-language";

interface QuestDetailProps {
  data: TarkovData;
  profile: ProfileState;
  quest: QuestData;
  status: QuestStatus;
  statusResolver: QuestStatusResolver;
  language: QuestLanguage;
  onComplete: (quest: QuestData) => void;
  onObjectiveChange: (objectiveId: string, completed: boolean) => void;
  onOpenItem: (itemId: string) => void;
  onOpenMap: (mapKey?: string, questId?: string) => void;
  onOpenQuest: (questId: string) => void;
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

function requirementLabel(requirement: QuestRequirement): string {
  const type = requirement.requirementType.toLocaleLowerCase("en-US");
  if (type === "fail" || type === "failed") return "실패 필요";
  if (type === "active" || type === "start" || type === "accept") {
    return "수락 필요";
  }
  return "완료 필요";
}

function dogtagConditionLabel(
  minimumLevel: number | undefined,
  faction: string | undefined,
): string | null {
  if (minimumLevel === undefined && !faction) return null;
  const details = ["인식표 조건"];
  if (faction) details.push(faction.toLocaleUpperCase("en-US"));
  if (minimumLevel !== undefined) details.push(`레벨 ${minimumLevel} 이상`);
  return details.join(" · ");
}

function canCompleteQuest(status: QuestStatus): boolean {
  return status === "active" || status === "locked" || status === "levelLocked";
}

function RelatedQuestList({
  data,
  ids,
  language,
  onOpenQuest,
}: {
  data: TarkovData;
  ids: readonly string[];
  language: QuestLanguage;
  onOpenQuest: (questId: string) => void;
}) {
  return (
    <ul className="quest-related-list">
      {ids.map((id) => {
        const related = data.quests.find(
          (candidate) => candidate.id === id || candidate.normalizedName === id,
        );
        return (
          <li key={id}>
            {related ? (
              <button
                className="quest-related-link"
                onClick={() => onOpenQuest(related.id)}
                type="button"
              >
                {questDisplayName(related, language)}
              </button>
            ) : id}
          </li>
        );
      })}
    </ul>
  );
}

function PrerequisiteList({
  data,
  language,
  onOpenQuest,
  requirements,
}: {
  data: TarkovData;
  language: QuestLanguage;
  onOpenQuest: (questId: string) => void;
  requirements: readonly QuestRequirement[];
}) {
  return (
    <ul className="quest-related-list">
      {requirements.map((requirement) => {
        const related = data.quests.find(
          (candidate) =>
            candidate.id === requirement.questId ||
            candidate.normalizedName === requirement.questId ||
            candidate.bsgId === requirement.questId,
        );
        return (
          <li key={`${requirement.groupId}-${requirement.questId}`}>
            {related ? (
              <button
                className="quest-related-link"
                onClick={() => onOpenQuest(related.id)}
                type="button"
              >
                {questDisplayName(related, language)}
              </button>
            ) : (
              <span>{requirement.questId}</span>
            )}
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
  statusResolver,
  language,
  onComplete,
  onObjectiveChange,
  onOpenItem,
  onOpenMap,
  onOpenQuest,
  onReset,
}: QuestDetailProps) {
  const requirementGroups = groupQuestRequirementsForDisplay(quest.requirements);
  const directRequirements = requirementGroups.direct;
  const alternativeGroups = requirementGroups.alternatives;
  const mapKey = resolveMapKey(data, quest);
  const kappaQuests = data.quests.filter((candidate) => candidate.kappaRequired);
  const completedKappaQuests = kappaQuests.filter(
    (candidate) => statusResolver.getStatus(candidate) === "done",
  ).length;
  const scavKarmaMet = isScavKarmaRequirementMet(quest, profile);

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
          <h2>{questDisplayName(quest, language)}</h2>
          {alternateQuestDisplayName(quest, language) ? (
            <p className="quest-english-name">
              {alternateQuestDisplayName(quest, language)}
            </p>
          ) : null}
        </div>
        <div className="quest-detail-actions">
          <button
            className="primary"
            disabled={!canCompleteQuest(status)}
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
        {quest.minScavKarma !== undefined ? (
          <span className={scavKarmaMet ? "condition-met" : "condition-unmet"}>
            스캐브 평판
            <span className="quest-condition-values">
              <strong>
                요구 {quest.minScavKarma.toFixed(2)} {quest.minScavKarma < 0 ? "이하" : "이상"}
              </strong>
              <small>
                현재 {profile.scavRep.toFixed(2)} · {scavKarmaMet ? "충족" : "미충족"}
              </small>
            </span>
          </span>
        ) : null}
      </div>

      {quest.kappaRequired ? (
        <div className="quest-kappa-progress">
          <ProgressBar
            label="카파 필수 퀘스트 진행"
            max={kappaQuests.length}
            tone="kappa"
            value={completedKappaQuests}
          />
        </div>
      ) : null}

      {quest.objectives.length > 0 ? (
        <section className="quest-detail-section">
          <h3>목표</h3>
          <ul className="quest-objectives">
            {[...quest.objectives]
              .sort((left, right) => left.sortOrder - right.sortOrder)
              .map((objective) => {
                const dogtagCondition = dogtagConditionLabel(
                  objective.dogtagMinLevel,
                  objective.dogtagFaction,
                );
                return (
                  <li key={objective.id}>
                    <label>
                      <input
                        checked={Boolean(profile.objectiveProgress[objective.id])}
                        onChange={(event) =>
                          onObjectiveChange(objective.id, event.target.checked)
                        }
                        type="checkbox"
                      />
                      <span>{objectiveDisplayText(objective, language)}</span>
                    </label>
                    <span className="quest-objective-meta">
                      {objective.mapName ? <small>{objective.mapName}</small> : null}
                      {dogtagCondition ? (
                        <small className="quest-dogtag-meta">{dogtagCondition}</small>
                      ) : null}
                    </span>
                  </li>
                );
              })}
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
                const dogtagCondition = dogtagConditionLabel(
                  requirement.dogtagMinLevel,
                  requirement.dogtagFaction,
                );
                return (
                  <li className={fulfilled ? "fulfilled" : ""} key={requirement.id}>
                    <button
                      className="quest-item-link"
                      onClick={() => onOpenItem(requirement.itemId)}
                      type="button"
                    >
                      <strong>{language === "ko"
                        ? item?.nameKo || requirement.itemName
                        : item?.nameEn || item?.name || requirement.itemName}</strong>
                      {item && language === "ko" && item.nameEn && item.nameEn !== item.nameKo ? (
                        <small>{item.nameEn}</small>
                      ) : null}
                      {dogtagCondition ? (
                        <small className="quest-dogtag-meta">{dogtagCondition}</small>
                      ) : null}
                    </button>
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
          <PrerequisiteList
            data={data}
            language={language}
            onOpenQuest={onOpenQuest}
            requirements={directRequirements}
          />
        </section>
      ) : null}

      {alternativeGroups.length > 0 ? (
        <section className="quest-detail-section">
          <h3>선택 선행 조건 (OR)</h3>
          {alternativeGroups.map((group) => (
            <div className="quest-or-group" key={group.groupId}>
              <small>그룹 {group.groupId} 중 하나</small>
              <PrerequisiteList
                data={data}
                language={language}
                onOpenQuest={onOpenQuest}
                requirements={group.requirements}
              />
            </div>
          ))}
        </section>
      ) : null}

      <div className="quest-link-grid">
        {quest.alternativeQuestIds.length > 0 ? (
          <section className="quest-detail-section">
            <h3>대안 퀘스트</h3>
            <RelatedQuestList
              data={data}
              ids={quest.alternativeQuestIds}
              language={language}
              onOpenQuest={onOpenQuest}
            />
          </section>
        ) : null}
        {quest.followUpQuestIds.length > 0 ? (
          <section className="quest-detail-section">
            <h3>후속 퀘스트</h3>
            <RelatedQuestList
              data={data}
              ids={quest.followUpQuestIds}
              language={language}
              onOpenQuest={onOpenQuest}
            />
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
