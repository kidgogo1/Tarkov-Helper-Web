import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BuildPriceSummary } from "../../src/features/modding/BuildPriceSummary";
import type {
  BuildPriceGroupSummary,
  BuildPriceSummary as PriceSummary,
} from "../../src/features/modding/build-price-summary";

function group(price: number, count = 1): BuildPriceGroupSummary {
  return {
    itemCount: count,
    knownTotalRoubles: price,
    missingItemCount: 0,
    missingItems: [],
    pricedItemCount: count,
    questUnlocks: [],
    sourceCounts: { flea: 0, trader: count },
    totalRoubles: price,
    traderRequirements: count ? [{ traderId: "mechanic", traderName: "Mechanic", loyaltyLevel: 3 }] : [],
  };
}

function summary(mode: "buy" | "owned" = "buy", extraCount = 0): PriceSummary {
  const weapon = mode === "owned" ? group(0, 0) : group(100_000);
  const strategies = Object.fromEntries((["trader", "flea", "cheapest"] as const).map((strategy) => {
    const unitPrice = strategy === "flea" ? 4_000 : 3_000;
    const parts = group(extraCount * unitPrice, extraCount);
    const total = group(weapon.knownTotalRoubles + parts.knownTotalRoubles, weapon.itemCount + extraCount);
    return [strategy, {
      weapon,
      parts,
      total,
      questUnlocks: total.questUnlocks,
      sourceCounts: total.sourceCounts,
      traderRequirements: total.traderRequirements,
      purchaseLines: extraCount ? [{
        itemId: "rail",
        name: "추가 레일",
        imageUrl: "/assets/rail.png",
        quantity: extraCount,
        priceRoubles: unitPrice,
        source: strategy === "flea" ? "flea" : "trader",
        traderOffer: strategy === "flea" ? undefined : {
          traderId: "mechanic", traderName: "Mechanic", loyaltyLevel: 3,
          price: 3_000, priceRoubles: 3_000, currency: "RUB",
        },
        fleaMinimumPlayerLevel: strategy === "flea" ? 15 : undefined,
      }] : [],
    }];
  })) as PriceSummary["strategies"];
  return {
    itemCount: 4 + extraCount,
    partCount: 3 + extraCount,
    includedPartCount: 3,
    additionalPartCount: extraCount,
    removedFactoryPartCount: 1,
    purchaseMode: mode,
    weaponReferences: { receiverTrader: group(20_000), flea: group(45_000) },
    strategies,
  };
}

describe("BuildPriceSummary purchase view", () => {
  it("labels the complete-weapon quote date independently from bundled part references", () => {
    render(<BuildPriceSummary activeProfile="pvp" factoryPriceUpdatedAt="2026-09-07T04:00:00.000Z" summary={summary()} purchaseMode="buy" onPurchaseModeChange={vi.fn()} />);
    expect(screen.getByText("완제품 상점가 확인: 2026-09-07 · 부품가는 포함 데이터 기준"))
      .toBeInTheDocument();
  });

  it("separates complete factory gun cost from free included parts and additional purchases", () => {
    render(<BuildPriceSummary activeProfile="pvp" summary={summary()} purchaseMode="buy" onPurchaseModeChange={vi.fn()} />);
    expect(screen.getByText("기본 구성 재사용 3개")).toBeInTheDocument();
    expect(screen.getByText("추가 구매 0개")).toBeInTheDocument();
    for (const name of ["상인만 구매 예상 비용", "플리만 구매 예상 비용", "최저가 혼합 구매 예상 비용"]) {
      const plan = screen.getByRole("region", { name });
      expect(within(plan).getByText("총 예상 비용")).toBeInTheDocument();
      expect(within(plan).getAllByText("₽100,000")).toHaveLength(2);
      expect(within(plan).getByText("₽0")).toBeInTheDocument();
    }
    expect(screen.getByText(/남는 기본 부품 1개/)).toHaveTextContent("판매금은 차감하지 않습니다");
  });

  it("offers explicit purchase modes without assuming arbitrary inventory ownership", () => {
    const change = vi.fn();
    const { rerender } = render(<BuildPriceSummary activeProfile="pvp" summary={summary()} purchaseMode="buy" onPurchaseModeChange={change} />);
    fireEvent.click(screen.getByRole("radio", { name: "기본 총기 보유" }));
    expect(change).toHaveBeenCalledWith("owned");
    rerender(<BuildPriceSummary activeProfile="pvp" summary={summary("owned")} purchaseMode="owned" onPurchaseModeChange={change} />);
    expect(screen.getByRole("radio", { name: "기본 총기 보유" })).toBeChecked();
    expect(screen.getByText(/상점 기본 구성을 보유한 경우/)).toBeInTheDocument();
    const plan = screen.getByRole("region", { name: "상인만 구매 예상 비용" });
    expect(within(plan).queryByText("₽100,000")).not.toBeInTheDocument();
    expect(within(plan).getAllByText("₽0")).toHaveLength(3);
  });

  it("shows grouped purchase quantities, unit price and subtotal with selectable source strategy", () => {
    render(<BuildPriceSummary activeProfile="pvp" summary={summary("buy", 2)} purchaseMode="buy" onPurchaseModeChange={vi.fn()} />);
    fireEvent.click(screen.getByText("추가 구매 목록 · 2개"));
    const list = screen.getByRole("list", { name: "추가 구매 부품 목록" });
    const row = within(list).getByRole("listitem");
    expect(within(row).getByText("추가 레일")).toBeInTheDocument();
    expect(within(row).getByText("2개")).toBeInTheDocument();
    expect(within(row).getByText("단가 ₽3,000")).toBeInTheDocument();
    expect(within(row).getByText("소계 ₽6,000")).toBeInTheDocument();
    expect(within(row).getByText("Mechanic LL3")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "구매 목록 기준" }), { target: { value: "flea" } });
    expect(within(row).getByText("단가 ₽4,000")).toBeInTheDocument();
    expect(within(row).getByText("소계 ₽8,000")).toBeInTheDocument();
    expect(within(row).getByText("플리 · Lv.15")).toBeInTheDocument();
  });

  it("identifies missing prices without presenting a partial sum as an attainable minimum", () => {
    const value = summary("owned", 2);
    const missing = { instanceId: "unknown", itemId: "unknown", name: "가격 없는 손잡이" };
    for (const strategy of Object.values(value.strategies)) {
      strategy.parts = { ...strategy.parts, totalRoubles: null, missingItemCount: 1, missingItems: [missing] };
      strategy.total = { ...strategy.total, totalRoubles: null, missingItemCount: 1, missingItems: [missing] };
      strategy.purchaseLines.push({ itemId: "unknown", name: missing.name, quantity: 1, source: "missing" });
    }
    render(<BuildPriceSummary activeProfile="pvp" summary={value} purchaseMode="owned" onPurchaseModeChange={vi.fn()} />);
    const plan = screen.getByRole("region", { name: "상인만 구매 예상 비용" });
    expect(within(plan).getByText("확인된 합계 ₽6,000")).toBeInTheDocument();
    expect(within(plan).getByText("미확인 1개 · 총액 미완성")).toBeInTheDocument();
    expect(screen.queryByText(/^최소 /)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("추가 구매 목록 · 2개"));
    expect(screen.getByText("가격 없는 손잡이")).toBeInTheDocument();
    expect(screen.getByText("가격 미확인 · 별도 확인 필요")).toBeInTheDocument();
  });

  it("keeps receiver and flea references outside the purchase totals", () => {
    render(<BuildPriceSummary activeProfile="pve" summary={summary()} purchaseMode="buy" onPurchaseModeChange={vi.fn()} />);
    const referenceToggle = screen.getByText("본체·플리 참고가 보기");
    expect(referenceToggle.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(referenceToggle);
    const references = screen.getByRole("region", { name: "총기 참고가 · 합계 제외" });
    expect(within(references).getByText("₽20,000")).toBeInTheDocument();
    expect(within(references).getByText("₽45,000")).toBeInTheDocument();
    expect(within(references).getByText(/기본 부품 구성이 보장되지 않아/)).toBeInTheDocument();
  });
});
