import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";

import {
  QuestOverlay,
  type QuestOverlayHandle,
} from "../../src/features/overlay/QuestOverlay";
import type { QuestData } from "../../src/types/data";
import { createDefaultState } from "../../src/app/store";

const trackedQuest: QuestData = {
  id: "quest-water",
  normalizedName: "operation-aquarius",
  name: "Operation Aquarius",
  nameEn: "Operation Aquarius",
  nameKo: "물병자리 작전",
  trader: "Therapist",
  locations: ["Customs"],
  kappaRequired: false,
  requirements: [],
  alternativeQuestIds: [],
  followUpQuestIds: [],
  objectives: [
    {
      id: "objective-water",
      sortOrder: 0,
      objectiveType: "visit",
      description: "기숙사에서 물 찾기",
      requiresFir: false,
      mapName: "Customs",
      locationPoints: [],
      optionalPoints: [],
    },
    {
      id: "objective-extract",
      sortOrder: 1,
      objectiveType: "extract",
      description: "세관에서 탈출하기",
      requiresFir: false,
      mapName: "Customs",
      locationPoints: [],
      optionalPoints: [],
    },
  ],
  requiredItems: [],
};

const untrackedQuest: QuestData = {
  ...trackedQuest,
  id: "quest-hidden",
  normalizedName: "hidden-quest",
  name: "Hidden Quest",
  nameEn: "Hidden Quest",
  nameKo: "표시하지 않은 퀘스트",
  objectives: [],
};

function OverlayHarness({ openPopup }: { openPopup: () => Window | null }) {
  const profile = createDefaultState().profiles.pvp;
  profile.trackedQuestIds = [trackedQuest.id];
  profile.objectiveProgress["objective-extract"] = true;
  const overlayRef = createRef<QuestOverlayHandle>();

  return (
    <>
      <button onClick={() => overlayRef.current?.toggle()} type="button">
        퀘스트 창 토글
      </button>
      <QuestOverlay
        activeProfile="pvp"
        onObjectiveChange={vi.fn()}
        onQuestTrackedChange={vi.fn()}
        openPopup={openPopup}
        profile={profile}
        quests={[trackedQuest, untrackedQuest]}
        ref={overlayRef}
      />
    </>
  );
}

describe("QuestOverlay", () => {
  it("falls back to a docked panel and shows only the chosen quest titles and objectives", () => {
    render(<OverlayHarness openPopup={() => null} />);

    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    const overlay = screen.getByRole("complementary", { name: "퀘스트 창" });
    expect(overlay).toHaveAttribute("data-presentation", "dock");
    expect(within(overlay).getByRole("heading", { name: "물병자리 작전" })).toBeInTheDocument();
    expect(within(overlay).getByText("기숙사에서 물 찾기")).toBeInTheDocument();
    expect(within(overlay).getByText("세관에서 탈출하기")).toBeInTheDocument();
    expect(within(overlay).getByRole("checkbox", { name: "세관에서 탈출하기" })).toBeChecked();
    expect(within(overlay).queryByText("표시하지 않은 퀘스트")).not.toBeInTheDocument();
    expect(within(overlay).getByText("1 / 2 완료")).toBeInTheDocument();
  });

  it("opens a same-origin popup without replacing the mini-map PiP and closes cleanly", async () => {
    const popupDocument = document.implementation.createHTMLDocument("");
    const pageHideListeners = new Set<EventListener>();
    const close = vi.fn();
    const focus = vi.fn();
    const popupWindow = {
      closed: false,
      close,
      document: popupDocument,
      focus,
      addEventListener: (type: string, listener: EventListener) => {
        if (type === "pagehide") pageHideListeners.add(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        if (type === "pagehide") pageHideListeners.delete(listener);
      },
    } as unknown as Window;

    render(
      <StrictMode>
        <OverlayHarness openPopup={() => popupWindow} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));

    await waitFor(() => {
      expect(popupDocument.body.textContent).toContain("물병자리 작전");
    });
    expect(screen.queryByRole("complementary", { name: "퀘스트 창" })).not.toBeInTheDocument();
    expect(popupDocument.title).toBe("타르코프 헬퍼 퀘스트 창");

    for (const listener of pageHideListeners) listener(new Event("pagehide"));
    await waitFor(() => {
      expect(pageHideListeners.size).toBe(0);
    });
    expect(close).not.toHaveBeenCalled();
  });
});
