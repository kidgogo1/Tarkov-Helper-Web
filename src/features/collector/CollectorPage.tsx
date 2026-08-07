import { Award, CheckCircle2, ClipboardList, PackageSearch } from "lucide-react";
import { useMemo, useState } from "react";

import { useAppStore } from "../../app/store";
import {
  aggregateCollectorItems,
  getAggregatedItemStatistics,
  getCollectorQuestChain,
} from "../../domain/items";
import { createQuestStatusResolver } from "../../domain/quests";
import { ItemTrackerView } from "../items/ItemTrackerView";
import type { TarkovData } from "../../types/data";
import "../../styles/items.css";

interface CollectorPageProps {
  data: TarkovData;
}

export function CollectorPage({ data }: CollectorPageProps) {
  const { profile, setInventory } = useAppStore();
  const [includePrerequisites, setIncludePrerequisites] = useState(false);
  const statusResolver = useMemo(
    () => createQuestStatusResolver(data.quests, profile),
    [data.quests, profile],
  );
  const questChain = useMemo(
    () =>
      getCollectorQuestChain(
        data.quests,
        profile,
        includePrerequisites,
        "collector",
        statusResolver,
      ),
    [data.quests, includePrerequisites, profile, statusResolver],
  );
  const items = useMemo(
    () =>
      aggregateCollectorItems(
        data.quests,
        data.items,
        profile,
        includePrerequisites,
        "collector",
        statusResolver,
      ),
    [data.items, data.quests, includePrerequisites, profile, statusResolver],
  );
  const statistics = useMemo(() => getAggregatedItemStatistics(items), [items]);

  return (
    <section className="collector-page" aria-labelledby="collector-title">
      <header className="collector-page-header">
        <div>
          <p className="section-title">KAPPA COLLECTION</p>
          <h1 id="collector-title">수집가 · 카파</h1>
          <p>Collector 완료와 카파 진행에 필요한 퀘스트 아이템을 추적합니다.</p>
        </div>
        <label className="collector-prerequisite-toggle">
          <input
            checked={includePrerequisites}
            onChange={(event) => setIncludePrerequisites(event.target.checked)}
            type="checkbox"
          />
          <span>선행 퀘스트 포함</span>
        </label>
      </header>

      <section className="item-statistics collector-statistics" aria-label="수집가 아이템 통계">
        <CollectorStat icon={<Award size={17} />} label="모드" value={includePrerequisites ? "선행 포함" : "수집가 전용"} />
        <CollectorStat icon={<ClipboardList size={17} />} label="대상 퀘스트" value={`${questChain.length}개`} />
        <CollectorStat icon={<PackageSearch size={17} />} label="필요 아이템" value={`${statistics.totalRequired}개`} />
        <CollectorStat icon={<CheckCircle2 size={17} />} label="완료" value={`${statistics.fulfilledCount}/${statistics.totalUniqueItems}종`} tone="success" />
      </section>

      <ItemTrackerView
        itemData={data.items}
        items={items}
        listLabel="수집가 아이템 목록"
        onInventoryChange={setInventory}
        showHideoutSort={false}
        showSourceFilter={false}
      />
    </section>
  );
}

function CollectorStat({
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
