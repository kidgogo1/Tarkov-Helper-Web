import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PartCandidateRow } from "../../src/features/modding/PartCandidateRow";
import { DEFAULT_PART_CANDIDATE_FILTERS } from "../../src/features/modding/part-candidate-controls";
import type { WeaponPartItem } from "../../src/types/weapon-modding";

const candidate: WeaponPartItem = {
  id: "571659bb2459771fb2755a12", kind: "part", categories: ["Pistol grips"],
  name: "AR-15 Magpul MOE pistol grip (Black)", nameKo: "AR-15 Magpul MOE 권총 손잡이 (블랙)",
  shortName: "MOE AR15", stats: { recoilModifier: -2, ergonomics: 5, weight: 0.05 },
};

function show(overrides: Partial<Parameters<typeof PartCandidateRow>[0]> = {}) {
  const onSelect = vi.fn();
  const onPreview = vi.fn();
  render(<ul><PartCandidateRow activeProfile="pvp" availability="compatible" candidate={candidate}
    conflictMessage={null} disabled={false} equipped={false} filters={DEFAULT_PART_CANDIDATE_FILTERS}
    performanceDelta={{ recoil: -1.8, ergonomics: 2, weight: -0.03 }}
    onSelect={onSelect} onPreview={onPreview} {...overrides} /></ul>);
  return { onSelect, onPreview };
}

describe("PartCandidateRow aligned statistics", () => {
  it("separates intrinsic recoil percentage from the full-build replacement delta", () => {
    show();
    const comparison = screen.getByLabelText("부품 수치 비교");
    const intrinsic = within(comparison).getByLabelText("부품 효과");
    const change = within(comparison).getByLabelText("교체 후 변화");
    expect(within(intrinsic).getByLabelText("반동 보정 -2%")).toHaveTextContent("-2%");
    expect(within(change).getByLabelText("수직 반동 -1.8")).toHaveTextContent("-1.8");
    expect(within(change).getByLabelText("인체공학 +2")).toHaveTextContent("+2");
    expect(within(change).getByLabelText("무게 -0.030 kg")).toHaveTextContent("-0.030 kg");
    expect(within(change).queryByText("-1.8%")).not.toBeInTheDocument();
  });

  it("keeps missing intrinsic values distinct from known zero values", () => {
    show({ candidate: { ...candidate, stats: { ergonomics: 0 } },
      performanceDelta: { ergonomics: 0, weight: 0.12 } });
    const intrinsic = screen.getByLabelText("부품 효과");
    expect(within(intrinsic).getByLabelText("인체공학 0")).toHaveTextContent("0");
    expect(within(intrinsic).getByLabelText("무게 정보 없음")).toHaveTextContent("—");
    const change = screen.getByLabelText("교체 후 변화");
    expect(within(change).getByLabelText("인체공학 0")).toHaveTextContent("0");
    expect(within(change).getByLabelText("무게 +0.120 kg")).toHaveAttribute("data-effect", "reduced");
  });

  it("does not claim no performance change when all comparison data is missing", () => {
    show({ candidate: { ...candidate, stats: undefined }, performanceDelta: {} });
    expect(screen.getByText("성능 정보 없음")).toBeInTheDocument();
    expect(screen.queryByText("성능 변화 없음")).not.toBeInTheDocument();
  });

  it("preserves the sign of negative intrinsic accuracy modifiers", () => {
    show({ candidate: { ...candidate, stats: { centerOfImpact: -0.005 } },
      performanceDelta: { accuracy: -0.3438 } });
    const intrinsic = screen.getByLabelText("부품 효과");
    expect(within(intrinsic).getByLabelText("정확도 -0.17 MOA")).toHaveTextContent("-0.17 MOA");
    expect(within(intrinsic).queryByLabelText("정확도 0 MOA")).not.toBeInTheDocument();
  });

  it("does not show rounded negative zero as a worsening change", () => {
    show({ performanceDelta: { recoil: -0.001, ergonomics: -0.001, weight: -0.00001 } });
    const change = screen.getByLabelText("교체 후 변화");
    expect(within(change).getByLabelText("무게 0 kg")).not.toHaveAttribute("data-effect");
    expect(change).not.toHaveTextContent("-0");
  });

  it("keeps current parts unselectable while preserving image preview", () => {
    const { onSelect, onPreview } = show({ equipped: true });
    const select = screen.getByRole("button", { name: `${candidate.nameKo} 장착` });
    expect(select).toBeDisabled();
    expect(select).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("현재 장착")).toBeInTheDocument();
    fireEvent.click(select);
    fireEvent.click(screen.getByRole("button", { name: `${candidate.nameKo} 이미지 크게 보기` }));
    expect(onSelect).not.toHaveBeenCalled();
    expect(onPreview).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("교체 후 변화")).not.toBeInTheDocument();
  });
});
