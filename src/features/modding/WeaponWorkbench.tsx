import {
  BadgeRussianRuble,
  CircleAlert,
  RotateCcw,
} from "lucide-react";

import {
  calculateBuildStats,
  centerOfImpactToMoa,
  getCompatibleCandidates,
  removeBuildSlot,
  replaceBuildSlot,
  validateWeaponBuild,
} from "../../domain/weapon-build";
import { formatRoubles } from "../../domain/item-prices";
import type { ProfileType } from "../../types/data";
import type {
  TraderOffer,
  WeaponBuild,
  WeaponCatalog,
  WeaponCatalogItem,
  WeaponSlotRule,
} from "../../types/weapon-modding";
import { WeaponSlotTree, type SlotSelection } from "./WeaponSlotTree";
import { WeaponHotspots } from "./WeaponHotspots";
import { WeaponItemImage } from "./WeaponItemImage";

interface WeaponWorkbenchProps {
  activeProfile: ProfileType;
  build: WeaponBuild;
  catalog: WeaponCatalog;
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  selectedSlot: SlotSelection | null;
  onBuildChange: (build: WeaponBuild) => void;
  onReset: () => void;
  onSlotSelect: (selection: SlotSelection | null) => void;
}

export function WeaponWorkbench({
  activeProfile,
  build,
  catalog,
  itemById,
  selectedSlot,
  onBuildChange,
  onReset,
  onSlotSelect,
}: WeaponWorkbenchProps) {
  const weapon = itemById.get(build.weaponId);
  if (!weapon || weapon.kind !== "weapon") return null;

  const stats = calculateBuildStats(catalog, build);
  const validation = validateWeaponBuild(catalog, build);
  const candidates = selectedSlot
    ? getCompatibleCandidates(
        catalog,
        build,
        selectedSlot.parentInstanceId,
        selectedSlot.slotId,
      )
    : [];

  const replacePart = (itemId: string) => {
    if (!selectedSlot) return;
    const result = replaceBuildSlot(
      catalog,
      build,
      selectedSlot.parentInstanceId,
      selectedSlot.slotId,
      itemId,
    );
    if (result.ok) onBuildChange(result.build);
  };

  const removePart = (parentInstanceId: string, slot: WeaponSlotRule) => {
    const result = removeBuildSlot(build, parentInstanceId, slot.id);
    if (!result.ok) return;
    onBuildChange(result.build);
    if (selectedSlot && result.removedNodes.some(
      (node) => node.instanceId === selectedSlot.parentInstanceId,
    )) {
      onSlotSelect(null);
    }
  };

  return (
    <div className="modding-workbench">
      <aside className="modding-part-picker" aria-label="호환 부품 선택">
        <header>
          <span>부품 선택</span>
          <small>{selectedSlot ? `${candidates.length}개 호환` : "먼저 부위를 선택하세요"}</small>
        </header>
        {selectedSlot ? (
          candidates.length ? (
            <div className="modding-part-grid">
              {candidates.map((candidate) => (
                <button key={candidate.id} onClick={() => replacePart(candidate.id)} type="button">
                  <span className="modding-part-image" aria-hidden="true">
                    <WeaponItemImage
                      alt=""
                      fallbackSize={25}
                      loading="lazy"
                      src={candidate.iconUrl ?? candidate.imageUrl}
                    />
                  </span>
                  <strong>{candidate.nameKo ?? candidate.name}</strong>
                  <small>{candidate.shortName ?? candidate.nameEn ?? candidate.name}</small>
                  <PartPerformance item={candidate} />
                  <PartPrice activeProfile={activeProfile} item={candidate} />
                </button>
              ))}
            </div>
          ) : <p className="modding-picker-empty">현재 구성과 호환되는 부품이 없습니다.</p>
        ) : <p className="modding-picker-empty">총기 이미지 주변이나 장착 트리에서 부위를 선택하세요.</p>}
      </aside>

      <section className="modding-weapon-stage">
        <header>
          <div>
            <span className="modding-mode-badge">{activeProfile.toUpperCase()}</span>
            <h2>{weapon.nameKo ?? weapon.name}</h2>
            {weapon.nameKo && weapon.nameKo !== weapon.name ? <p>{weapon.name}</p> : null}
          </div>
          <div className="modding-stage-actions">
            <span className="modding-image-note">상점 기본 외형 · 참고 이미지</span>
            <button onClick={onReset} type="button">
              <RotateCcw aria-hidden="true" size={14} />
              기본 구성으로 초기화
            </button>
          </div>
        </header>

        <div className="modding-weapon-image">
          <WeaponItemImage
            alt={`${weapon.nameKo ?? weapon.name} 상점 기본 외형`}
            fallbackSize={64}
            src={weapon.factoryImageUrl ?? weapon.imageUrl}
          />
          <WeaponHotspots
            itemById={itemById}
            onSelect={onSlotSelect}
            root={build.root}
            selectedSlot={selectedSlot}
            slots={weapon.slots}
          />
        </div>

        <section className="modding-installed-parts" aria-label="장착 부위">
          <WeaponSlotTree
            itemById={itemById}
            node={build.root}
            onRemove={removePart}
            onSelect={(parentInstanceId, slot) => onSlotSelect({
              parentInstanceId,
              slotId: slot.id,
            })}
            selectedSlot={selectedSlot}
          />
        </section>
      </section>

      <aside className="modding-stats" aria-label="무기 능력치" role="region">
        <header>
          <span>현재 빌드</span>
          <strong className={validation.isValid ? "valid" : "invalid"}>
            {validation.isValid ? "사용 가능" : "확인 필요"}
          </strong>
        </header>
        <dl>
          <Stat label="수직 반동" value={formatNumber(stats.verticalRecoil)} />
          <Stat label="수평 반동" value={formatNumber(stats.horizontalRecoil)} />
          <Stat label="인체공학" value={formatNumber(stats.ergonomics)} />
          <Stat label="무게" value={`${formatNumber(stats.weight, 2)} kg`} />
          {stats.accuracyMoa != null ? (
            <Stat label="정확도" value={`${formatNumber(stats.accuracyMoa, 2)} MOA`} />
          ) : null}
          {stats.muzzleVelocityModifier != null ? (
            <Stat
              label="총구 속도 보정"
              value={`${stats.muzzleVelocityModifier > 0 ? "+" : ""}${formatNumber(stats.muzzleVelocityModifier, 2)}%`}
            />
          ) : null}
        </dl>
        {!validation.isValid ? (
          <div className="modding-issues">
            {validation.issues.slice(0, 6).map((issue, index) => (
              <p key={`${issue.code}:${index}`}>
                <CircleAlert aria-hidden="true" size={14} />{issue.message}
              </p>
            ))}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

function PartPrice({ activeProfile, item }: {
  activeProfile: ProfileType;
  item: WeaponCatalogItem;
}) {
  const flea = item.fleaByProfile?.[activeProfile] ?? item.flea;
  const trader = bestTraderOffer(
    item.traderOffersByProfile?.[activeProfile] ?? item.traderOffers,
  );
  if (!flea && !trader) return <span className="modding-part-price">가격 없음</span>;
  return (
    <span className="modding-part-commerce">
      {flea ? (
        <span className="modding-part-price">
          <BadgeRussianRuble aria-hidden="true" size={13} />
          플리{flea.minimumPlayerLevel ? ` Lv.${flea.minimumPlayerLevel}` : ""}
          {` · 참고가 ${formatRoubles(flea.price)}`}
        </span>
      ) : null}
      {trader ? (
        <span className="modding-part-trader">
          {trader.traderName} LL{trader.loyaltyLevel} {formatTraderOfferPrice(trader)}
          {trader.questUnlock ? (
            <span className="modding-quest-unlock">
              {` · ${trader.questUnlock.questName} 퀘스트`}
              {trader.questUnlock.minimumPlayerLevel !== undefined
                ? ` (Lv.${trader.questUnlock.minimumPlayerLevel})`
                : ""}
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function PartPerformance({ item }: { item: WeaponCatalogItem }) {
  if (item.kind !== "part" || !item.stats) return null;
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

function bestTraderOffer(offers: TraderOffer[] | undefined): TraderOffer | undefined {
  return offers?.reduce((best, candidate) => {
    const bestPrice = normalizedTraderPrice(best);
    const candidatePrice = normalizedTraderPrice(candidate);
    if (candidatePrice !== bestPrice) return candidatePrice < bestPrice ? candidate : best;
    if (candidate.loyaltyLevel !== best.loyaltyLevel) {
      return candidate.loyaltyLevel < best.loyaltyLevel ? candidate : best;
    }
    return candidate.traderId.localeCompare(best.traderId) < 0 ? candidate : best;
  });
}

function normalizedTraderPrice(offer: TraderOffer): number {
  return offer.priceRoubles ?? (offer.currency === "RUB" ? offer.price : Number.POSITIVE_INFINITY);
}

function formatTraderOfferPrice(offer: TraderOffer): string {
  const originalPrice = formatCurrency(offer.price, offer.currency);
  if (offer.currency === "RUB" || offer.priceRoubles === undefined) return originalPrice;
  return `${originalPrice} (≈ ${formatRoubles(offer.priceRoubles)})`;
}

function formatCurrency(value: number, currency: string): string {
  if (currency === "RUB") return formatRoubles(value);
  if (currency === "USD") return `$${value.toLocaleString("en-US")}`;
  if (currency === "EUR") return `€${value.toLocaleString("en-US")}`;
  return `${value.toLocaleString("en-US")} ${currency}`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function formatNumber(value: number, digits = 0): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function signed(value: number, digits = 0): string {
  return `${value > 0 ? "+" : ""}${formatNumber(value, digits)}`;
}
