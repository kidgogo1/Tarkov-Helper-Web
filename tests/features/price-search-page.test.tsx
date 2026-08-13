import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PriceSearchPage } from "../../src/features/prices/PriceSearchPage";
import type { ProfileType } from "../../src/types/data";
import type { ItemPriceCatalog, LiveItemPriceQuote } from "../../src/types/prices";
import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
} from "../../src/services/client-diagnostics";

const catalog: ItemPriceCatalog = {
  meta: {
    schemaVersion: 1,
    generatedAt: "2026-08-10T00:00:00.000Z",
    source: "https://json.tarkov.dev/endpoints",
    itemCount: 2,
    pvpQuoteCount: 2,
    pveQuoteCount: 2,
  },
  items: [
    {
      id: "5447a9cd4bdc2dbd208b4567",
      normalizedName: "colt-m4a1-556x45-assault-rifle",
      nameEn: "Colt M4A1 5.56x45 assault rifle",
      nameKo: "Colt M4A1 5.56x45 돌격소총",
      shortNameEn: "M4A1",
      shortNameKo: "M4A1",
      prices: { pvp: { lastLowPrice: 24_000, avg24hPrice: 43_360 }, pve: { lastLowPrice: 31_000 } },
    },
    {
      id: "5c0530ee86f774697952d952",
      normalizedName: "ledx-skin-transilluminator",
      nameEn: "LEDX Skin Transilluminator",
      nameKo: "LEDX 피부 트랜스일루미네이터",
      shortNameEn: "LEDX",
      shortNameKo: "LEDX",
      prices: { pvp: { lastLowPrice: 579_000 }, pve: { lastLowPrice: 700_000 } },
    },
  ],
};

describe("PriceSearchPage", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("records a deduplicated optional price catalog failure", async () => {
    clearClientDiagnostics();
    const loadCatalog = vi.fn().mockRejectedValue(new Error("catalog unavailable"));
    const first = render(<PriceSearchPage activeProfile="pvp" loadCatalog={loadCatalog} />);
    expect(await screen.findByText("catalog unavailable")).toBeInTheDocument();
    first.unmount();
    render(<PriceSearchPage activeProfile="pvp" loadCatalog={loadCatalog} />);
    expect(await screen.findByText("catalog unavailable")).toBeInTheDocument();

    expect(getClientDiagnosticSnapshot().entries).toEqual([
      expect.objectContaining({
        source: "optional-resource",
        code: "PRICE_CATALOG_LOAD_FAILED",
        level: "warning",
        count: 2,
      }),
    ]);
  });

  it("searches both Korean and English and shows the active-mode snapshot", async () => {
    render(<PriceSearchPage activeProfile="pvp" loadCatalog={() => Promise.resolve(catalog)} />);
    const search = await screen.findByRole("searchbox", { name: "아이템 시세 검색" });
    fireEvent.change(search, { target: { value: "돌격소총" } });
    fireEvent.click(screen.getByRole("button", { name: /Colt M4A1/ }));
    expect(within(screen.getByRole("article")).getByText("₽24,000")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "transilluminator" } });
    expect(screen.getByRole("button", { name: /LEDX Skin Transilluminator/ })).toBeInTheDocument();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: /LEDX Skin Transilluminator/ })).toHaveFocus();
  });

  it("uses a live quote when available and keeps the snapshot when unavailable", async () => {
    const fetchQuote = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      itemId: catalog.items[0].id,
      gameMode: "pve",
      source: "LIVE",
      fetchedAt: "2026-08-10T01:00:00.000Z",
      expiresAt: "2026-08-10T01:10:00.000Z",
      isStale: false,
      flea: { lastLowPrice: 35_000, avg24hPrice: 40_000, updatedAt: "2026-08-10T00:59:00.000Z" },
    });
    render(<PriceSearchPage activeProfile="pve" fetchQuote={fetchQuote} loadCatalog={() => Promise.resolve(catalog)} />);
    const search = await screen.findByRole("searchbox", { name: "아이템 시세 검색" });
    fireEvent.change(search, { target: { value: "M4A1" } });
    fireEvent.click(screen.getByRole("button", { name: /Colt M4A1/ }));
    await waitFor(() => expect(screen.getByText("₽35,000")).toBeInTheDocument());
    expect(screen.getByText("실시간")).toBeInTheDocument();
  });

  it("records a live quote failure without retaining the item id or raw error", async () => {
    clearClientDiagnostics();
    const request = vi.fn<typeof fetch>().mockRejectedValue(new Error(
      `${catalog.items[0].id} C:\\Users\\private-user\\quote token=${"q".repeat(43)}`,
    ));
    vi.stubGlobal("fetch", request);
    render(
      <PriceSearchPage
        activeProfile="pvp"
        loadCatalog={() => Promise.resolve(catalog)}
      />,
    );
    const search = await screen.findByRole("searchbox", { name: "아이템 시세 검색" });
    fireEvent.change(search, { target: { value: "M4A1" } });
    fireEvent.click(screen.getByRole("button", { name: /Colt M4A1/ }));
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    await waitFor(() => expect(getClientDiagnosticSnapshot().entries).toHaveLength(1));

    const snapshot = getClientDiagnosticSnapshot();
    expect(snapshot.entries[0]).toMatchObject({
      source: "optional-resource",
      code: "PRICE_QUOTE_FETCH_FAILED",
      level: "warning",
      operation: "FETCH_LIVE_QUOTE",
      count: 1,
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(catalog.items[0].id);
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("q".repeat(43));
  });

  it("keeps a late PVP response from replacing the active PVE quote", async () => {
    const resolvers = new Map<ProfileType, (value: LiveItemPriceQuote | null) => void>();
    const fetchQuote = vi.fn((_itemId: string, mode: ProfileType): Promise<LiveItemPriceQuote | null> => new Promise((resolve) => {
      resolvers.set(mode, resolve);
    }));
    const view = render(<PriceSearchPage activeProfile="pvp" fetchQuote={fetchQuote} loadCatalog={() => Promise.resolve(catalog)} />);
    const search = await screen.findByRole("searchbox", { name: "아이템 시세 검색" });
    fireEvent.change(search, { target: { value: "M4A1" } });
    fireEvent.click(screen.getByRole("button", { name: /Colt M4A1/ }));
    await waitFor(() => expect(resolvers.has("pvp")).toBe(true));

    view.rerender(<PriceSearchPage activeProfile="pve" fetchQuote={fetchQuote} loadCatalog={() => Promise.resolve(catalog)} />);
    await waitFor(() => expect(resolvers.has("pve")).toBe(true));
    resolvers.get("pve")?.({
      protocolVersion: 1,
      itemId: catalog.items[0].id,
      gameMode: "pve",
      source: "LIVE",
      fetchedAt: "2026-08-10T01:00:00.000Z",
      expiresAt: "2026-08-10T01:10:00.000Z",
      isStale: false,
      flea: { lastLowPrice: 35_000, updatedAt: "2026-08-10T00:59:00.000Z" },
    });
    await waitFor(() => expect(screen.getByText("₽35,000")).toBeInTheDocument());

    resolvers.get("pvp")?.({
      protocolVersion: 1,
      itemId: catalog.items[0].id,
      gameMode: "pvp",
      source: "LIVE",
      fetchedAt: "2026-08-10T01:00:00.000Z",
      expiresAt: "2026-08-10T01:10:00.000Z",
      isStale: false,
      flea: { lastLowPrice: 99_000, updatedAt: "2026-08-10T00:59:00.000Z" },
    });
    await waitFor(() => expect(screen.queryByText("₽99,000")).not.toBeInTheDocument());
    expect(screen.getByText("₽35,000")).toBeInTheDocument();
  });

  it("announces a static fallback and an empty search without failing the page", async () => {
    render(<PriceSearchPage activeProfile="pvp" fetchQuote={() => Promise.resolve(null)} loadCatalog={() => Promise.resolve(catalog)} />);
    const search = await screen.findByRole("searchbox", { name: "아이템 시세 검색" });
    fireEvent.change(search, { target: { value: "없는 물건" } });
    expect(screen.getByText("검색 결과가 없습니다.")).toBeInTheDocument();

    fireEvent.change(search, { target: { value: "LEDX" } });
    fireEvent.click(screen.getByRole("button", { name: /LEDX Skin/ }));
    await waitFor(() => expect(screen.getByText(/번들 시세를 표시합니다/)).toBeInTheDocument());
    expect(within(screen.getByRole("article")).getByText("₽579,000")).toBeInTheDocument();
  });
});
