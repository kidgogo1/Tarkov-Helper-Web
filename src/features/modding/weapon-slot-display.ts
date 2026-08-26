import type { WeaponSlotRule } from "../../types/weapon-modding";

export function isDisplayableWeaponSlot(slot: WeaponSlotRule): boolean {
  const key = `${slot.id} ${slot.name}`.toLocaleLowerCase();
  return !/(cartridge|patron|chamber|약실)/.test(key);
}

export function displayWeaponSlotName(slot: WeaponSlotRule): string {
  const source = `${slot.id} ${slot.name}`.toLocaleLowerCase();
  const labels: ReadonlyArray<readonly [RegExp, string]> = [
    [/muzzle/, "총구"],
    [/barrel/, "총열"],
    [/handguard/, "핸드가드"],
    [/gas.?block/, "가스 블록"],
    [/scope|sight|optic/, "조준경"],
    [/receiver|reciever/, "총몸/리시버"],
    [/magazine/, "탄창"],
    [/pistol.?grip/, "권총 손잡이"],
    [/charge|charging/, "장전 손잡이"],
    [/stock/, "개머리판"],
    [/tactical/, "전술 장비"],
  ];
  return labels.find(([pattern]) => pattern.test(source))?.[1] ?? slot.name;
}
