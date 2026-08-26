import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WeaponModdingPage } from "../../src/features/modding/WeaponModdingPage";

const M4A1_ID = "5447a9cd4bdc2dbd208b4567";
const SECOND_WEAPON_ID = "5644bd2b4bdc2d3b4c8b4572";
const EOTECH_ID = "558022b54bdc2dac148b458d";
const SCOPE_SLOT_ID = "55d30c4c4bdc2db4468b457f";
const ERGO_SIGHT_ID = "558022b54bdc2dac148b4590";
const RECOIL_SIGHT_ID = "558022b54bdc2dac148b4591";

const catalog = {
  schemaVersion: 1 as const,
  dataVersion: "2026-08-26",
  weaponIds: [M4A1_ID],
  items: [
    {
      id: M4A1_ID,
      kind: "weapon" as const,
      name: "Colt M4A1 5.56x45 assault rifle",
      shortName: "M4A1",
      categories: ["Assault rifles"],
      imageUrl: "/assets/weapon-modding/m4a1.png",
      factoryPartIds: [],
      baseStats: {
        verticalRecoil: 80,
        horizontalRecoil: 160,
        ergonomics: 50,
        weight: 3,
      },
      slots: [
        {
          id: SCOPE_SLOT_ID,
          name: "조준경",
          allowedCategories: ["Sights"],
        },
      ],
    },
    {
      id: EOTECH_ID,
      kind: "part" as const,
      name: "EOTech EXPS3 holographic sight",
      shortName: "EXPS3",
      categories: ["Sights"],
      imageUrl: "/assets/weapon-modding/eotech-exps3.png",
      stats: {
        ergonomics: -2,
        weight: 0.34,
      },
      slots: [{
        id: "55d30c4c4bdc2db4468b4580",
        name: "보조 장착대",
        allowedCategories: ["Mounts"],
      }],
      fleaByProfile: {
        pvp: {
          price: 45_000,
          currency: "RUB",
          updatedAt: "2026-08-26T00:00:00.000Z",
          minimumPlayerLevel: 15,
        },
        pve: {
          price: 55_000,
          currency: "RUB",
          updatedAt: "2026-08-26T00:00:00.000Z",
          minimumPlayerLevel: 25,
        },
      },
      traderOffersByProfile: {
        pvp: [{
          traderId: "5a7c2eca46aef81a7ca2145d",
          traderName: "Mechanic",
          price: 6_498,
          priceRoubles: 6_498,
          currency: "RUB",
          loyaltyLevel: 2,
        }, {
          traderId: "5935c25fb3acc3127c3d8cd9",
          traderName: "Peacekeeper",
          price: 50,
          priceRoubles: 6_000,
          currency: "USD",
          loyaltyLevel: 2,
          questUnlock: {
            questId: "5969f9e986f7741dde183a50",
            questName: "약사",
            minimumPlayerLevel: 10,
          },
        }],
        pve: [{
          traderId: "5a7c2eca46aef81a7ca2145d",
          traderName: "Mechanic",
          price: 5_000,
          priceRoubles: 5_000,
          currency: "RUB",
          loyaltyLevel: 1,
        }],
      },
    },
  ],
};

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("WeaponModdingPage", () => {
  it("searches a weapon, opens one of its slots, and equips a compatible part", async () => {
    const onWeaponSelect = vi.fn();

    render(
      <WeaponModdingPage
        activeProfile="pvp"
        loadCatalog={() => Promise.resolve(catalog)}
        onWeaponSelect={onWeaponSelect}
      />,
    );

    const search = await screen.findByRole("searchbox", { name: "총기 검색" });
    expect(screen.getByText("가격·호환성 데이터: 번들 기준 2026-08-26 · 실시간 아님"))
      .toBeInTheDocument();
    expect(screen.getByText("총기를 선택하세요")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "M4A1" } });
    fireEvent.click(
      screen.getByRole("button", { name: /Colt M4A1 5\.56x45 assault rifle/ }),
    );

    expect(onWeaponSelect).toHaveBeenCalledWith(M4A1_ID);
    const scopeSlot = within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ });
    fireEvent.click(scopeSlot);
    const eotechChoice = screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 장착",
    });
    expect(within(eotechChoice).getByText("플리 참고가 · Lv.15")).toBeInTheDocument();
    expect(within(eotechChoice).getByText("₽45,000")).toBeInTheDocument();
    expect(eotechChoice).toHaveTextContent("인체공학 -2");
    expect(eotechChoice).toHaveTextContent("무게 0.340 kg");
    expect(within(eotechChoice).getByText("상점 · Peacekeeper LL2")).toBeInTheDocument();
    expect(within(eotechChoice).getByText("$50 (≈ ₽6,000)")).toBeInTheDocument();
    expect(eotechChoice).toHaveTextContent("약사 퀘스트 (Lv.10)");
    fireEvent.click(
      screen.getByRole("button", { name: "EOTech EXPS3 holographic sight 장착" }),
    );

    expect(within(screen.getByRole("region", { name: "장착·필수 파츠" })).getByRole(
      "button",
      { name: /조준경.*EOTech EXPS3/ },
    )).toHaveTextContent(
      "EOTech EXPS3 holographic sight",
    );
    const stats = screen.getByRole("region", { name: "무기 능력치" });
    expect(stats).toHaveTextContent(/인체공학\s*48/);
    expect(stats).toHaveTextContent(/무게\s*3\.34\s*kg/);
  });

  it("places build stats with the weapon and exposes compatible parts as a list", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );

    const weaponHeading = await screen.findByRole("heading", { name: /Colt M4A1/ });
    const weaponStage = weaponHeading.closest(".modding-weapon-stage");
    const buildStats = screen.getByRole("region", { name: "무기 능력치" });
    const installedParts = screen.getByRole("region", { name: "장착·필수 파츠" });

    expect(weaponStage).toContainElement(buildStats);
    expect(weaponStage).not.toContainElement(installedParts);

    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));

    expect(screen.getByRole("complementary", { name: "호환 부품 선택" })).toHaveFocus();
    const candidateList = screen.getByRole("list", { name: "호환 부품 목록" });
    const candidateRow = within(candidateList).getByRole("listitem");
    expect(within(candidateRow).getByText("EOTech EXPS3 holographic sight"))
      .toBeInTheDocument();
    expect(within(candidateRow).getByText("EXPS3")).toBeInTheDocument();
    expect(within(candidateRow).getByText("인체공학 -2")).toBeInTheDocument();
  });

  it("combines candidate filters and lets users reorder multiple sort priorities", async () => {
    const filterCatalog = {
      ...catalog,
      items: [
        ...catalog.items,
        {
          id: ERGO_SIGHT_ID,
          kind: "part" as const,
          name: "Ergonomic premium sight",
          nameKo: "인체공학 프리미엄 조준경",
          shortName: "ERGO+",
          categories: ["Sights"],
          imageUrl: "/assets/weapon-modding/ergo-premium.png",
          stats: { ergonomics: 6, recoilModifier: -3, weight: 0.28 },
          traderOffersByProfile: {
            pvp: [{
              traderId: "5a7c2eca46aef81a7ca2145d",
              traderName: "Mechanic",
              price: 18_000,
              priceRoubles: 18_000,
              currency: "RUB",
              loyaltyLevel: 2,
            }],
          },
          fleaByProfile: {
            pvp: {
              price: 24_000,
              currency: "RUB",
              updatedAt: "2026-08-26T00:00:00.000Z",
              minimumPlayerLevel: 15,
            },
          },
        },
        {
          id: RECOIL_SIGHT_ID,
          kind: "part" as const,
          name: "Recoil budget sight",
          nameKo: "반동 특화 보급형 조준경",
          shortName: "RECOIL",
          categories: ["Sights"],
          imageUrl: "/assets/weapon-modding/recoil-budget.png",
          stats: { ergonomics: 1, recoilModifier: -8, weight: 0.4 },
          traderOffersByProfile: {
            pvp: [{
              traderId: "5935c25fb3acc3127c3d8cd9",
              traderName: "Peacekeeper",
              price: 12_000,
              priceRoubles: 12_000,
              currency: "RUB",
              loyaltyLevel: 3,
            }],
          },
        },
      ],
    };
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(filterCatalog)}
      />,
    );

    await screen.findByRole("heading", { name: /Colt M4A1/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));
    fireEvent.click(screen.getByRole("button", { name: "필터·정렬" }));

    fireEvent.click(screen.getByRole("checkbox", { name: "상점 가격 있음" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "플리 참고가 있음" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "인체공학 증가" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "최대 상점가" }), {
      target: { value: "19000" },
    });

    const list = screen.getByRole("list", { name: "호환 부품 목록" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).getByText("인체공학 프리미엄 조준경")).toBeInTheDocument();
    expect(screen.getByText("1 / 3개 표시")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "상점가 낮은 순" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "인체공학 높은 순" }));

    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent("EOTech EXPS3");
    fireEvent.click(screen.getByRole("button", {
      name: "인체공학 높은 순 우선순위 올리기",
    }));
    expect(within(list).getAllByRole("listitem")[0]).toHaveTextContent(
      "인체공학 프리미엄 조준경",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "인체공학 높은 순이 1순위가 되었습니다",
    );
  });

  it("places trader prices before flea references and keeps both price columns stable", async () => {
    const traderOnlyCatalog = {
      ...catalog,
      items: [
        ...catalog.items,
        {
          id: RECOIL_SIGHT_ID,
          kind: "part" as const,
          name: "Trader-only sight",
          shortName: "SHOP",
          categories: ["Sights"],
          imageUrl: "/assets/weapon-modding/trader-only.png",
          stats: { ergonomics: 1, weight: 0.2 },
          traderOffersByProfile: {
            pvp: [{
              traderId: "5a7c2eca46aef81a7ca2145d",
              traderName: "Mechanic",
              price: 9_500,
              priceRoubles: 9_500,
              currency: "RUB",
              loyaltyLevel: 1,
            }],
          },
        },
      ],
    };
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(traderOnlyCatalog)}
      />,
    );

    await screen.findByRole("heading", { name: /Colt M4A1/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));

    const candidateList = screen.getByRole("list", { name: "호환 부품 목록" });
    const eotechRow = within(candidateList).getByText(
      "EOTech EXPS3 holographic sight",
    ).closest("li");
    const priceCells = eotechRow?.querySelectorAll("[data-price-kind]") ?? [];
    expect([...priceCells].map((cell) => cell.getAttribute("data-price-kind")))
      .toEqual(["trader", "flea"]);
    expect(priceCells[0]).toHaveTextContent("상점 · Peacekeeper LL2");
    expect(priceCells[0]).toHaveTextContent("$50 (≈ ₽6,000)");
    expect(priceCells[1]).toHaveTextContent("플리 참고가 · Lv.15");
    expect(priceCells[1]).toHaveTextContent("₽45,000");

    const traderOnlyRow = within(candidateList).getByText("Trader-only sight").closest("li");
    const traderOnlyCells = traderOnlyRow?.querySelectorAll("[data-price-kind]") ?? [];
    expect([...traderOnlyCells].map((cell) => cell.getAttribute("data-price-kind")))
      .toEqual(["trader", "flea"]);
    expect(traderOnlyCells[1]).toHaveAttribute("data-empty", "true");
    expect(traderOnlyCells[1]).toHaveTextContent("플리 정보 없음");
  });

  it("opens a large part image without equipping it and restores thumbnail focus", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );

    await screen.findByRole("heading", { name: /Colt M4A1/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));

    const previewButton = screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 이미지 크게 보기",
    });
    const equipButton = screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 장착",
    });
    expect(previewButton).toHaveAttribute("aria-haspopup", "dialog");
    previewButton.focus();
    fireEvent.click(previewButton);

    const dialog = await screen.findByRole("dialog", {
      name: "EOTech EXPS3 holographic sight 이미지",
    });
    expect(within(dialog).getByRole("img", {
      name: "EOTech EXPS3 holographic sight 크게 보기",
    })).toHaveAttribute("src", "/assets/weapon-modding/eotech-exps3.png");
    expect(within(screen.getByRole("region", { name: "장착·필수 파츠" })).queryByRole(
      "button",
      { name: /조준경.*EOTech EXPS3/ },
    )).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(previewButton).toHaveFocus());

    fireEvent.click(equipButton);
    expect(within(screen.getByRole("region", { name: "장착·필수 파츠" })).getByRole(
      "button",
      { name: /조준경.*EOTech EXPS3/ },
    )).toBeInTheDocument();
  });

  it("shows a slot-allowed conflicting part and confirms its automatic swap", async () => {
    const blockerId = "5a0000000000000000000100";
    const conflictOpticId = "5a0000000000000000000101";
    const blockerSlotId = "5a0000000000000000000102";
    const secondWeapon = {
      ...catalog.items[0],
      id: SECOND_WEAPON_ID,
      name: "Kalashnikov AK-74N 5.45x39 assault rifle",
      shortName: "AK-74N",
    };
    const conflictCatalog = {
      ...catalog,
      weaponIds: [M4A1_ID, SECOND_WEAPON_ID],
      items: [
        {
          ...catalog.items[0],
          factoryPartIds: [blockerId],
          slots: [
            ...catalog.items[0].slots,
            {
              id: blockerSlotId,
              name: "보조 레일",
              allowedItemIds: [blockerId],
            },
          ],
        },
        ...catalog.items.slice(1),
        {
          id: blockerId,
          kind: "part" as const,
          name: "Blocking rail",
          shortName: "BLOCK",
          categories: ["Mounts"],
        },
        {
          id: conflictOpticId,
          kind: "part" as const,
          name: "Conflict-aware optic",
          shortName: "CAO",
          categories: ["Sights"],
          conflicts: { itemIds: [blockerId] },
          stats: { ergonomics: 1 },
        },
        secondWeapon,
      ],
    };
    const confirm = vi.spyOn(window, "confirm")
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const view = render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(conflictCatalog)}
      />,
    );

    await screen.findByRole("heading", { name: /Colt M4A1/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));

    const conflictChoice = screen.getByRole("button", { name: "Conflict-aware optic 장착" });
    expect(conflictChoice).toHaveTextContent("선택 시 자동 해제: Blocking rail");
    expect(screen.getByText("2개 장착 가능")).toBeInTheDocument();
    fireEvent.click(conflictChoice);

    const installedParts = screen.getByRole("region", { name: "장착·필수 파츠" });
    expect(within(installedParts).queryByRole("button", {
      name: /조준경.*Conflict-aware optic/,
    })).not.toBeInTheDocument();
    expect(within(installedParts).getByRole("button", {
      name: /보조 레일.*Blocking rail/,
    })).toBeInTheDocument();

    fireEvent.click(conflictChoice);

    expect(confirm).toHaveBeenLastCalledWith(expect.stringMatching(
      /Conflict-aware optic.*Blocking rail.*자동으로 해제/,
    ));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Conflict-aware optic 장착 · Blocking rail 자동 해제",
    );
    expect(within(screen.getByRole("region", { name: "장착·필수 파츠" })).getByRole(
      "button",
      { name: /조준경.*Conflict-aware optic/ },
    )).toBeInTheDocument();

    view.rerender(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={SECOND_WEAPON_ID}
        loadCatalog={() => Promise.resolve(conflictCatalog)}
      />,
    );
    await screen.findByRole("heading", { name: /Kalashnikov AK-74N/ });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("keeps a root-conflicting slot candidate visible but disabled", async () => {
    const blockedOpticId = "5a0000000000000000000110";
    const blockedCatalog = {
      ...catalog,
      items: [
        ...catalog.items,
        {
          id: blockedOpticId,
          kind: "part" as const,
          name: "Impossible optic",
          shortName: "NOPE",
          categories: ["Sights"],
          conflicts: { itemIds: [M4A1_ID] },
        },
      ],
    };
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(blockedCatalog)}
      />,
    );

    await screen.findByRole("heading", { name: /Colt M4A1/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));

    const blockedChoice = screen.getByRole("button", { name: "Impossible optic 장착" });
    const blockedPreview = screen.getByRole("button", {
      name: "Impossible optic 이미지 크게 보기",
    });
    expect(blockedChoice).toBeDisabled();
    expect(blockedPreview).toBeEnabled();
    expect(blockedChoice).toHaveTextContent(
      "장착 불가: Colt M4A1 5.56x45 assault rifle과 충돌",
    );
    expect(screen.getByText("1개 장착 가능 · 전체 2개")).toBeInTheDocument();
  });

  it("honors a weapon selected by a safe deep link", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pve"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: /Colt M4A1 5\.56x45 assault rifle/ }),
    ).toBeInTheDocument();
    const scopeSlot = within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ });
    expect(scopeSlot).toBeInTheDocument();
    fireEvent.click(scopeSlot);
    const eotechChoice = screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 장착",
    });
    expect(within(eotechChoice).getByText("플리 참고가 · Lv.25")).toBeInTheDocument();
    expect(within(eotechChoice).getByText("₽55,000")).toBeInTheDocument();
    expect(within(eotechChoice).getByText("상점 · Mechanic LL1")).toBeInTheDocument();
    expect(within(eotechChoice).getByText("₽5,000")).toBeInTheDocument();
  });

  it("clears a nested slot selection when its parent part is removed", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );

    await screen.findByRole("heading", { name: /Colt M4A1/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));
    fireEvent.click(screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 장착",
    }));
    fireEvent.click(within(
      screen.getByRole("region", { name: "장착·필수 파츠" }),
    ).getByRole("button", { name: /보조 장착대.*비어 있음/ }));

    expect(screen.getByText("0개 장착 가능")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "조준경 부품 제거" }));

    expect(screen.getByText("먼저 부위를 선택하세요")).toBeInTheDocument();
    expect(screen.queryByText("0개 장착 가능")).not.toBeInTheDocument();
  });

  it("switches a populated build to a new deep-linked weapon without blocking slot selection", async () => {
    const secondWeapon = {
      ...catalog.items[0],
      id: SECOND_WEAPON_ID,
      name: "Kalashnikov AK-74N 5.45x39 assault rifle",
      shortName: "AK-74N",
    };
    const twoWeaponCatalog = {
      ...catalog,
      weaponIds: [M4A1_ID, SECOND_WEAPON_ID],
      items: [...catalog.items, secondWeapon],
    };
    const view = render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(twoWeaponCatalog)}
      />,
    );

    await screen.findByRole("heading", { name: /Colt M4A1/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));
    fireEvent.click(screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 장착",
    }));

    view.rerender(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={SECOND_WEAPON_ID}
        loadCatalog={() => Promise.resolve(twoWeaponCatalog)}
      />,
    );
    await screen.findByRole("heading", { name: /Kalashnikov AK-74N/ });
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));

    expect(screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 장착",
    })).toBeInTheDocument();
  });

  it("shows a stable error state when the optional catalog cannot be loaded", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        loadCatalog={() => Promise.reject(new Error("catalog unavailable"))}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "무기 모딩 자료를 불러오지 못했습니다",
    );
  });

  it("shows an empty state instead of a broken workbench when no weapons are available", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        loadCatalog={() => Promise.resolve({
          schemaVersion: 1,
          dataVersion: "2026-08-26",
          weaponIds: [],
          items: [],
        })}
      />,
    );

    expect(await screen.findByText("사용 가능한 총기가 없습니다")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /조준경/ })).not.toBeInTheDocument();
  });

  it("distinguishes an unavailable catalog from a valid empty data pack", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        loadCatalog={() => Promise.resolve({
          schemaVersion: 1,
          dataVersion: "unavailable",
          weaponIds: [],
          items: [],
        })}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("무기 모딩 자료를 불러오지 못했습니다");
  });

  it("shows an empty search result without losing the modding page", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );

    const search = await screen.findByRole("searchbox", { name: "총기 검색" });
    fireEvent.change(search, { target: { value: "존재하지 않는 총기" } });

    await waitFor(() => {
      expect(screen.getByText("조건에 맞는 총기가 없습니다")).toBeInTheDocument();
    });
    expect(screen.getByRole("heading", { name: "무기 모딩" })).toBeInTheDocument();
  });

  it("shows a stable fallback when a weapon image cannot be loaded", async () => {
    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );

    const image = await screen.findByAltText(/Colt M4A1.*상점 기본 외형/);
    fireEvent.error(image);

    expect(screen.getByRole("img", { name: /상점 기본 외형 이미지 없음/ })).toBeInTheDocument();
  });

  it("restores a saved build and can reset it to the factory configuration", async () => {
    const first = render(
      <WeaponModdingPage
        activeProfile="pvp"
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );
    await screen.findByRole("searchbox", { name: "총기 검색" });
    fireEvent.click(screen.getByRole("button", { name: /Colt M4A1/ }));
    fireEvent.click(within(
      screen.getByRole("group", { name: "총기 부위 선택" }),
    ).getByRole("button", { name: /조준경/ }));
    fireEvent.click(screen.getByRole("button", {
      name: "EOTech EXPS3 holographic sight 장착",
    }));
    first.unmount();

    render(
      <WeaponModdingPage
        activeProfile="pvp"
        focusWeaponId={M4A1_ID}
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );

    expect(await screen.findByRole("button", {
      name: /조준경.*EOTech EXPS3/,
    })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "기본 구성으로 초기화" }));
    expect(screen.queryByRole("button", {
      name: /조준경.*EOTech EXPS3/,
    })).not.toBeInTheDocument();
  });
});
