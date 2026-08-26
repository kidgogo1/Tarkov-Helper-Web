import { ChevronRight, CircleAlert, Plus, Trash2 } from "lucide-react";

import type {
  BuildNode,
  WeaponCatalogItem,
  WeaponSlotRule,
} from "../../types/weapon-modding";
import {
  displayWeaponSlotName,
  isDisplayableWeaponSlot,
} from "./weapon-slot-display";
import { WeaponItemImage } from "./WeaponItemImage";

interface SlotSelection {
  parentInstanceId: string;
  slotId: string;
}

interface WeaponSlotTreeProps {
  itemById: ReadonlyMap<string, WeaponCatalogItem>;
  node: BuildNode;
  selectedSlot: SlotSelection | null;
  onRemove: (parentInstanceId: string, slot: WeaponSlotRule) => void;
  onSelect: (parentInstanceId: string, slot: WeaponSlotRule) => void;
}

export function WeaponSlotTree({
  itemById,
  node,
  selectedSlot,
  onRemove,
  onSelect,
}: WeaponSlotTreeProps) {
  const item = itemById.get(node.itemId);
  if (!item?.slots?.length) return null;

  const slots = item.slots.filter(isDisplayableWeaponSlot);
  if (!slots.length) return null;

  return (
    <ul className="modding-slot-tree">
      {slots.map((slot) => {
        const child = node.children.find((candidate) => candidate.slotId === slot.id);
        const childItem = child ? itemById.get(child.itemId) : undefined;
        const selected = selectedSlot?.parentInstanceId === node.instanceId &&
          selectedSlot.slotId === slot.id;

        return (
          <li key={`${node.instanceId}:${slot.id}`}>
            <div className={`modding-slot-row${selected ? " selected" : ""}`}>
              <button
                aria-pressed={selected}
                className="modding-slot-select"
                onClick={() => onSelect(node.instanceId, slot)}
                type="button"
              >
                <span className="modding-slot-icon" aria-hidden="true">
                  {childItem ? (
                    <WeaponItemImage
                      alt=""
                      fallbackSize={18}
                      src={childItem.iconUrl ?? childItem.imageUrl}
                    />
                  ) : child ? <ChevronRight size={18} /> : <Plus size={18} />}
                </span>
                <span>
                  <small>{displayWeaponSlotName(slot)}{slot.required ? " · 필수" : ""}</small>
                  <strong>{childItem?.nameKo ?? childItem?.name ?? "비어 있음"}</strong>
                </span>
                {slot.required && !child ? (
                  <span className="modding-slot-warning">
                    <CircleAlert aria-hidden="true" size={15} /> 발사 불가
                  </span>
                ) : null}
              </button>
              {child ? (
                <button
                  aria-label={`${displayWeaponSlotName(slot)} 부품 제거`}
                  className="modding-slot-remove"
                  onClick={() => onRemove(node.instanceId, slot)}
                  type="button"
                >
                  <Trash2 aria-hidden="true" size={15} />
                </button>
              ) : null}
            </div>
            {child ? (
              <WeaponSlotTree
                itemById={itemById}
                node={child}
                onRemove={onRemove}
                onSelect={onSelect}
                selectedSlot={selectedSlot}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export type { SlotSelection };
