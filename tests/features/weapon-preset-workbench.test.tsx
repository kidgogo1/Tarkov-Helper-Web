import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { createFactoryBuild } from "../../src/domain/weapon-build";
import { WeaponWorkbench } from "../../src/features/modding/WeaponWorkbench";
import type { SlotSelection } from "../../src/features/modding/WeaponSlotTree";
import type { WeaponCatalog } from "../../src/types/weapon-modding";

const catalog: WeaponCatalog = {
  schemaVersion: 1, dataVersion: "2026-09-07", weaponIds: ["weapon"], items: [
    { id: "weapon", kind: "weapon", name: "시험 총기", shortName: "TEST", categories: ["rifle"],
      baseStats: { ergonomics: 50, verticalRecoil: 80, horizontalRecoil: 150, weight: 3 },
      factoryPartIds: [], slots: [{ id: "scope", name: "조준경", allowedItemIds: ["optic"] }] },
    { id: "optic", kind: "part", name: "시험 조준경", shortName: "OPTIC", categories: ["sight"],
      stats: { ergonomics: -2, weight: 0.3 },
      slots: [{ id: "mount", name: "보조 장착대", allowedItemIds: ["mount"] }] },
    { id: "mount", kind: "part", name: "시험 장착대", shortName: "MOUNT", categories: ["mount"],
      stats: { weight: 0.1 }, slots: [] },
  ],
};

function Harness() {
  const [build, setBuild] = useState(() => createFactoryBuild(catalog, "weapon"));
  const [selectedSlot, setSelectedSlot] = useState<SlotSelection | null>(null);
  return <WeaponWorkbench catalog={catalog} build={build} activeProfile="pvp"
    itemById={new Map(catalog.items.map(item => [item.id, item]))} selectedSlot={selectedSlot}
    onBuildChange={setBuild} onSlotSelect={setSelectedSlot} onReset={vi.fn()} />;
}

describe("preset editing workbench", () => {
  it("opens the parts panel from a visual slot and switches to the installed tree", () => {
    render(<Harness />);
    const parts = screen.getByRole("button", { name: "부품 선택 패널" });
    expect(parts).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(screen.getByRole("group", { name: "총기 부위 선택" }))
      .getByRole("button", { name: /조준경/ }));
    expect(screen.getByRole("button", { name: "시험 조준경 장착" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "전체 장착 트리" }));
    expect(screen.getByRole("region", { name: "장착·필수 파츠" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "시험 조준경 장착" })).not.toBeInTheDocument();
    fireEvent.click(parts);
    expect(screen.getByRole("button", { name: "시험 조준경 장착" })).toBeVisible();
  });

  it("lets the user continue into a newly installed part's child slots", () => {
    render(<Harness />);
    fireEvent.click(within(screen.getByRole("group", { name: "총기 부위 선택" }))
      .getByRole("button", { name: /조준경/ }));
    fireEvent.click(screen.getByRole("button", { name: "시험 조준경 장착" }));
    fireEvent.click(screen.getByRole("button", { name: "하위 부위: 보조 장착대" }));
    expect(screen.getByRole("region", { name: "선택한 부위" })).toHaveTextContent("OPTIC");
    expect(screen.getByRole("button", { name: "시험 장착대 장착" })).toBeVisible();
  });

  it("removes the selected part through the same edit panel", () => {
    render(<Harness />);
    fireEvent.click(within(screen.getByRole("group", { name: "총기 부위 선택" }))
      .getByRole("button", { name: /조준경/ }));
    fireEvent.click(screen.getByRole("button", { name: "시험 조준경 장착" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 부품 제거" }));
    expect(screen.getByRole("region", { name: "선택한 부위" })).toHaveTextContent("비어 있음");
    expect(screen.queryByRole("button", { name: "하위 부위: 보조 장착대" })).not.toBeInTheDocument();
  });
});
