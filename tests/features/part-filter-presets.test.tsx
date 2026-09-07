import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PartCandidateControls } from "../../src/features/modding/PartCandidateControls";
import { loadPartFilterPresets, PART_FILTER_PRESETS_STORAGE_KEY } from "../../src/services/part-filter-presets";
import {
  DEFAULT_PART_CANDIDATE_FILTERS,
  type CandidateSortKey,
  type PartCandidateFilters,
} from "../../src/features/modding/part-candidate-controls";

function Controls({ traderAvailable = true }: { traderAvailable?: boolean }) {
  const [filters, setFilters] = useState<PartCandidateFilters>({ ...DEFAULT_PART_CANDIDATE_FILTERS });
  const [sortKeys, setSortKeys] = useState<CandidateSortKey[]>([]);
  return <PartCandidateControls filters={filters} onFiltersChange={setFilters}
    sortKeys={sortKeys} onSortKeysChange={setSortKeys} totalCount={5} visibleCount={5}
    traderOptions={traderAvailable ? [{ id: "mechanic", name: "Mechanic" }] : []} />;
}

function openFilters() {
  fireEvent.click(screen.getByRole("button", { name: "필터·정렬" }));
}

function openSaves() {
  fireEvent.click(screen.getByText(/^내 필터 프리셋/));
}

function sortRows() {
  return within(screen.getByRole("region", { name: "정렬 우선순위" })).getAllByRole("listitem");
}

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe("part filter preset controls", () => {
  it("offers both priority orders and clears restrictive filters on builtin apply", () => {
    render(<Controls />);
    openFilters();
    fireEvent.change(screen.getByRole("searchbox", { name: "부품 검색" }), { target: { value: "없는 이름" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /^반동 감소$/ }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "최대 플리 참고가" }), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "반동 우선 필터 프리셋 적용" }));
    expect(sortRows()[0]).toHaveTextContent("반동 감소 큰 순1순위");
    expect(sortRows()[1]).toHaveTextContent("인체공학 높은 순2순위");
    expect(screen.getByRole("searchbox", { name: "부품 검색" })).toHaveValue("");
    expect(screen.getByRole("spinbutton", { name: "최대 플리 참고가" })).toHaveValue(null);
    expect(screen.getByRole("checkbox", { name: /^반동 감소$/ })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "인체공학 우선 필터 프리셋 적용" }));
    expect(sortRows()[0]).toHaveTextContent("인체공학 높은 순1순위");
    expect(sortRows()[1]).toHaveTextContent("반동 감소 큰 순2순위");
  });

  it("saves current filters and ordering and restores them after remount", () => {
    const view = render(<Controls />);
    openFilters();
    fireEvent.click(screen.getByRole("button", { name: "인체공학 우선 필터 프리셋 적용" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "부품 검색" }), { target: { value: "MOE" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "최대 상점가 (₽ 환산)" }), { target: { value: "25000" } });
    fireEvent.change(screen.getByRole("combobox", { name: "상인" }), { target: { value: "mechanic" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "상점 가격 있음" }));
    openSaves();
    fireEvent.change(screen.getByRole("textbox", { name: "필터 프리셋 이름" }), { target: { value: "내 가성비" } });
    fireEvent.click(screen.getByRole("button", { name: "새 필터 프리셋 저장" }));
    expect(screen.getByRole("status", { name: "필터 프리셋 알림" })).toHaveTextContent("저장했습니다");
    view.unmount();
    render(<Controls />);
    openFilters(); openSaves();
    const saved = screen.getByRole("option", { name: "내 가성비" }) as HTMLOptionElement;
    fireEvent.change(screen.getByRole("combobox", { name: "저장한 필터 프리셋" }), { target: { value: saved.value } });
    fireEvent.click(screen.getByRole("button", { name: "필터 프리셋 불러오기" }));
    expect(screen.getByRole("searchbox", { name: "부품 검색" })).toHaveValue("MOE");
    expect(screen.getByRole("spinbutton", { name: "최대 상점가 (₽ 환산)" })).toHaveValue(25000);
    expect(screen.getByRole("combobox", { name: "상인" })).toHaveValue("mechanic");
    expect(screen.getByRole("checkbox", { name: "상점 가격 있음" })).toBeChecked();
    expect(sortRows()[0]).toHaveTextContent("인체공학 높은 순1순위");
    expect(sortRows()[1]).toHaveTextContent("반동 감소 큰 순2순위");
  });

  it("requires confirmation before overwriting or deleting a named preset", () => {
    render(<Controls />); openFilters(); openSaves();
    fireEvent.change(screen.getByRole("textbox", { name: "필터 프리셋 이름" }), { target: { value: "보관용" } });
    fireEvent.click(screen.getByRole("button", { name: "새 필터 프리셋 저장" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "부품 검색" }), { target: { value: "새 검색" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "선택 필터 프리셋 덮어쓰기" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 필터 프리셋 삭제" }));
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("option", { name: "보관용" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "필터 프리셋 불러오기" }));
    expect(screen.getByRole("searchbox", { name: "부품 검색" })).toHaveValue("");
    fireEvent.change(screen.getByRole("searchbox", { name: "부품 검색" }), { target: { value: "새 검색" } });
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "선택 필터 프리셋 덮어쓰기" }));
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    fireEvent.click(screen.getByRole("button", { name: "필터 프리셋 불러오기" }));
    expect(screen.getByRole("searchbox", { name: "부품 검색" })).toHaveValue("새 검색");
    fireEvent.click(screen.getByRole("button", { name: "선택 필터 프리셋 삭제" }));
    expect(screen.queryByRole("option", { name: "보관용" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "부품 검색" })).toHaveValue("새 검색");
    expect(screen.getByRole("button", { name: "반동 우선 필터 프리셋 적용" })).toBeEnabled();
  });

  it("only drops an unavailable saved trader after explicit confirmation and preserves the save", () => {
    const view = render(<Controls />); openFilters(); openSaves();
    fireEvent.change(screen.getByRole("combobox", { name: "상인" }), { target: { value: "mechanic" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "부품 검색" }), { target: { value: "MOE" } });
    fireEvent.change(screen.getByRole("textbox", { name: "필터 프리셋 이름" }), { target: { value: "상인 전용" } });
    fireEvent.click(screen.getByRole("button", { name: "새 필터 프리셋 저장" }));
    const saved = loadPartFilterPresets().presets[0];
    view.unmount(); render(<Controls traderAvailable={false} />); openFilters(); openSaves();
    fireEvent.change(screen.getByRole("combobox", { name: "저장한 필터 프리셋" }), { target: { value: saved.id } });
    fireEvent.change(screen.getByRole("searchbox", { name: "부품 검색" }), { target: { value: "유지할 설정" } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "필터 프리셋 불러오기" }));
    expect(screen.getByRole("searchbox", { name: "부품 검색" })).toHaveValue("유지할 설정");
    expect(screen.getByRole("status", { name: "필터 프리셋 알림" })).toHaveTextContent("취소했습니다");
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "필터 프리셋 불러오기" }));
    expect(screen.getByRole("searchbox", { name: "부품 검색" })).toHaveValue("MOE");
    expect(screen.getByRole("combobox", { name: "상인" })).toHaveValue("");
    expect(screen.getByRole("status", { name: "필터 프리셋 알림" })).toHaveTextContent("상인 조건만 제외");
    expect(loadPartFilterPresets().presets[0]).toEqual(saved);
  });

  it("keeps builtin presets working without replacing corrupt saved data", () => {
    localStorage.setItem(PART_FILTER_PRESETS_STORAGE_KEY, "broken data");
    render(<Controls />); openFilters(); openSaves();
    expect(screen.getByRole("alert")).toHaveTextContent("기존 자료는 보존");
    fireEvent.click(screen.getByRole("button", { name: "반동 우선 필터 프리셋 적용" }));
    expect(sortRows()[0]).toHaveTextContent("반동 감소 큰 순1순위");
    fireEvent.change(screen.getByRole("textbox", { name: "필터 프리셋 이름" }), { target: { value: "저장 시도" } });
    expect(screen.getByRole("button", { name: "새 필터 프리셋 저장" })).toBeDisabled();
    expect(localStorage.getItem(PART_FILTER_PRESETS_STORAGE_KEY)).toBe("broken data");
  });
});
