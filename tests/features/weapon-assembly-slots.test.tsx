import { act, fireEvent, render, screen, within } from "@testing-library/react";
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

describe("individual assembly slot presentation", () => {
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

  it("selects each repeated nested slot directly by its exact parent and slot", () => {
    const onSelect = vi.fn();
    render(<WeaponAssemblySlots {...nestedFixture()} selectedSlot={null} onSelect={onSelect}>총기 이미지</WeaponAssemblySlots>);
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    const repeated = within(controls).getAllByRole("button", { name: /전술 장비.*RIS II/ });
    expect(repeated).toHaveLength(2);
    expect(repeated[0]).toHaveAccessibleName(/①/);
    expect(repeated[1]).toHaveAccessibleName(/②/);
    fireEvent.click(repeated[1]);
    expect(onSelect).toHaveBeenCalledWith({ parentInstanceId: "mounted-rail", slotId: "slot-1" });
    expect(screen.queryByRole("region", { name: "선택 부위의 슬롯" })).not.toBeInTheDocument();
  });

  it("keeps over 32 nested slots accessible across pages of at most 14 individual cards", () => {
    const onSelect = vi.fn();
    render(<WeaponAssemblySlots {...nestedFixture(40)} selectedSlot={null} onSelect={onSelect}>총기 이미지</WeaponAssemblySlots>);
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    const keys: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const buttons = within(controls).getAllByRole("button");
      expect(buttons).toHaveLength(14);
      keys.push(...buttons.map((button) => button.getAttribute("data-slot-key")!));
      if (page < 2) fireEvent.click(screen.getByRole("button", { name: "다음 슬롯 페이지" }));
    }
    expect(new Set(keys).size).toBe(42);
    expect(screen.getByRole("button", { name: "다음 슬롯 페이지" })).toBeDisabled();
    fireEvent.click(within(controls).getByRole("button", { name: /전술 장비 \(40\)/ }));
    expect(onSelect).toHaveBeenCalledWith({ parentInstanceId: "mounted-rail", slotId: "slot-39" });
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

  it("removes child cards when their parent disappears and clamps a stale page", () => {
    const fixture = nestedFixture(40);
    const { rerender } = render(<WeaponAssemblySlots {...fixture} selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    fireEvent.click(screen.getByRole("button", { name: "다음 슬롯 페이지" }));
    rerender(<WeaponAssemblySlots itemById={new Map()} slots={[scopeSlot]} root={root}
      selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    expect(within(controls).getAllByRole("button")).toHaveLength(1);
    expect(within(controls).queryByRole("button", { name: /전술 장비/ })).not.toBeInTheDocument();
    expect(screen.getByText("1 / 1 페이지")).toBeInTheDocument();
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

  it("finds an externally selected slot page and can return to it after manual navigation", () => {
    const props = { ...nestedFixture(40), onSelect: vi.fn() };
    const { rerender } = render(<WeaponAssemblySlots {...props} selectedSlot={null}>총기 이미지</WeaponAssemblySlots>);
    rerender(<WeaponAssemblySlots {...props} selectedSlot={{ parentInstanceId: "mounted-rail", slotId: "slot-39" }}>총기 이미지</WeaponAssemblySlots>);
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    const selected = within(controls).getByRole("button", { name: /전술 장비 \(40\)/ });
    expect(selected).toHaveAttribute("aria-pressed", "true");
    expect(within(controls).getAllByRole("button", { pressed: true })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "이전 슬롯 페이지" }));
    expect(within(controls).queryByRole("button", { pressed: true })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "선택 슬롯 보기" }));
    expect(within(controls).getByRole("button", { pressed: true })).toHaveAccessibleName(/전술 장비 \(40\)/);
  });

  it("does not keep a manually selected page when changing to another weapon", () => {
    const fixture = nestedFixture(40);
    const { rerender } = render(<WeaponAssemblySlots {...fixture} selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    fireEvent.click(screen.getByRole("button", { name: "다음 슬롯 페이지" }));
    expect(screen.getByText("2 / 3 페이지")).toBeInTheDocument();
    rerender(<WeaponAssemblySlots {...fixture} root={{ ...fixture.root, instanceId: "other-weapon", itemId: "other-weapon" }}
      selectedSlot={null} onSelect={vi.fn()}>다른 총기 이미지</WeaponAssemblySlots>);
    expect(screen.getByText("1 / 3 페이지")).toBeInTheDocument();
  });

  it("explains when a filter hides the selected slot and offers the complete list", () => {
    render(<WeaponAssemblySlots {...nestedFixture()} selectedSlot={{ parentInstanceId: "weapon", slotId: "scope" }}
      onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    const filters = screen.getByRole("group", { name: "슬롯 표시 필터" });
    fireEvent.click(within(filters).getByRole("button", { name: /^장착/ }));
    expect(screen.getByText(/선택한 슬롯이 현재 필터에서 숨겨져 있습니다/)).toBeInTheDocument();
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    expect(within(controls).getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "전체 슬롯 보기" }));
    expect(within(controls).getByRole("button", { name: /조준경/ })).toHaveAttribute("aria-pressed", "true");
    expect(within(controls).getAllByRole("button")).toHaveLength(4);
  });

  it("filters required and empty slots using the current build", () => {
    const fixture = nestedFixture();
    fixture.slots[0].required = true;
    render(<WeaponAssemblySlots {...fixture} selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
    const filters = screen.getByRole("group", { name: "슬롯 표시 필터" });
    const controls = screen.getByRole("group", { name: "총기 부위 선택" });
    fireEvent.click(within(filters).getByRole("button", { name: /^필수/ }));
    expect(within(controls).getAllByRole("button")).toHaveLength(1);
    expect(within(controls).getByRole("button")).toHaveAccessibleName(/장착됨.*필수/);
    fireEvent.click(within(filters).getByRole("button", { name: /^빈 슬롯/ }));
    expect(within(controls).getAllByRole("button")).toHaveLength(3);
  });

  it("keeps the central stage and both card rows mounted when a filter has no results", () => {
    const { container } = render(<WeaponAssemblySlots {...nestedFixture()} selectedSlot={null} onSelect={vi.fn()}>
      <img alt="기본 총기" src="/weapon.png" />
    </WeaponAssemblySlots>);
    const center = screen.getByRole("img", { name: "기본 총기" });
    const note = container.querySelector(".modding-assembly-selection-note");
    expect(note).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "슬롯 표시 필터" })).getByRole("button", { name: /^필수/ }));
    expect(screen.getByText("현재 필터에 해당하는 슬롯이 없습니다.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "기본 총기" })).toBe(center);
    expect(container.querySelectorAll(".modding-assembly-edge")).toHaveLength(2);
    expect(container.querySelector(".modding-assembly-selection-note")).toBe(note);
  });

  it("adapts page capacity to container resize and cleans up its observer", () => {
    let width = 320;
    let resize = () => {};
    const disconnect = vi.fn();
    const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width }) as DOMRect);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    try {
      const { unmount } = render(<WeaponAssemblySlots {...nestedFixture(40)} selectedSlot={null} onSelect={vi.fn()}>총기 이미지</WeaponAssemblySlots>);
      const controls = screen.getByRole("group", { name: "총기 부위 선택" });
      expect(within(controls).getAllByRole("button")).toHaveLength(4);
      expect(screen.getByText("1 / 11 페이지")).toBeInTheDocument();
      act(() => { width = 800; resize(); });
      expect(within(controls).getAllByRole("button")).toHaveLength(14);
      expect(screen.getByText("1 / 3 페이지")).toBeInTheDocument();
      unmount();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
