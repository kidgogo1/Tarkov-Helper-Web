import { Coins, PackageCheck, ShoppingCart } from "lucide-react";
import { useId, useState } from "react";

import { formatRoubles } from "../../domain/item-prices";
import type { ProfileType } from "../../types/data";
import type {
  BuildPriceGroupSummary,
  BuildPriceStrategy,
  BuildPriceSummary as BuildPriceSummaryModel,
  BuildPurchaseLine,
  BuildPurchaseMode,
} from "./build-price-summary";
import { WeaponItemImage } from "./WeaponItemImage";
import "../../styles/weapon-modding-prices.css";

interface BuildPriceSummaryProps {
  activeProfile: ProfileType;
  factoryPriceUpdatedAt?: string;
  purchaseMode: BuildPurchaseMode;
  onPurchaseModeChange: (mode: BuildPurchaseMode) => void;
  summary: BuildPriceSummaryModel;
}

const STRATEGIES: ReadonlyArray<{ key: BuildPriceStrategy; label: string }> = [
  { key: "trader", label: "상인만" },
  { key: "flea", label: "플리만" },
  { key: "cheapest", label: "최저가 혼합" },
];

export function BuildPriceSummary({
  activeProfile,
  factoryPriceUpdatedAt,
  purchaseMode,
  onPurchaseModeChange,
  summary,
}: BuildPriceSummaryProps) {
  const modeName = useId();
  const [listStrategy, setListStrategy] = useState<BuildPriceStrategy>("cheapest");
  const selected = summary.strategies[listStrategy];
  const strategyLabel = STRATEGIES.find(({ key }) => key === listStrategy)?.label;

  return (
    <section aria-label="빌드 가격 요약" className="modding-purchase-summary" role="region">
      <header className="modding-purchase-heading">
        <strong><Coins aria-hidden="true" size={16} />예상 구매 비용</strong>
        <small>{activeProfile.toUpperCase()} · 참고가 · 실시간 아님</small>
      </header>
      <p className="modding-purchase-context modding-purchase-source-note">
        완제품 상점가 확인: {factoryPriceUpdatedAt?.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "미확인"} · 부품가는 포함 데이터 기준
      </p>

      <fieldset className="modding-purchase-modes">
        <legend>구매 기준</legend>
        {([["buy", "상점 기본 총기 구매"], ["owned", "기본 총기 보유"]] as const).map(([mode, label]) => (
          <label className={purchaseMode === mode ? "selected" : ""} key={mode}>
            <input
              checked={purchaseMode === mode}
              name={modeName}
              onChange={() => onPurchaseModeChange(mode)}
              type="radio"
              value={mode}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <p className="modding-purchase-context">
        {purchaseMode === "owned"
          ? "상점 기본 구성을 보유한 경우입니다. 임의의 보관함 부품 보유 여부는 반영하지 않습니다."
          : "세 방식 모두 상점 기본 총기 완제품을 구매하고, 추가 부품 구매처만 비교합니다."}
      </p>
      <div className="modding-purchase-counts">
        <span><PackageCheck aria-hidden="true" size={14} />기본 구성 재사용 {summary.includedPartCount}개</span>
        <strong><ShoppingCart aria-hidden="true" size={14} />추가 구매 {summary.additionalPartCount}개</strong>
      </div>

      <div className="modding-purchase-plans">
        {STRATEGIES.map(({ key, label }) => (
          <PurchasePlan key={key} label={label} plan={summary.strategies[key]} strategy={key} />
        ))}
      </div>

      <details className="modding-purchase-details">
        <summary>추가 구매 목록 · {summary.additionalPartCount}개</summary>
        <label className="modding-purchase-list-control">
          <span>구매 목록 기준</span>
          <select aria-label="구매 목록 기준" onChange={(event) => setListStrategy(event.target.value as BuildPriceStrategy)} value={listStrategy}>
            {STRATEGIES.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
          </select>
        </label>
        {selected.purchaseLines.length ? (
          <ul aria-label="추가 구매 부품 목록" className="modding-purchase-list">
            {selected.purchaseLines.map((line) => <PurchaseLine key={line.itemId} line={line} />)}
          </ul>
        ) : <p className="modding-purchase-context">기본 구성으로 충당됩니다. 추가로 구매할 부품이 없습니다.</p>}
      </details>

      <section aria-label="구매 상인 요구 조건" className="modding-purchase-requirements" role="region">
        <header><strong>필요 구매 조건</strong><small>{strategyLabel} 기준 · {purchaseMode === "buy" ? "총기 및 추가 부품" : "추가 부품"}</small></header>
        <RequirementChips group={selected.total} />
        <p>현재 상인 해금 여부·재고·구매 제한·교환 재료는 별도 확인이 필요합니다.</p>
      </section>

      <p className="modding-purchase-context modding-purchase-remainder">
        남는 기본 부품 {summary.removedFactoryPartCount}개 · 판매금은 차감하지 않습니다.
      </p>
      <details className="modding-purchase-references">
        <summary>본체·플리 참고가 보기</summary>
        <section aria-label="총기 참고가 · 합계 제외" role="region">
          <dl>
            <div><dt>본체 상점 참고가</dt><dd>{formatGroupPrice(summary.weaponReferences.receiverTrader)}</dd></div>
            <div><dt>총기 플리 참고가</dt><dd>{formatGroupPrice(summary.weaponReferences.flea)}</dd></div>
          </dl>
          <p>본체 가격은 완제품 가격이 아닙니다. 플리 총기는 기본 부품 구성이 보장되지 않아 구매 합계에서 제외합니다.</p>
        </section>
      </details>
    </section>
  );
}

function PurchasePlan({ label, plan, strategy }: {
  label: string;
  plan: BuildPriceSummaryModel["strategies"][BuildPriceStrategy];
  strategy: BuildPriceStrategy;
}) {
  const incomplete = plan.total.totalRoubles === null;
  return (
    <section aria-label={label + " 구매 예상 비용"} className={"modding-purchase-plan " + strategy} role="region">
      <h3>부품 · {label}</h3>
      <span>총 예상 비용</span>
      <strong>{plan.total.totalRoubles === null ? "확인된 합계 " + formatRoubles(plan.total.knownTotalRoubles) : formatRoubles(plan.total.totalRoubles)}</strong>
      {incomplete ? <small className="modding-purchase-missing">미확인 {plan.total.missingItemCount}개 · 총액 미완성</small> : null}
      <dl>
        <div><dt>기본 총기</dt><dd>{formatGroupPrice(plan.weapon)}</dd></div>
        <div><dt>추가 부품</dt><dd>{formatGroupPrice(plan.parts)}</dd></div>
      </dl>
      {plan.total.missingItems.length ? (
        <p className="modding-purchase-missing-items">미확인: {[...new Set(plan.total.missingItems.map(({ name }) => name))].join(", ")}</p>
      ) : null}
    </section>
  );
}

function PurchaseLine({ line }: { line: BuildPurchaseLine }) {
  const sourceLabel = line.source === "trader" && line.traderOffer
    ? line.traderOffer.traderName + " LL" + line.traderOffer.loyaltyLevel
    : line.source === "flea"
      ? "플리" + (line.fleaMinimumPlayerLevel === undefined ? "" : " · Lv." + line.fleaMinimumPlayerLevel)
      : "판매처 미확인";
  return (
    <li>
      <span className="modding-purchase-item-image" aria-hidden="true">
        <WeaponItemImage alt="" fallbackSize={20} loading="lazy" src={line.imageUrl} />
      </span>
      <div className="modding-purchase-item-name">
        <strong>{line.name}</strong>
        <span>{sourceLabel}</span>
        {line.traderOffer?.questUnlock ? <small>해금 · {line.traderOffer.questUnlock.questName}</small> : null}
      </div>
      <strong className="modding-purchase-quantity">{line.quantity}개</strong>
      <div className="modding-purchase-line-price">
        {line.priceRoubles === undefined ? <span className="modding-purchase-missing">가격 미확인 · 별도 확인 필요</span> : (
          <><span>단가 {formatRoubles(line.priceRoubles)}</span><strong>소계 {formatRoubles(line.priceRoubles * line.quantity)}</strong></>
        )}
      </div>
    </li>
  );
}

function RequirementChips({ group }: { group: BuildPriceGroupSummary }) {
  return (
    <div className="modding-purchase-condition-chips">
      {group.itemCount === 0 ? <span>추가 구매 조건 없음</span> : null}
      {group.traderRequirements.map((requirement) => <strong key={requirement.traderId}>{requirement.traderName} LL{requirement.loyaltyLevel}</strong>)}
      {group.fleaMinimumPlayerLevel !== undefined ? <strong>플리 Lv.{group.fleaMinimumPlayerLevel}</strong> : null}
      {group.questUnlocks.map((quest) => (
        <span key={quest.traderId + ":" + quest.questId}>
          {quest.questName} 퀘스트{quest.minimumPlayerLevel === undefined ? "" : " · Lv." + quest.minimumPlayerLevel}
        </span>
      ))}
      {group.missingItemCount > 0 ? <span>미확인 품목의 구매 조건은 별도 확인</span> : null}
    </div>
  );
}

function formatGroupPrice(group: BuildPriceGroupSummary): string {
  if (group.totalRoubles !== null) return formatRoubles(group.totalRoubles);
  return group.knownTotalRoubles > 0 ? formatRoubles(group.knownTotalRoubles) + " + 미확인" : "가격 미확인";
}
