import { ExternalLink, Image as ImageIcon, MapPinned } from "lucide-react";

import type { QuestData, QuestWikiGuide } from "../../types/data";
import type { QuestLanguage } from "./quest-language";

interface QuestWikiGuidePanelProps {
  quest: QuestData;
  guide: QuestWikiGuide | undefined;
  language: QuestLanguage;
}

function normalize(value: string): string {
  const normalized = value
    .toLocaleLowerCase("en-US")
    .replace(/the\s+lab/g, "thelab")
    .replace(/streets?\s+of\s+tarkov/g, "streetsoftarkov")
    .replace(/ground\s+zero/g, "groundzero")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  return normalized === "labs" ? "thelab" : normalized;
}

function locationMatches(quest: QuestData, guide: QuestWikiGuide): boolean {
  const appLocations = quest.locations.map(normalize).filter(Boolean);
  const wikiLocations = guide.wikiLocation.map(normalize).filter(Boolean);
  return wikiLocations.length > 0 && wikiLocations.every((location) => appLocations.includes(location));
}

function objectiveMatches(quest: QuestData, guide: QuestWikiGuide): number {
  const appObjectives = quest.objectives.map((objective) => normalize(objective.description)).filter(Boolean);
  return guide.wikiObjectives.filter((wikiObjective) => {
    const normalized = normalize(wikiObjective);
    return appObjectives.some(
      (appObjective) => appObjective === normalized || appObjective.includes(normalized) || normalized.includes(appObjective),
    );
  }).length;
}

export function QuestWikiGuidePanel({ quest, guide, language }: QuestWikiGuidePanelProps) {
  const isKorean = language === "ko";
  if (!guide || guide.error) {
    return (
      <section aria-label={isKorean ? "위키 위치 검증" : "Wiki location verification"} className="quest-wiki-guide quest-detail-section">
        <div className="quest-wiki-guide-heading">
          <h3><MapPinned aria-hidden="true" size={14} /> {isKorean ? "위키 위치·내용 검증" : "Wiki location & objective check"}</h3>
          <span className="quest-wiki-guide-unavailable">{isKorean ? "확인되지 않음" : "Not verified"}</span>
        </div>
        <p className="quest-wiki-guide-empty">
          {isKorean
            ? "이 퀘스트의 위키 페이지를 읽지 못했습니다. 아래 원문 링크에서 직접 확인하세요."
            : "The Wiki page could not be read. Check the original page below."}
        </p>
      </section>
    );
  }

  const matchedObjectives = objectiveMatches(quest, guide);
  const objectiveCount = guide.wikiObjectives.length;
  const matches = locationMatches(quest, guide) && (objectiveCount === 0 || matchedObjectives === objectiveCount);
  return (
    <section aria-label={isKorean ? "위키 위치 검증" : "Wiki location verification"} className="quest-wiki-guide quest-detail-section">
      <div className="quest-wiki-guide-heading">
        <h3><MapPinned aria-hidden="true" size={14} /> {isKorean ? "위키 위치·내용 검증" : "Wiki location & objective check"}</h3>
        <span className={`quest-wiki-guide-status ${matches ? "verified" : "review"}`}>
          {matches ? (isKorean ? "일치" : "Matched") : (isKorean ? "확인 필요" : "Review")}
        </span>
      </div>
      <div className="quest-wiki-guide-facts">
        <span>
          <small>{isKorean ? "위키 지역" : "Wiki location"}</small>
          <strong>{guide.wikiLocation.join(", ") || (isKorean ? "위치 표기 없음" : "Not listed")}</strong>
        </span>
        <span>
          <small>{isKorean ? "앱 목표 대조" : "Objective comparison"}</small>
          <strong>{objectiveCount > 0 ? `${matchedObjectives}/${objectiveCount}` : (isKorean ? "목표 표기 없음" : "Not listed")}</strong>
        </span>
      </div>
      {!locationMatches(quest, guide) ? (
        <p className="quest-wiki-guide-warning">
          {isKorean
            ? `앱 지역(${quest.locations.join(", ") || "없음"})과 위키 지역이 다릅니다. 위키 원문을 확인하세요.`
            : `The app location (${quest.locations.join(", ") || "none"}) differs from the Wiki. Check the source.`}
        </p>
      ) : null}
      {guide.guideSummary ? (
        <div className="quest-wiki-guide-summary">
          <strong>{isKorean ? "위키 가이드 요약" : "Wiki guide summary"}</strong>
          <p>{guide.guideSummary}</p>
        </div>
      ) : null}
      {guide.wikiObjectives.length > 0 ? (
        <details className="quest-wiki-guide-objectives">
          <summary>{isKorean ? `위키 목표 원문 ${guide.wikiObjectives.length}개` : `Wiki objectives (${guide.wikiObjectives.length})`}</summary>
          <ul>
            {guide.wikiObjectives.map((objective) => <li key={objective}>{objective}</li>)}
          </ul>
        </details>
      ) : null}
      {guide.images.length > 0 ? (
        <div className="quest-wiki-guide-images">
          <div className="quest-wiki-guide-images-title"><ImageIcon aria-hidden="true" size={13} /> {isKorean ? "위키 위치 사진" : "Wiki location images"}</div>
          <div className="quest-wiki-guide-gallery">
            {guide.images.map((image) => (
              <a href={quest.wikiPageLink} key={`${image.url}-${image.caption}`} rel="noreferrer" target="_blank">
                <img alt={image.caption} loading="lazy" referrerPolicy="no-referrer" src={image.url} />
                <span>{image.caption}</span>
              </a>
            ))}
          </div>
        </div>
      ) : null}
      <div className="quest-wiki-guide-footer">
        <small>
          {guide.wikiRevisionId ? `${isKorean ? "위키 개정" : "Wiki revision"} #${guide.wikiRevisionId}` : (isKorean ? "위키 원문 기준" : "From Wiki source")}
        </small>
        <a href={quest.wikiPageLink} rel="noreferrer" target="_blank">
          <ExternalLink aria-hidden="true" size={12} /> {isKorean ? "위키 원문 열기" : "Open Wiki source"}
        </a>
      </div>
    </section>
  );
}
