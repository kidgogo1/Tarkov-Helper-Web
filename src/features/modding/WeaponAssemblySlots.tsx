import { Plus, X } from "lucide-react";
import { useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BuildNode, WeaponCatalogItem, WeaponSlotRule } from "../../types/weapon-modding";
import type { SlotSelection } from "./WeaponSlotTree";
import type { WeaponHotspotSlot } from "./weapon-hotspot-slots";
import { WeaponItemImage } from "./WeaponItemImage";
import { displayWeaponSlotName } from "./weapon-slot-display";
import { describeWeaponVisualSlot, groupWeaponVisualSlots, type VisualSlotGroup } from "./weapon-visual-groups";
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

interface OpenGroup {
  rootKey: string;
  selectionKey: string;
  groupId: string | null;
  slotKeys: string[];
}

function slotKey(entry: WeaponHotspotSlot): string {
  return `${entry.parentInstanceId}:${entry.slot.id}`;
}

function matchesSelection(entry: WeaponHotspotSlot, selection: SlotSelection | null): boolean {
  return entry.parentInstanceId === selection?.parentInstanceId && entry.slot.id === selection.slotId;
}

function childName(entry: WeaponHotspotSlot): string {
  return entry.childItem?.shortName || entry.childItem?.nameKo || entry.childItem?.name || "비어 있음";
}

function SlotThumbnail({ entry }: { entry: WeaponHotspotSlot | undefined }) {
  return <span className="modding-assembly-thumbnail" aria-hidden="true">
    {entry?.childItem ? <WeaponItemImage alt="" fallbackSize={20}
      src={entry.childItem.iconUrl ?? entry.childItem.imageUrl} /> : <Plus size={18} />}
  </span>;
}

export function WeaponAssemblySlots({ itemById, root, slots, selectedSlot, onSelect, children, angled = false }: WeaponAssemblySlotsProps) {
  const groups = groupWeaponVisualSlots(root, itemById, slots);
  const [openGroup, setOpenGroup] = useState<OpenGroup | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const trayId = useId();
  const rootKey = `${root.itemId}:${root.instanceId}`;
  const selectionKey = selectedSlot ? `${selectedSlot.parentInstanceId}:${selectedSlot.slotId}` : "";
  const selectedGroup = groups.find((group) => group.slots.some((entry) => matchesSelection(entry, selectedSlot)));
  const manualContext = openGroup?.rootKey === rootKey && openGroup.selectionKey === selectionKey;
  const activeGroup = manualContext
    ? groups.find((group) => group.id === openGroup.groupId && group.slots.some((entry) => openGroup.slotKeys.includes(slotKey(entry))))
    : selectedGroup;
  const trayGroup = activeGroup && activeGroup.slots.length > 1 ? activeGroup : undefined;
  const split = Math.ceil(groups.length / 2);
  const rows = [groups.slice(0, split), groups.slice(split)];
  const open = (group: VisualSlotGroup | null) => setOpenGroup({
    rootKey, selectionKey, groupId: group?.id ?? null, slotKeys: group?.slots.map(slotKey) ?? [],
  });
  const select = (entry: WeaponHotspotSlot) => onSelect({ parentInstanceId: entry.parentInstanceId, slotId: entry.slot.id });
  const close = () => {
    open(null);
    if (trayGroup) buttons.current.get(trayGroup.id)?.focus();
  };

  return <div className="modding-assembly">
    <div className="modding-assembly-scene">
      <div className="modding-assembly-controls" role="group" aria-label="총기 부위 선택">
        {rows.map((row, rowIndex) => <div className={`modding-assembly-edge ${rowIndex === 0 ? "top" : "bottom"}`}
          key={rowIndex} style={{ "--assembly-columns": Math.max(1, row.length) } as CSSProperties}>
          {row.map((group) => {
            const single = group.slots.length === 1;
            const selected = group.slots.some((entry) => matchesSelection(entry, selectedSlot));
            const representative = group.slots.find((entry) => matchesSelection(entry, selectedSlot) && entry.childItem)
              ?? group.slots.find((entry) => entry.childItem);
            const label = single ? displayWeaponSlotName(group.slots[0].slot) : group.label;
            const expanded = trayGroup?.id === group.id;
            return <button type="button" key={group.id}
              ref={(button) => { if (button) buttons.current.set(group.id, button); else buttons.current.delete(group.id); }}
              className={`modding-assembly-group${selected ? " selected" : ""}${expanded ? " expanded" : ""}`}
              aria-pressed={single ? selected : undefined} aria-expanded={single ? undefined : expanded}
              aria-controls={!single && expanded ? trayId : undefined}
              onClick={() => { if (single) { open(null); select(group.slots[0]); } else open(expanded ? null : group); }}>
              <SlotThumbnail entry={representative} />
              <span className="modding-assembly-group-label"><strong>{label}</strong>
                <small>{single ? childName(group.slots[0]) : `${group.slots.filter((entry) => entry.childItem).length}/${group.slots.length} 장착`}</small>
              </span>
              {!single && <span className="modding-assembly-count">{group.slots.length}</span>}
            </button>;
          })}
        </div>)}
      </div>
      <div className="modding-assembly-center">{children}</div>
      {!angled && groups.length > 0 && <svg className="modding-assembly-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {rows.flatMap((row, rowIndex) => row.map((group, index) => {
          const active = group.id === activeGroup?.id || group.id === selectedGroup?.id;
          const targetY = 28 + group.anchor.y * 0.44;
          return <g className={active ? "active" : ""} key={group.id}>
            <line x1={(index + 0.5) * 100 / row.length} y1={rowIndex === 0 ? 17 : 83} x2={group.anchor.x} y2={targetY} />
            <circle cx={group.anchor.x} cy={targetY} r={active ? 0.65 : 0.4} />
          </g>;
        }))}
      </svg>}
    </div>
    <p className="modding-assembly-note">{angled
      ? "이미지 각도 조절 중에는 개략 연결선을 숨깁니다."
      : "연결선은 부위별 개략 위치입니다."} <span>부위 카드를 눌러 슬롯을 선택하세요.</span></p>
    {groups.length === 0 && <p className="modding-assembly-note">선택할 수 있는 장착 부위가 없습니다.</p>}
    {trayGroup && <AssemblySlotTray group={trayGroup} id={trayId} selectedSlot={selectedSlot} onSelect={select} onClose={close} />}
  </div>;
}

function AssemblySlotTray({ group, id, selectedSlot, onSelect, onClose }: {
  group: VisualSlotGroup;
  id: string;
  selectedSlot: SlotSelection | null;
  onSelect: (entry: WeaponHotspotSlot) => void;
  onClose: () => void;
}) {
  const labels = group.slots.map(describeWeaponVisualSlot);
  return <section className="modding-assembly-tray" id={id} aria-label="선택 부위의 슬롯"
    onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
    <header><strong>{group.label} <small>전체 {group.slots.length}개 슬롯</small></strong>
      <button type="button" aria-label="슬롯 목록 접기" onClick={onClose}><X size={16} /></button></header>
    <div className="modding-assembly-slot-list">
      {group.slots.map((entry, index) => {
        const repeated = labels.filter((label) => label === labels[index]).length > 1;
        const ordinal = labels.slice(0, index + 1).filter((label) => label === labels[index]).length;
        const suffix = repeated ? ` ${ordinal <= 20 ? String.fromCodePoint(0x2460 + ordinal - 1) : `(${ordinal})`}` : "";
        return <button type="button" key={slotKey(entry)} aria-pressed={matchesSelection(entry, selectedSlot)}
          className="modding-assembly-slot" onClick={() => onSelect(entry)}>
          <SlotThumbnail entry={entry} />
          <span><strong>{labels[index]}{suffix}</strong><small>{childName(entry)}{entry.slot.required ? " · 필수" : ""}</small></span>
        </button>;
      })}
    </div>
  </section>;
}
