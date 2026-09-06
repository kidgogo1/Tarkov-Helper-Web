import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

import { App } from "../../src/app/App";
import { AppStoreProvider } from "../../src/app/store";
import type { TarkovData } from "../../src/types/data";
import bundleText from "../../public/data/tarkov-data.json?raw";

const dataMocks = vi.hoisted(() => ({ loadTarkovData: vi.fn() }));
vi.mock("../../src/app/data", () => ({ loadTarkovData: dataMocks.loadTarkovData }));

const bundle = JSON.parse(bundleText) as TarkovData;

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "#/quests");
  dataMocks.loadTarkovData.mockResolvedValue(bundle);
});

it("finds the reported bundled quests through the menu before and after switching profiles", async () => {
  render(<AppStoreProvider><App /></AppStoreProvider>);
  await screen.findByRole("searchbox", { name: "퀘스트 검색" });

  for (const profileName of ["PVP 프로필", "PVE 프로필"]) {
    fireEvent.click(screen.getByRole("button", { name: profileName }));
    for (const [query, name] of [
      ["사냥꾼의 길 - 구역 확보", "사냥꾼의 길 - 구역 확보"],
      ["구역확보", "사냥꾼의 길 - 구역 확보"],
      ["Forester's Duty", "Forester's Duty"],
      ["Forester’s Duty", "Forester's Duty"],
      ["Foresters Duty", "Forester's Duty"],
    ]) {
      fireEvent.change(screen.getByRole("searchbox", { name: "퀘스트 검색" }), {
        target: { value: query },
      });
      expect(within(screen.getByRole("region", { name: "퀘스트 목록" }))
        .getByText(name, { selector: "strong" })).toBeVisible();
    }
  }
}, 20000);
