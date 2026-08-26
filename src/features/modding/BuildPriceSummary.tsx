import {
  BadgeRussianRuble,
  Coins,
  Store,
} from "lucide-react";

import { formatRoubles } from "../../domain/item-prices";
import type { ProfileType } from "../../types/data";
import type {
  BuildPriceGroupSummary,
  BuildPriceStrategy,
  BuildPriceSummary as BuildPriceSummaryModel,
} from "./build-price-summary";

interface BuildPriceSummaryProps {
  activeProfile: ProfileType;
  summary: BuildPriceSummaryModel;
}

const STRATEGIES: ReadonlyArray<{
  key: BuildPriceStrategy;
  label: string;
  regionLabel: string;
}> = [
  { key: "trader", label: "상인만", regionLabel: "상인만 부품 가격" },
  { key: "flea", label: "플리만", regionLabel: "플리만 부품 가격" },
  { key: "cheapest", label: "최저가 혼합", regionLabel: "최저가 부품 가격" },
];

export function BuildPriceSummary({
  activeProfile,
  summary,
}: BuildPriceSummaryProps) {
  const traderWeapon = summary.strategies.trader.weapon;
  const fleaWeapon = summary.strategies.flea.weapon;
  const cheapestWeapon = summary.strategies.cheapest.weapon;

  return (
    <section
      aria-label="빌드 가격 요약"
      className="modding-build-price-summary"
      role="region"
    >
      <header className="modding-build-price-heading">
        <div>
          <Coins aria-hidden="true" size={16} />
          <strong>빌드 구매 비용</strong>
          <span className="modding-price-profile">{activeProfile.toUpperCase()}</span>
        </div>
        <small>번들 참고가 · 실시간 시세 아님</small>
      </header>

      <div className="modding-build-price-body">
        <section
          aria-label="원본 총기 가격"
          className="modding-base-weapon-prices"
          role="region"
        >
          <header>
            <div>
              <Store aria-hidden="true" size={14} />
              <strong>원본 총기 가격</strong>
            </div>
            <small>총기 본체 항목 기준</small>
          </header>
          <dl>
            <PriceMetric
              group={traderWeapon}
              label="상점 최저"
              meta={formatSingleTraderRequirement(traderWeapon)}
            />
            <PriceMetric
              group={fleaWeapon}
              label="플리 참고가"
              meta={formatFleaRequirement(fleaWeapon)}
            />
            <PriceMetric
              group={cheapestWeapon}
              label="둘 중 최저"
              meta={formatSourceLabel(cheapestWeapon)}
            />
          </dl>
        </section>

        <section
          aria-label="현재 장착 부품 가격 비교"
          className="modding-parts-price-comparison"
          role="region"
        >
          <header>
            <div>
              <BadgeRussianRuble aria-hidden="true" size={14} />
              <strong>장착 부품 총합</strong>
            </div>
            <small>장착 부품 {summary.partCount}개 · 원본 총기 제외</small>
          </header>
          <div className="modding-parts-price-plans">
            {STRATEGIES.map(({ key, label, regionLabel }) => (
              <PricePlan
                group={summary.strategies[key].parts}
                key={key}
                label={label}
                regionLabel={regionLabel}
                strategy={key}
              />
            ))}
          </div>
        </section>
      </div>

      <TraderRequirements summary={summary} />
      <p className="modding-build-price-note">
        상점 재고·구매 제한·교환 재료는 반영하지 않습니다. 원본 총기는 본체 항목
        참고가라 상점 기본 프리셋 완제품과 다를 수 있으며, 부품 합계와 더하지 않습니다.
      </p>
    </section>
  );
}

function PriceMetric({
  group,
  label,
  meta,
}: {
  group: BuildPriceGroupSummary;
  label: string;
  meta: string;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {formatGroupPrice(group)}
        <small>{group.missingItemCount ? missingPriceLabel(group) : meta}</small>
      </dd>
    </div>
  );
}

function PricePlan({
  group,
  label,
  regionLabel,
  strategy,
}: {
  group: BuildPriceGroupSummary;
  label: string;
  regionLabel: string;
  strategy: BuildPriceStrategy;
}) {
  return (
    <section aria-label={regionLabel} className={`modding-price-plan ${strategy}`} role="region">
      <span>{label}</span>
      <strong>{formatGroupPrice(group)}</strong>
      <small>
        {group.missingItemCount
          ? missingPriceLabel(group)
          : formatPartPlanMeta(group, strategy)}
      </small>
    </section>
  );
}

function TraderRequirements({ summary }: { summary: BuildPriceSummaryModel }) {
  return (
    <section
      aria-label="장착 부품 상인 요구 조건"
      className="modding-trader-requirements"
      role="region"
    >
      <header>
        <strong>장착 부품 상인 요구 레벨</strong>
        <small>각 상인에서 필요한 최고 우호도</small>
      </header>
      <div>
        <RequirementPlan
          group={summary.strategies.trader.parts}
          label="상인만 구매"
        />
        <RequirementPlan
          group={summary.strategies.cheapest.parts}
          label="최저가 혼합"
        />
      </div>
    </section>
  );
}

function RequirementPlan({
  group,
  label,
}: {
  group: BuildPriceGroupSummary;
  label: string;
}) {
  return (
    <div className="modding-requirement-plan">
      <span>{label}</span>
      <div className="modding-requirement-chips">
        {group.itemCount === 0 ? <small>장착 부품 없음</small> : null}
        {group.itemCount > 0 && group.traderRequirements.length === 0 ? (
          <small>{group.sourceCounts.flea ? "상인 구매 없음" : "확인 가능한 상인 오퍼 없음"}</small>
        ) : null}
        {group.traderRequirements.map((requirement) => (
          <strong key={requirement.traderId}>
            {requirement.traderName} LL{requirement.loyaltyLevel}
          </strong>
        ))}
        {group.questUnlocks.map((quest) => (
          <em key={`${quest.traderId}:${quest.questId}`}>
            {quest.questName} 퀘스트
            {quest.minimumPlayerLevel !== undefined ? ` (Lv.${quest.minimumPlayerLevel})` : ""}
          </em>
        ))}
      </div>
    </div>
  );
}

function formatGroupPrice(group: BuildPriceGroupSummary): string {
  if (group.totalRoubles !== null) return formatRoubles(group.totalRoubles);
  return group.knownTotalRoubles > 0
    ? `최소 ${formatRoubles(group.knownTotalRoubles)}`
    : "계산 불가";
}

function missingPriceLabel(group: BuildPriceGroupSummary): string {
  return `가격 정보 없음 ${group.missingItemCount}개`;
}

function formatSingleTraderRequirement(group: BuildPriceGroupSummary): string {
  if (group.traderRequirements.length === 0) return "상인 오퍼 없음";
  return group.traderRequirements
    .map(({ traderName, loyaltyLevel }) => `${traderName} LL${loyaltyLevel}`)
    .join(" · ");
}

function formatFleaRequirement(group: BuildPriceGroupSummary): string {
  return group.fleaMinimumPlayerLevel === undefined
    ? "플리 레벨 정보 없음"
    : `플리 Lv.${group.fleaMinimumPlayerLevel}`;
}

function formatSourceLabel(group: BuildPriceGroupSummary): string {
  if (group.sourceCounts.trader && group.sourceCounts.flea) return "상점·플리 혼합";
  if (group.sourceCounts.trader) return "상점가 적용";
  if (group.sourceCounts.flea) return "플리가 적용";
  return "가격 정보 없음";
}

function formatPartPlanMeta(
  group: BuildPriceGroupSummary,
  strategy: BuildPriceStrategy,
): string {
  if (group.itemCount === 0) return "장착 부품 없음";
  if (strategy === "trader") return `상점 ${group.sourceCounts.trader}개`;
  if (strategy === "flea") {
    return `플리 ${group.sourceCounts.flea}개${
      group.fleaMinimumPlayerLevel === undefined ? "" : ` · Lv.${group.fleaMinimumPlayerLevel}`
    }`;
  }
  return `상점 ${group.sourceCounts.trader}개 · 플리 ${group.sourceCounts.flea}개`;
}
