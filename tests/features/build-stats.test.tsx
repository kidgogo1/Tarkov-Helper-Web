import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BuildStats } from "../../src/features/modding/BuildStats";
import type { WeaponStats } from "../../src/types/weapon-modding";

const factory: WeaponStats = {
  weight: 3, ergonomics: 50, verticalRecoil: 80, horizontalRecoil: 160,
  accuracyMoa: 2, muzzleVelocityModifier: 0,
};
function show(stats: WeaponStats, factoryStats = factory) {
  return render(<BuildStats stats={stats} factoryStats={factoryStats}
    itemById={new Map()} validation={{ isValid: true, issues: [] }} />);
}

describe("factory-to-current weapon stat bars", () => {
  it("keeps six aligned metrics and shows no change for the default build", () => {
    show(factory);
    const table = screen.getByRole("table", { name: "기본 총기 대비 성능" });
    expect(within(table).getAllByRole("row")).toHaveLength(7);
    expect(within(table).getAllByText("변화 없음")).toHaveLength(6);
    expect(within(table).getByRole("columnheader", { name: "기본" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "현재" })).toBeInTheDocument();
  });

  it("compares current to factory values and distinguishes lower-is-better metrics", () => {
    show({ ...factory, weight: 2.97, ergonomics: 52, verticalRecoil: 78.2, horizontalRecoil: 156.4, accuracyMoa: 2.2 });
    const recoil = screen.getByRole("row", { name: /^수직 반동/ });
    expect(within(recoil).getByText("78.2")).toBeInTheDocument();
    expect(within(recoil).getByText("-1.8")).toBeInTheDocument();
    expect(within(recoil).getByText("개선")).toBeInTheDocument();
    expect(recoil.querySelector("[data-effect='improved']")).toBeInTheDocument();
    const weight = screen.getByRole("row", { name: /^무게/ });
    expect(within(weight).getByText("-0.030 kg")).toBeInTheDocument();
    expect(within(weight).getByText("개선")).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^인체공학/ })).toHaveTextContent("+2");
    expect(screen.getByRole("row", { name: /^정확도/ })).toHaveTextContent("저하");
  });

  it("handles signed velocity, zero baselines and small rounded changes without invalid geometry", () => {
    const zero = { ...factory, ergonomics: 0, muzzleVelocityModifier: -10 };
    show({ ...zero, ergonomics: 5, muzzleVelocityModifier: -5, verticalRecoil: 80.000001 }, zero);
    expect(screen.getByRole("row", { name: /^총구 속도 보정/ })).toHaveTextContent("+5%p");
    expect(screen.getByRole("row", { name: /^수직 반동/ })).toHaveTextContent("변화 없음");
    for (const el of document.querySelectorAll<HTMLElement>(".modding-stat-graph [style]")) {
      expect(el.getAttribute("style")).not.toMatch(/NaN|Infinity/);
      for (const value of [el.style.left, el.style.width]) {
        if (value) expect(Number.parseFloat(value)).toBeGreaterThanOrEqual(0);
        if (value) expect(Number.parseFloat(value)).toBeLessThanOrEqual(100);
      }
    }
  });

  it("leaves unavailable MOA empty but treats the calculator's omitted velocity modifier as zero", () => {
    const missing = { ...factory, accuracyMoa: undefined, muzzleVelocityModifier: undefined };
    show(missing, missing);
    const accuracy = screen.getByRole("row", { name: /^정확도/ });
    expect(within(accuracy).getAllByText("자료 없음")).toHaveLength(2);
    expect(accuracy).toHaveTextContent("비교 불가");
    expect(accuracy.querySelector(".modding-stat-graph")).not.toBeInTheDocument();
    expect(screen.getByRole("row", { name: /^총구 속도 보정/ })).toHaveTextContent("변화 없음");
    expect(screen.getByRole("row", { name: /^총구 속도 보정/ })).not.toHaveTextContent("m/s");
  });
});
