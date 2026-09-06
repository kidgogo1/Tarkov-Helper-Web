import { Maximize2 } from "lucide-react";

import { centerOfImpactToMoa } from "../../domain/weapon-build";
import type { ProfileType } from "../../types/data";
import type { WeaponPartItem } from "../../types/weapon-modding";
import { PartCandidatePrice } from "./PartCandidatePrice";
import type {
  CandidateAvailability,
  PartCandidateFilters,
  PartCandidatePerformanceDelta,
} from "./part-candidate-controls";
import { WeaponItemImage } from "./WeaponItemImage";
import "../../styles/weapon-modding-candidate-stats.css";

interface PartCandidateRowProps {
  activeProfile: ProfileType;
  availability: CandidateAvailability;
  candidate: WeaponPartItem;
  conflictMessage: string | null;
  disabled: boolean;
  equipped: boolean;
  filters: PartCandidateFilters;
  performanceDelta: PartCandidatePerformanceDelta;
  onPreview: (candidate: WeaponPartItem, trigger: HTMLButtonElement) => void;
  onSelect: () => void;
}

export function PartCandidateRow({
  activeProfile,
  availability,
  candidate,
  conflictMessage,
  disabled,
  equipped,
  filters,
  performanceDelta,
  onPreview,
  onSelect,
}: PartCandidateRowProps) {
  const displayName = candidate.nameKo ?? candidate.name;
  return (
    <li className={`modding-part-row ${availability}${equipped ? " equipped" : ""}`}>
      <button
        aria-haspopup="dialog"
        aria-label={`${displayName} 이미지 크게 보기`}
        className="modding-part-preview"
        onClick={(event) => onPreview(candidate, event.currentTarget)}
        title="이미지 크게 보기"
        type="button"
      >
        <span className="modding-part-image" aria-hidden="true">
          <WeaponItemImage
            alt=""
            fallbackSize={22}
            loading="lazy"
            src={candidate.iconUrl ?? candidate.imageUrl}
          />
        </span>
        <Maximize2 aria-hidden="true" className="modding-preview-icon" size={11} />
      </button>
      <button
        aria-label={`${displayName} 장착`}
        aria-pressed={equipped}
        className={`modding-part-select ${availability}`}
        disabled={disabled || equipped}
        onClick={onSelect}
        type="button"
      >
        <span className="modding-part-details">
          <strong className="modding-part-name">{displayName}</strong>
          {equipped ? <span className="modding-equipped-badge">현재 장착</span> : null}
          <span className="modding-part-summary">
            <small>{candidate.shortName ?? candidate.nameEn ?? candidate.name}</small>
          </span>
          <CandidatePerformance item={candidate}
            delta={!disabled && !equipped ? performanceDelta : undefined} />
          {conflictMessage ? (
            <span className={`modding-part-conflict ${availability}`}>
              {conflictMessage}
            </span>
          ) : null}
          <PartCandidatePrice activeProfile={activeProfile} filters={filters} item={candidate} />
        </span>
      </button>
    </li>
  );
}

interface CandidateMetric {
  label: string;
  intrinsic?: number;
  delta?: number;
  digits: number;
  unit: string;
  intrinsicUnit?: string;
  unsigned?: boolean;
  lower: boolean;
}

function CandidatePerformance({ item, delta }: {
  item: WeaponPartItem;
  delta?: PartCandidatePerformanceDelta;
}) {
  const stats = item.stats ?? {};
  const accuracy = stats.centerOfImpact === undefined ? undefined
    : Math.sign(stats.centerOfImpact) * centerOfImpactToMoa(Math.abs(stats.centerOfImpact));
  const metrics: CandidateMetric[] = [
    { label: "반동 보정", intrinsic: stats.recoilModifier, digits: 1, unit: "%", lower: true },
    { label: "수직 반동", delta: delta?.recoil, digits: 1, unit: "", lower: true },
    { label: "인체공학", intrinsic: stats.ergonomics, delta: delta?.ergonomics,
      digits: 1, unit: "", lower: false },
    { label: "무게", intrinsic: stats.weight, delta: delta?.weight,
      digits: 3, unit: " kg", unsigned: true, lower: true },
    { label: "정확도", intrinsic: accuracy, delta: delta?.accuracy,
      digits: 2, unit: " MOA", lower: true },
    { label: "탄속 보정", intrinsic: stats.muzzleVelocityModifier, delta: delta?.velocity,
      digits: 2, unit: "%p", intrinsicUnit: "%", lower: false },
  ];
  const rows = metrics.filter((metric) => isFiniteValue(metric.intrinsic) ||
    (isFiniteValue(metric.delta) && roundForDisplay(metric.delta, metric.digits) !== 0));
  if (!rows.length) return <span className="modding-candidate-stat-empty">
    {metrics.some((metric) => isFiniteValue(metric.delta)) ? "성능 변화 없음" : "성능 정보 없음"}
  </span>;
  return (
    <span aria-label="부품 수치 비교" className={`modding-candidate-stat-grid${delta ? " with-change" : ""}`}>
      <span className="modding-candidate-stat-column labels" aria-hidden="true">
        <em>수치</em>
        {rows.map(({ label }) => <span key={label}>{label}</span>)}
      </span>
      <span aria-label="부품 효과" className="modding-candidate-stat-column"
        title="부품 데이터에 등록된 고유 효과">
        <em>부품 효과</em>
        {rows.map((metric) => <MetricValue key={metric.label} metric={metric} />)}
      </span>
      {delta ? <span aria-label="교체 후 변화" className="modding-candidate-stat-column change"
        title="현재 빌드 대비 예상 변화입니다. 함께 제거되는 하위·충돌 부품도 반영합니다.">
        <em>교체 후 변화</em>
        {rows.map((metric) => <MetricValue key={metric.label} metric={metric} replacement />)}
      </span> : null}
    </span>
  );
}

function MetricValue({ metric, replacement = false }: { metric: CandidateMetric; replacement?: boolean }) {
  const rawValue = replacement ? metric.delta : metric.intrinsic;
  const value = isFiniteValue(rawValue) ? roundForDisplay(rawValue, metric.digits) : undefined;
  const unit = replacement ? metric.unit : metric.intrinsicUnit ?? metric.unit;
  const text = value === undefined ? "—" :
    `${!replacement && metric.unsigned ? formatNumber(value, metric.digits) : signed(value, metric.digits)}${unit}`;
  const effect = replacement && value !== undefined && value !== 0
    ? (value < 0) === metric.lower ? "improved" : "reduced" : undefined;
  return <span aria-label={`${metric.label} ${value === undefined ? "정보 없음" : text}`}
    className="modding-candidate-stat-value" data-effect={effect}
    title={effect ? effect === "improved" ? "현재 빌드보다 유리" : "현재 빌드보다 불리" : undefined}>
    <span className="modding-stat-hidden-label">{metric.label} </span>{text}
  </span>;
}

function isFiniteValue(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

function roundForDisplay(value: number, digits: number): number {
  const rounded = Number(value.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function formatNumber(value: number, digits = 0): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function signed(value: number, digits = 0): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value, digits)}`;
}
