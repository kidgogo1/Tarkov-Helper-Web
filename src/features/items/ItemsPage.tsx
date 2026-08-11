import { Boxes, CheckCircle2, PackageSearch, TriangleAlert } from "lucide-react";
import { useMemo } from "react";

import { useAppStore } from "../../app/store";
import {
  aggregateItemRequirements,
  createItemReferenceRequirement,
  getAggregatedItemStatistics,
} from "../../domain/items";
import type { TarkovData } from "../../types/data";
import "../../styles/items.css";
import { ItemTrackerView } from "./ItemTrackerView";

interface ItemsPageProps {
  data: TarkovData;
  focusItemId?: string;
  focusRequested?: boolean;
  onItemFocusConsumed?: () => void;
  onItemSelect?: (itemId: string, preserveFocus?: boolean) => void;
  onOpenQuest?: (questId: string) => void;
  onOpenHideout?: (stationId: string, level?: number) => void;
}

export function ItemsPage({
  data,
  focusItemId,
  focusRequested,
  onItemFocusConsumed,
  onItemSelect,
  onOpenQuest,
  onOpenHideout,
}: ItemsPageProps) {
  const { profile, setInventory } = useAppStore();
  const items = useMemo(
    () =>
      aggregateItemRequirements(
        data.quests,
        data.hideoutStations,
        data.items,
        profile,
      ),
    [data.hideoutStations, data.items, data.quests, profile],
  );
  const statistics = useMemo(() => getAggregatedItemStatistics(items), [items]);
  const viewItems = useMemo(() => {
    if (!focusItemId || items.some((item) => item.itemId === focusItemId)) return items;
    const reference = data.items.find(
      (item) => item.id === focusItemId || item.bsgId === focusItemId,
    );
    return reference
      ? [...items, createItemReferenceRequirement(reference, profile)]
      : items;
  }, [data.items, focusItemId, items, profile]);

  return (
    <section className="items-page" aria-labelledby="items-title">
      <header className="items-page-header">
        <div>
          <p className="section-title">아이템 요구 사항</p>
          <h1 id="items-title">아이템</h1>
          <p>미완료 퀘스트와 남은 은신처 업그레이드 수량을 관리하고, 완료한 요구 사항은 이력으로 분리해 확인합니다.</p>
        </div>
      </header>

      <section className="item-statistics" aria-label="전체 아이템 요구 통계">
        <Stat icon={<Boxes size={17} />} label="아이템" value={`${statistics.totalUniqueItems}종`} />
        <Stat icon={<PackageSearch size={17} />} label="총 필요" value={`${statistics.totalRequired}개`} />
        <Stat icon={<TriangleAlert size={17} />} label="부족" value={`${statistics.totalShortage}개`} tone="warning" />
        <Stat icon={<CheckCircle2 size={17} />} label="완료" value={`${statistics.fulfilledCount}종`} tone="success" />
      </section>

      <ItemTrackerView
        focusItemId={focusItemId}
        itemData={data.items}
        items={viewItems}
        listLabel="아이템 목록"
        focusRequested={focusRequested}
        onItemFocusConsumed={onItemFocusConsumed}
        onItemSelect={onItemSelect}
        onInventoryChange={setInventory}
        onOpenHideout={onOpenHideout}
        onOpenQuest={onOpenQuest}
      />
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  tone = "",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className={`panel${tone ? ` ${tone}` : ""}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
