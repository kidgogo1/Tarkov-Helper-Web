import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WeaponAssemblySlots } from "../../src/features/modding/WeaponAssemblySlots";
import type { BuildNode, WeaponCatalogItem, WeaponSlotRule } from "../../src/types/weapon-modding";

const scopeSlot: WeaponSlotRule = { id: "scope", name: "조준경" };
const root: BuildNode = { instanceId: "weapon", itemId: "weapon", children: [] };

function nestedFixture(count = 2) {
  const rail: WeaponCatalogItem = {
    id: "rail", kind: "part", name: "Installed rail", shortName: "RIS II", categories: [],
    iconUrl: "/rail.png",
    slots: Array.from({ length: count }, (_, index) => ({ id: `slot-${index}`, name: "전술 장비" })),
  };
  const itemById = new Map([[rail.id, rail]]);
  const slots = [{ id: "rail-mount", name: "마운트 레일" }, scopeSlot];
  const nestedRoot = {
    ...root,
    children: [{ instanceId: "mounted-rail", itemId: rail.id, slotId: "rail-mount", children: [] }],
  };
  return { itemById, slots, root: nestedRoot };
}

describe("connected assembly slot presentation", () => {
  it("selects a single slot directly while keeping the central image separate from group controls", () => {
    const onSelect = vi.fn();
    render(<WeaponAssemblySlots itemById={new Map()} root={root} slots={[scopeSlot]}
      selectedSlot={null} onSelect={onSelect}><img alt="기본 총기" src="/weapon.png" /></WeaponAssemblySlots>);

    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    fireEvent.click(within(controls).getByRole("button", { name: /조준경/ }));
    expect(onSelect).toHaveBeenCalledWith({ parentInstanceId: "weapon", slotId: "scope" });
    expect(within(controls).queryByRole("img", { name: "기본 총기" })).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "기본 총기" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "선택 부위의 슬롯" })).not.toBeInTheDocument();
  });

  it("opens only one focused tray and selects nested repeated slots by exact parent and slot", () => {
    const onSelect = vi.fn();
    render(<WeaponAssemblySlots {...nestedFixture()} selectedSlot={null} onSelect={onSelect}>총기 이미지</WeaponAssemblySlots>);
    const groupButton = within(screen.getByRole("group", { name: "총기 부위 선택" }))
      .getByRole("button", { name: /전술 장비·레일/ });
    fireEvent.click(groupButton);
    expect(onSelect).not.toHaveBeenCalled();
    expect(groupButton).toHaveAttribute("aria-expanded", "true");
    const tray = screen.getByRole("region", { name: "선택 부위의 슬롯" });
    const repeated = within(tray).getAllByRole("button", { name: /RIS II › 전술 장비/ });
    expect(repeated).toHaveLength(2);
    expect(repeated[0]).toHaveAccessibleName(/①/);
    expect(repeated[1]).toHaveAccessibleName(/②/);
    fireEvent.click(repeated[1]);
    expect(onSelect).toHaveBeenCalledWith({ parentInstanceId: "mounted-rail", slotId: "slot-1" });
    fireEvent.click(within(tray).getByRole("button", { name: "슬롯 목록 접기" }));
    expect(screen.queryByRole("region", { name: "선택 부위의 슬롯" })).not.toBeInTheDocument();
  });

  it("keeps over 32 nested slots in the focused tray without adding image-overlay labels", () => {
    render(<WeaponAssemblySlots {...nestedFixture(40)} selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    expect(within(controls).getAllByRole("button")).toHaveLength(2);
    fireEvent.click(within(controls).getByRole("button", { name: /전술 장비·레일/ }));
    const tray = screen.getByRole("region", { name: "선택 부위의 슬롯" });
    expect(within(tray).getAllByRole("button", { name: /전술 장비/ })).toHaveLength(40);
    expect(within(tray).getAllByRole("button", { name: /마운트 레일/ })).toHaveLength(1);
  });

  it("updates the representative part image when the build changes", () => {
    const oldPart: WeaponCatalogItem = { id: "old", kind: "part", name: "Old scope", categories: [], iconUrl: "/old.png" };
    const newPart: WeaponCatalogItem = { id: "new", kind: "part", name: "New scope", categories: [], iconUrl: "/new.png" };
    const props = { itemById: new Map([[oldPart.id, oldPart], [newPart.id, newPart]]), slots: [scopeSlot], selectedSlot: null, onSelect: vi.fn() };
    const buildWith = (id: string) => ({ ...root, children: [{ instanceId: "scope-node", itemId: id, slotId: "scope", children: [] }] });
    const { rerender } = render(<WeaponAssemblySlots {...props} root={buildWith("old")}>총기 이미지</WeaponAssemblySlots>);
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    expect(within(controls).getByRole("button", { name: /조준경/ }).querySelector("img")).toHaveAttribute("src", "/old.png");
    rerender(<WeaponAssemblySlots {...props} root={buildWith("new")}>총기 이미지</WeaponAssemblySlots>);
    expect(within(controls).getByRole("button", { name: /조준경/ }).querySelector("img")).toHaveAttribute("src", "/new.png");
    expect(within(controls).getByRole("button", { name: /조준경/ })).toHaveTextContent("New scope");
  });

  it("clears a tray when its parent slots disappear instead of selecting a stale slot", () => {
    const fixture = nestedFixture();
    const { rerender } = render(<WeaponAssemblySlots {...fixture} selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    fireEvent.click(screen.getByRole("button", { name: /전술 장비·레일/ }));
    expect(screen.getByRole("region", { name: "선택 부위의 슬롯" })).toBeInTheDocument();
    rerender(<WeaponAssemblySlots itemById={new Map()} slots={[scopeSlot]} root={root}
      selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    expect(screen.queryByRole("region", { name: "선택 부위의 슬롯" })).not.toBeInTheDocument();
  });

  it("hides schematic lines at a changed viewing angle and explains the limitation", () => {
    const props = { ...nestedFixture(), selectedSlot: null, onSelect: vi.fn() };
    const { container, rerender } = render(<WeaponAssemblySlots {...props}>총기 이미지</WeaponAssemblySlots>);
    expect(container.querySelector(".modding-assembly-lines")).toBeInTheDocument();
    expect(screen.getByText("연결선은 부위별 개략 위치입니다.")).toBeInTheDocument();
    rerender(<WeaponAssemblySlots {...props} angled>총기 이미지</WeaponAssemblySlots>);
    expect(container.querySelector(".modding-assembly-lines")).not.toBeInTheDocument();
    expect(screen.getByText(/각도.*연결선을 숨깁니다/)).toBeInTheDocument();
  });

  it("follows a slot selected outside the picture and restores focus on Escape", () => {
    const props = { ...nestedFixture(), onSelect: vi.fn() };
    const { rerender } = render(<WeaponAssemblySlots {...props} selectedSlot={null}>총기 이미지</WeaponAssemblySlots>);
    rerender(<WeaponAssemblySlots {...props} selectedSlot={{ parentInstanceId: "mounted-rail", slotId: "slot-1" }}>총기 이미지</WeaponAssemblySlots>);
    const tray = screen.getByRole("region", { name: "선택 부위의 슬롯" });
    const selected = within(tray).getByRole("button", { name: /RIS II › 전술 장비 ②/ });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    selected.focus();
    fireEvent.keyDown(selected, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "선택 부위의 슬롯" })).not.toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "총기 부위 선택" }))
      .getByRole("button", { name: /전술 장비·레일/ })).toHaveFocus();
  });

  it("does not keep a manually opened tray when changing to another weapon", () => {
    const fixture = nestedFixture();
    const { rerender } = render(<WeaponAssemblySlots {...fixture} selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    fireEvent.click(screen.getByRole("button", { name: /전술 장비·레일/ }));
    rerender(<WeaponAssemblySlots {...fixture} root={{ ...fixture.root, instanceId: "other-weapon", itemId: "other-weapon" }}
      selectedSlot={null} onSelect={vi.fn()}>다른 총기 이미지</WeaponAssemblySlots>);
    expect(screen.queryByRole("region", { name: "선택 부위의 슬롯" })).not.toBeInTheDocument();
  });
});
