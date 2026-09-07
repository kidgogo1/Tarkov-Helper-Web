import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WeaponVisualPreview } from "../../src/features/modding/WeaponVisualPreview";
import type { BuildNode, WeaponItem } from "../../src/types/weapon-modding";

const weapon: WeaponItem = {
  id: "5447a9cd4bdc2dbd208b4567", kind: "weapon", name: "시험 총기", categories: [],
  slots: [], factoryPartIds: [], imageUrl: "/factory.png",
  baseStats: { ergonomics: 50, verticalRecoil: 80, horizontalRecoil: 150, weight: 3 },
};
const root: BuildNode = { instanceId: "weapon:abc", itemId: weapon.id, children: [] };
const imageUrl = "data:image/png;base64,aGVsbG8=";
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(1_500); }); }
function setup() {
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ imageUrl }), {
    headers: { "Content-Type": "application/json" },
  })));
  vi.stubGlobal("fetch", fetcher);
  render(<WeaponVisualPreview root={root} weapon={weapon} itemById={new Map([[weapon.id, weapon]])}
    selectedSlot={null} onSelect={vi.fn()} />);
  return fetcher;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("preset preview viewing controls", () => {
  it("zooms locally without generating images and can restore the complete image", () => {
    const fetcher = setup();
    fireEvent.change(screen.getByRole("slider", { name: "이미지 확대율" }), { target: { value: "175" } });
    expect(screen.getByRole("figure")).toHaveStyle({ "--preview-zoom": "1.75" });
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "전체 외형 맞춤" }));
    expect(screen.getByRole("slider", { name: "이미지 확대율" })).toHaveValue("100");
  });

  it("does not generate intermediate slider angles until Apply is pressed", async () => {
    vi.useFakeTimers(); const fetcher = setup();
    expect(screen.queryByRole("slider", { name: "외형 각도" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /조립 외형 자동 갱신/ })); await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const slider = screen.getByRole("slider", { name: "외형 각도" });
    expect(slider).toHaveAttribute("min", "-180");
    expect(slider).toHaveAttribute("max", "180");
    expect(slider).toHaveAttribute("step", "15");
    fireEvent.change(slider, { target: { value: "90" } }); await tick();
    fireEvent.change(slider, { target: { value: "180" } }); await tick();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: /현재 조립 외형 · 0도/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "각도 적용" }));
    expect(screen.queryByRole("img", { name: /현재 조립 외형/ })).not.toBeInTheDocument();
    await tick();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).angle).toBe(180);
    expect(screen.getByRole("button", { name: "각도 적용" })).toBeDisabled();
    expect(screen.getByText(/실시간 3D 아님/)).toBeInTheDocument();
  });

  it("keeps quick angles and the draft slider in sync", async () => {
    vi.useFakeTimers(); const fetcher = setup();
    fireEvent.click(screen.getByRole("checkbox", { name: /조립 외형 자동 갱신/ })); await tick();
    fireEvent.change(screen.getByRole("slider", { name: "외형 각도" }), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: /^-30°$/ })); await tick();
    expect(screen.getByRole("slider", { name: "외형 각도" })).toHaveValue("-30");
    expect(JSON.parse(fetcher.mock.calls[1][1].body).angle).toBe(-30);
    expect(screen.getByRole("button", { name: "각도 적용" })).toBeDisabled();
  });

  it("opens a larger clearly identified factory image without enabling external generation", () => {
    const fetcher = setup();
    fireEvent.click(screen.getByRole("button", { name: "총기 이미지 크게 보기" }));
    expect(screen.getByRole("dialog", { name: "시험 총기 크게 보기" })).toHaveTextContent("현재 모딩 외형이 아닙니다");
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
