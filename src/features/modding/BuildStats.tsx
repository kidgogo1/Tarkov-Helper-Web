import { CircleAlert } from "lucide-react";

import type { BuildValidationResult, WeaponCatalogItem, WeaponStats } from "../../types/weapon-modding";
import "../../styles/weapon-modding-stats.css";

const metrics = [
  { key: "weight", label: "무게", unit: " kg", digits: 3, lower: true },
  { key: "ergonomics", label: "인체공학", unit: "", digits: 1, lower: false },
  { key: "accuracyMoa", label: "정확도", unit: " MOA", digits: 2, lower: true },
  { key: "verticalRecoil", label: "수직 반동", unit: "", digits: 1, lower: true },
  { key: "horizontalRecoil", label: "수평 반동", unit: "", digits: 1, lower: true },
  { key: "muzzleVelocityModifier", label: "총구 속도 보정", unit: "%", digits: 2, lower: false },
] as const;
type Metric = typeof metrics[number];

export function BuildStats({ itemById, stats, factoryStats, validation }: {
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  stats: WeaponStats;
  factoryStats: WeaponStats;
  validation: BuildValidationResult;
}) {
  return (
    <aside className="modding-stats modding-stat-comparison" aria-label="무기 능력치" role="region">
      <header>
        <span>현재 빌드 · 기본 총기와 비교</span>
        <strong className={validation.isValid ? "valid" : "invalid"}>
          {validation.isValid ? "사용 가능" : "확인 필요"}
        </strong>
      </header>
      <p className="modding-stat-explanation">기본 부품 포함 · 막대는 항목별 상대 비교 · 세로선은 기본값</p>
      <div className="modding-stat-table" role="table" aria-label="기본 총기 대비 성능">
        <div className="modding-stat-columns" role="row">
          <span role="columnheader">능력치</span><span role="columnheader">기본</span>
          <span role="columnheader">현재</span><span role="columnheader">기본 대비</span>
        </div>
        {metrics.map((metric) => <StatRow key={metric.key} metric={metric}
          current={statValue(stats, metric.key)} baseline={statValue(factoryStats, metric.key)} />)}
      </div>
      <p className="modding-stat-explanation">데이터 기준 예상치 · 탄약·내구도·스킬 효과 제외 · 총구 속도는 실제 m/s가 아닌 부품 보정률</p>
      {!validation.isValid ? (
        <div className="modding-issues">
          {validation.issues.slice(0, 6).map((issue, index) => {
            const item = itemById.get(issue.itemId ?? "");
            const slot = item?.slots?.find((candidate) => candidate.id === issue.slotId);
            return <p key={`${issue.code}:${index}`}>
              <CircleAlert aria-hidden="true" size={14} />
              {issue.code === "MISSING_REQUIRED_SLOT"
                ? `${item?.shortName ?? item?.name ?? "부품"} · ${slot?.name ?? "필수 부위"}: 필수 부품 미장착`
                : issue.message}
            </p>;
          })}
        </div>
      ) : null}
    </aside>
  );
}

function statValue(stats: WeaponStats, key: Metric["key"]) {
  // The calculator omits a zero velocity modifier; missing MOA has a different meaning.
  const value = key === "muzzleVelocityModifier" ? stats[key] ?? 0 : stats[key];
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

function format(value: number, metric: { key: string; digits: number; unit: string }) {
  const digits = metric.key === "weight" ? 3 : Number.isInteger(value) ? 0 : metric.digits;
  return `${value.toFixed(digits)}${metric.unit}`;
}

function StatRow({ metric, current, baseline }: {
  metric: Metric; current?: number; baseline?: number;
}) {
  const delta = current !== undefined && baseline !== undefined
    ? Number((current - baseline).toFixed(metric.digits)) : undefined;
  const velocity = metric.key === "muzzleVelocityModifier";
  const effect = !delta ? "unchanged" : velocity ? "neutral"
    : (delta < 0) === metric.lower ? "improved" : "reduced";
  const changeLabel = delta === undefined ? "비교 불가" : delta === 0 ? "변화 없음"
    : velocity ? delta > 0 ? "증가" : "감소" : effect === "improved" ? "개선" : "저하";
  return (
    <div className="modding-stat-row" role="row">
      {current !== undefined && baseline !== undefined ? (
        <StatGraph current={current} baseline={baseline} effect={effect} />
      ) : null}
      <span className="modding-stat-label" role="rowheader">{metric.label}</span>
      <span className="modding-stat-baseline" role="cell">{baseline === undefined ? "자료 없음" : format(baseline, metric)}</span>
      <strong className="modding-stat-current" role="cell">{current === undefined ? "자료 없음" : format(current, metric)}</strong>
      <span className="modding-stat-delta" role="cell" data-effect={effect}>
        {delta !== undefined && delta !== 0 ? <strong>
          {delta > 0 ? "+" : ""}{format(delta, { ...metric, unit: velocity ? "%p" : metric.unit })}
        </strong> : null}
        <small>{changeLabel}</small>
      </span>
    </div>
  );
}

function StatGraph({ current, baseline, effect }: { current: number; baseline: number; effect: string }) {
  // This is a relative comparison, not a claim about an in-game maximum.
  const range = Math.max(Math.abs(baseline) * 1.5, Math.abs(current), 1);
  const minimum = Math.min(current, baseline) < 0 ? -range : 0;
  const position = (value: number) => Math.max(0, Math.min(100, (value - minimum) / (range - minimum) * 100));
  const start = position(0);
  const end = position(current);
  const reference = position(baseline);
  return <span className="modding-stat-graph" aria-hidden="true">
    <span className="modding-stat-fill" style={{ left: `${Math.min(start, end)}%`, width: `${Math.abs(end - start)}%` }} />
    {effect !== "unchanged" ? <span className="modding-stat-change" data-effect={effect}
      style={{ left: `${Math.min(end, reference)}%`, width: `${Math.abs(end - reference)}%` }} /> : null}
    <span className="modding-stat-marker" style={{ left: `${reference}%` }} />
  </span>;
}
