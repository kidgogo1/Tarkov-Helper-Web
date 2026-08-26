import { Maximize2 } from "lucide-react";

import { centerOfImpactToMoa } from "../../domain/weapon-build";
import type { ProfileType } from "../../types/data";
import type { WeaponPartItem } from "../../types/weapon-modding";
import { PartCandidatePrice } from "./PartCandidatePrice";
import type { CandidateAvailability } from "./part-candidate-controls";
import { WeaponItemImage } from "./WeaponItemImage";

interface PartCandidateRowProps {
  activeProfile: ProfileType;
  availability: CandidateAvailability;
  candidate: WeaponPartItem;
  conflictMessage: string | null;
  disabled: boolean;
  onPreview: (candidate: WeaponPartItem, trigger: HTMLButtonElement) => void;
  onSelect: () => void;
}

export function PartCandidateRow({
  activeProfile,
  availability,
  candidate,
  conflictMessage,
  disabled,
  onPreview,
  onSelect,
}: PartCandidateRowProps) {
  const displayName = candidate.nameKo ?? candidate.name;
  return (
    <li className={`modding-part-row ${availability}`}>
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
        className={`modding-part-select ${availability}`}
        disabled={disabled}
        onClick={onSelect}
        type="button"
      >
        <span className="modding-part-details">
          <strong className="modding-part-name">{displayName}</strong>
          <span className="modding-part-summary">
            <small>{candidate.shortName ?? candidate.nameEn ?? candidate.name}</small>
            <PartPerformance item={candidate} />
          </span>
          {conflictMessage ? (
            <span className={`modding-part-conflict ${availability}`}>
              {conflictMessage}
            </span>
          ) : null}
          <PartCandidatePrice activeProfile={activeProfile} item={candidate} />
        </span>
      </button>
    </li>
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
    <span className="modding-part-performance">
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
