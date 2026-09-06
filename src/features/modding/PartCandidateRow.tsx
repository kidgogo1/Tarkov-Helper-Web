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
            <PartPerformance item={candidate} />
          </span>
          {!disabled && !equipped ? <ReplacementPerformance delta={performanceDelta} /> : null}
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

function ReplacementPerformance({ delta }: { delta: PartCandidatePerformanceDelta }) {
  const metrics = [
    { label: "수직 반동", value: delta.recoil, digits: 1, unit: "", lower: true },
    { label: "인체공학", value: delta.ergonomics, digits: 1, unit: "", lower: false },
    { label: "무게", value: delta.weight, digits: 3, unit: " kg", lower: true },
    { label: "정확도", value: delta.accuracy, digits: 2, unit: " MOA", lower: true },
    { label: "탄속 보정", value: delta.velocity, digits: 2, unit: "%p", lower: false },
  ].filter(({ value, digits }) => value !== undefined && Number.isFinite(value) &&
    Math.abs(value) >= 0.5 * 10 ** -digits);
  return (
    <span aria-label="교체 후 변화" className="modding-replacement-performance"
      title="현재 빌드 대비 예상 변화입니다. 함께 제거되는 하위·충돌 부품도 반영합니다.">
      <em>교체 후 변화</em>
      {metrics.length ? metrics.map(({ label, value, digits, unit, lower }) => (
        <span key={label} data-effect={(value! < 0) === lower ? "improved" : "reduced"}>
          {label} {signed(value!, digits)}{unit}
        </span>
      )) : <span>성능 변화 없음</span>}
    </span>
  );
}

function PartPerformance({ item }: { item: WeaponPartItem }) {
  if (!item.stats) return null;
  const stats = item.stats;
  const values = [
    stats.recoilModifier !== undefined && stats.recoilModifier !== 0
      ? `반동 ${signed(stats.recoilModifier)}%`
      : null,
    stats.ergonomics !== undefined && stats.ergonomics !== 0
      ? `인체공학 ${signed(stats.ergonomics)}`
      : null,
    stats.weight !== undefined && stats.weight !== 0
      ? `무게 ${formatNumber(stats.weight, 3)} kg`
      : null,
    stats.centerOfImpact !== undefined && stats.centerOfImpact !== 0
      ? `MOA ${signed(centerOfImpactToMoa(stats.centerOfImpact), 2)} · 낮을수록 좋음`
      : null,
    stats.muzzleVelocityModifier !== undefined && stats.muzzleVelocityModifier !== 0
      ? `탄속 ${signed(stats.muzzleVelocityModifier, 2)}%`
      : null,
  ].filter((value): value is string => Boolean(value));
  if (!values.length) return null;
  return (
    <span className="modding-part-performance" title="부품 데이터에 등록된 고유 효과">
      <em>부품 효과</em>
      {values.map((value) => <span key={value}>{value}</span>)}
    </span>
  );
}

function formatNumber(value: number, digits = 0): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function signed(value: number, digits = 0): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value, digits)}`;
}
