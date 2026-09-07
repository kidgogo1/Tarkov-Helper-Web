import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BuildNode, WeaponCatalogItem, WeaponSlotRule } from "../../types/weapon-modding";
import type { SlotSelection } from "./WeaponSlotTree";
import { WeaponItemImage } from "./WeaponItemImage";
import {
  collectWeaponAssemblyCards,
  filterWeaponAssemblyCards,
  paginateWeaponAssemblyCards,
  weaponAssemblyColumns,
  type AssemblySlotCard,
  type AssemblySlotFilter,
} from "./weapon-assembly-layout";
import "../../styles/weapon-assembly-slots.css";

interface WeaponAssemblySlotsProps {
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  root: BuildNode;
  slots: WeaponSlotRule[];
  selectedSlot: SlotSelection | null;
  onSelect: (selection: SlotSelection) => void;
  children: ReactNode;
  angled?: boolean;
}

const FILTERS: ReadonlyArray<{ id: AssemblySlotFilter; label: string }> = [
  { id: "all", label: "전체" }, { id: "required", label: "필수" },
  { id: "installed", label: "장착" }, { id: "empty", label: "빈 슬롯" },
];

function SlotThumbnail({ card }: { card: AssemblySlotCard }) {
  return <span className="modding-assembly-thumbnail" aria-hidden="true">
    {card.installed ? <WeaponItemImage alt="" fallbackSize={20}
      src={card.entry.childItem?.iconUrl ?? card.entry.childItem?.imageUrl} /> : <Plus size={22} />}
  </span>;
}

export function WeaponAssemblySlots({ itemById, root, slots, selectedSlot, onSelect, children, angled = false }: WeaponAssemblySlotsProps) {
  const container = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(7);
  const [filter, setFilter] = useState<AssemblySlotFilter>("all");
  const [navigation, setNavigation] = useState<{ context: string; page: number } | null>(null);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const resize = () => setColumns(weaponAssemblyColumns(element.getBoundingClientRect().width));
    resize();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const cards = collectWeaponAssemblyCards(root, itemById, slots);
  const filtered = filterWeaponAssemblyCards(cards, filter);
  const selectionKey = selectedSlot ? `${selectedSlot.parentInstanceId}:${selectedSlot.slotId}` : "";
  const selectedIndex = filtered.findIndex((card) => card.key === selectionKey);
  const selectedCard = cards.find((card) => card.key === selectionKey);
  const pageSize = columns * 2;
  const selectedPage = selectedIndex >= 0 ? Math.floor(selectedIndex / pageSize) : 0;
  // A new external selection or weapon gets its own page context. Manual paging
  // remains possible without clearing the selection or invoking onSelect.
  const context = `${root.itemId}:${root.instanceId}|${filter}|${selectionKey}|${columns}`;
  const page = paginateWeaponAssemblyCards(filtered, navigation?.context === context ? navigation.page : selectedPage, pageSize);
  const edgeColumns = Math.max(1, Math.ceil(page.cards.length / 2));
  const rows = [page.cards.slice(0, edgeColumns), page.cards.slice(edgeColumns)];
  const moveToPage = (nextPage: number) => setNavigation({ context, page: nextPage });
  const selectedHidden = Boolean(selectedCard && selectedIndex < 0);
  const selectedElsewhere = selectedIndex >= 0 && selectedPage !== page.page;

  return <div className="modding-assembly" ref={container}>
    <div className="modding-assembly-toolbar">
      <div className="modding-assembly-filters" role="group" aria-label="슬롯 표시 필터">
        {FILTERS.map(({ id, label }) => <button key={id} type="button" aria-pressed={filter === id}
          onClick={() => setFilter(id)}>{label} <span>{filterWeaponAssemblyCards(cards, id).length}</span></button>)}
      </div>
      <span className="modding-assembly-total">전체 {cards.length}개 슬롯</span>
    </div>
    <div className={`modding-assembly-selection-note${selectedHidden || selectedElsewhere ? " attention" : ""}`}>
      {selectedHidden ? <>
        <span title="선택한 슬롯이 현재 필터에서 숨겨져 있습니다.">선택한 슬롯이 현재 필터에서 숨겨져 있습니다.</span>
        <button type="button" onClick={() => { setFilter("all"); setNavigation(null); }}>전체 슬롯 보기</button>
      </> : selectedElsewhere ? <>
        <span title={`선택: ${selectedCard?.label} · ${selectedCard?.parentLabel}`}>선택: {selectedCard?.label} · {selectedCard?.parentLabel}</span>
        <button type="button" onClick={() => moveToPage(selectedPage)}>선택 슬롯 보기</button>
      </> : <span>부품 카드를 선택하면 호환 부품 목록이 열립니다.</span>}
    </div>
    <div className="modding-assembly-scene" style={{ "--assembly-columns": edgeColumns } as CSSProperties}>
      <div className="modding-assembly-controls" role="group" aria-label="총기 부위 선택">
        {rows.map((row, rowIndex) => <div className={`modding-assembly-edge ${rowIndex === 0 ? "top" : "bottom"}`} key={rowIndex}>
          {row.map((card) => {
            const selected = card.key === selectionKey;
            const state = card.installed ? "장착됨" : "빈 슬롯";
            const description = `${card.label} · ${card.parentLabel} · ${card.partLabel} · ${state}${card.entry.slot.required ? " · 필수" : ""}`;
            return <button type="button" key={card.key} data-slot-key={card.key}
              className={`modding-assembly-slot-card${selected ? " selected" : ""}${card.installed ? " installed" : " empty"}`}
              aria-label={description} title={`${description}${card.entry.childItem?.name ? `\n${card.entry.childItem.nameKo || card.entry.childItem.name}` : ""}`}
              aria-pressed={selected}
              onClick={() => onSelect({ parentInstanceId: card.entry.parentInstanceId, slotId: card.entry.slot.id })}>
              <span className="modding-assembly-card-status">{card.entry.slot.required && <b>필수</b>}<span>{state}</span></span>
              <SlotThumbnail card={card} />
              <strong className="modding-assembly-part-name">{card.partLabel}</strong>
              <span className="modding-assembly-slot-name">{card.label}</span>
              <small className="modding-assembly-parent-name">{card.parentLabel}</small>
            </button>;
          })}
        </div>)}
      </div>
      <div className="modding-assembly-center">{children}</div>
      {!angled && page.cards.length > 0 && <svg className="modding-assembly-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {rows.flatMap((row, rowIndex) => row.map((card, index) => {
          const active = card.key === selectionKey;
          const targetY = 28 + card.anchor.y * 0.44;
          return <g className={active ? "active" : ""} key={card.key}>
            <line x1={(index + 0.5) * 100 / edgeColumns} y1={rowIndex === 0 ? 20 : 80} x2={card.anchor.x} y2={targetY} />
            <circle cx={card.anchor.x} cy={targetY} r={active ? 0.65 : 0.35} />
          </g>;
        }))}
      </svg>}
    </div>
    {filtered.length === 0 && <p className="modding-assembly-note">{cards.length === 0
      ? "선택할 수 있는 장착 부위가 없습니다." : "현재 필터에 해당하는 슬롯이 없습니다."}</p>}
    <nav className="modding-assembly-pagination" aria-label="슬롯 페이지">
      <button type="button" aria-label="이전 슬롯 페이지" disabled={page.page === 0} onClick={() => moveToPage(page.page - 1)}><ChevronLeft size={16} /></button>
      <span aria-live="polite"><strong>{page.page + 1} / {page.pageCount} 페이지</strong>
        <small>{filtered.length ? `${page.page * pageSize + 1}–${page.page * pageSize + page.cards.length} / ${filtered.length}개 표시` : "0개 표시"}</small></span>
      <button type="button" aria-label="다음 슬롯 페이지" disabled={page.page === page.pageCount - 1} onClick={() => moveToPage(page.page + 1)}><ChevronRight size={16} /></button>
    </nav>
    <p className="modding-assembly-note">{angled
      ? "확대·각도 보기에서는 개략 연결선을 숨깁니다."
      : "연결선은 부위별 개략 위치입니다."} <span>부품 카드를 눌러 해당 슬롯의 호환 부품을 선택하세요.</span></p>
  </div>;
}
