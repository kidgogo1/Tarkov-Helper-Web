import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createRef, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { recordClientDiagnostic } = vi.hoisted(() => ({
  recordClientDiagnostic: vi.fn(),
}));

vi.mock("../../src/services/client-diagnostics", () => ({ recordClientDiagnostic }));

import {
  QuestOverlay,
  type QuestOverlayHandle,
} from "../../src/features/overlay/QuestOverlay";
import type { QuestData } from "../../src/types/data";
import { createDefaultState } from "../../src/app/store";
import type { SavedQuestStatus } from "../../src/types/state";

const mapConfigs = [{
  key: "Customs",
  displayName: "Customs",
  svgFileName: "customs.svg",
  imageWidth: 1000,
  imageHeight: 1000,
  aliases: ["bigmap"],
  floors: [{ layerId: "main", displayName: "지상", order: 0, isDefault: true }],
}];
const mapFloorLocations: [] = [];

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
      locationPoints: [{ x: 100, y: 1, z: 200 }],
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

const nativeV2Session = {
  protocolVersion: 2,
  capability: "WINDOWS_MULTI_OVERLAY",
  token: "t".repeat(43),
  windowTitles: {
    minimap: "Tarkov Helper Web",
    questList: "Tarkov Helper Quest List",
  },
  sizeLimits: {
    minWidth: 240,
    minHeight: 240,
    maxWidth: 1000,
    maxHeight: 1000,
  },
} as const;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function OverlayHarness({
  nativeRequest,
  openPopup,
  questStatus,
}: {
  nativeRequest?: typeof fetch;
  openPopup: () => Window | null;
  questStatus?: SavedQuestStatus;
}) {
  const profile = createDefaultState().profiles.pvp;
  profile.trackedQuestIds = [trackedQuest.id];
  profile.objectiveProgress["objective-extract"] = true;
  if (questStatus) profile.questProgress[trackedQuest.id] = questStatus;
  const overlayRef = createRef<QuestOverlayHandle>();

  return (
    <>
      <button onClick={() => overlayRef.current?.toggle()} type="button">
        퀘스트 창 토글
      </button>
      <QuestOverlay
        activeProfile="pvp"
        onObjectiveChange={vi.fn()}
        onQuestMapRouteChange={vi.fn()}
        onQuestTrackedChange={vi.fn()}
        nativeRequest={nativeRequest}
        openPopup={openPopup}
        profile={profile}
        mapConfigs={mapConfigs}
        mapFloorLocations={mapFloorLocations}
        quests={[trackedQuest, untrackedQuest]}
        ref={overlayRef}
      />
    </>
  );
}

describe("QuestOverlay", () => {
  beforeEach(() => {
    recordClientDiagnostic.mockClear();
  });

  afterEach(() => {
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: undefined,
    });
  });

  it("falls back to a focused dock, closes with Escape, and restores the opener", async () => {
    render(<OverlayHarness openPopup={() => null} />);

    const opener = screen.getByRole("button", { name: "퀘스트 창 토글" });
    opener.focus();
    fireEvent.click(opener);
    const overlay = await screen.findByRole("complementary", { name: "퀘스트 창" });
    expect(overlay).toHaveAttribute("data-presentation", "dock");
    await waitFor(() => expect(overlay).toHaveFocus());
    expect(within(overlay).getByRole("heading", { name: "물병자리 작전" })).toBeInTheDocument();
    expect(within(overlay).getByText("기숙사에서 물 찾기")).toBeInTheDocument();
    expect(within(overlay).getByText("세관에서 탈출하기")).toBeInTheDocument();
    expect(within(overlay).getByRole("checkbox", { name: "세관에서 탈출하기" })).toBeChecked();
    expect(within(overlay).queryByText("표시하지 않은 퀘스트")).not.toBeInTheDocument();
    expect(within(overlay).getByText("1 / 2 완료")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("complementary", { name: "퀘스트 창" }))
      .not.toBeInTheDocument();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(recordClientDiagnostic).not.toHaveBeenCalled();
  });

  it("labels an imported active quest as in progress", async () => {
    render(<OverlayHarness openPopup={() => null} questStatus="active" />);

    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    const overlay = await screen.findByRole("complementary", { name: "퀘스트 창" });

    expect(within(overlay).getByText("진행 중")).toBeVisible();
    expect(within(overlay).queryByText("실패")).not.toBeInTheDocument();
  });

  it("records a privacy-safe warning when popup setup throws before the portal is ready", async () => {
    const opaqueNonce = "n".repeat(43);
    render(
      <OverlayHarness
        openPopup={() => {
          throw new Error(`windowNonce=${opaqueNonce} at C:\\Users\\Alice\\private`);
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    await screen.findByRole("complementary", { name: "퀘스트 창" });

    expect(recordClientDiagnostic).toHaveBeenCalledOnce();
    const diagnostic = recordClientDiagnostic.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({
      code: "QUEST_OVERLAY_POPUP_FAILED",
      level: "warning",
      operation: "quest-popup",
      source: "optional-resource",
    });
    expect(diagnostic.message).not.toContain(opaqueNonce);
    expect(diagnostic.operation).not.toContain(opaqueNonce);
    expect(diagnostic.error).toBeInstanceOf(Error);
    expect(diagnostic).not.toHaveProperty("windowNonce");
  });

  it("offers a separate map-route checkbox beside each tracked quest title", async () => {
    const onQuestMapRouteChange = vi.fn();
    const profile = createDefaultState().profiles.pvp;
    profile.trackedQuestIds = [trackedQuest.id];

    const overlayRef = createRef<QuestOverlayHandle>();
    render(
      <>
        <button onClick={() => overlayRef.current?.toggle()} type="button">경로 창 열기</button>
        <QuestOverlay
          activeProfile="pvp"
          onObjectiveChange={vi.fn()}
          onQuestMapRouteChange={onQuestMapRouteChange}
          onQuestTrackedChange={vi.fn()}
          openPopup={() => null}
          profile={profile}
          mapConfigs={mapConfigs}
          mapFloorLocations={mapFloorLocations}
          quests={[trackedQuest]}
          ref={overlayRef}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "경로 창 열기" }));

    const routeToggle = await screen.findByRole("checkbox", {
      name: "물병자리 작전 지도 경로 표시",
    });
    expect(routeToggle).not.toBeChecked();
    fireEvent.click(routeToggle);
    expect(onQuestMapRouteChange).toHaveBeenCalledWith(
      trackedQuest.id,
      true,
      [trackedQuest.id],
    );
  });

  it("explains and disables map routing when a tracked quest has no safe coordinates", async () => {
    const onQuestMapRouteChange = vi.fn();
    const coordinateLessQuest: QuestData = {
      ...trackedQuest,
      id: "quest-without-coordinates",
      nameKo: "좌표 없는 퀘스트",
      objectives: trackedQuest.objectives.map((objective) => ({
        ...objective,
        locationPoints: [],
        optionalPoints: [],
      })),
    };
    const profile = createDefaultState().profiles.pvp;
    profile.trackedQuestIds = [coordinateLessQuest.id];
    const overlayRef = createRef<QuestOverlayHandle>();

    render(
      <>
        <button onClick={() => overlayRef.current?.toggle()} type="button">좌표 창 열기</button>
        <QuestOverlay
          activeProfile="pvp"
          onObjectiveChange={vi.fn()}
          onQuestMapRouteChange={onQuestMapRouteChange}
          onQuestTrackedChange={vi.fn()}
          openPopup={() => null}
          profile={profile}
          mapConfigs={mapConfigs}
          mapFloorLocations={mapFloorLocations}
          quests={[coordinateLessQuest]}
          ref={overlayRef}
        />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "좌표 창 열기" }));

    const routeToggle = await screen.findByRole("checkbox", {
      name: /^좌표 없는 퀘스트 지도 경로 표시/,
    });
    expect(routeToggle).toBeDisabled();
    expect(routeToggle.closest("label")).toHaveTextContent("좌표 없음");
    fireEvent.click(routeToggle);
    expect(onQuestMapRouteChange).not.toHaveBeenCalled();
  });

  it("opens a same-origin popup without replacing the mini-map PiP and closes cleanly", async () => {
    const popupDocument = document.implementation.createHTMLDocument("");
    const pageHideListeners = new Set<EventListener>();
    const close = vi.fn();
    const focus = vi.fn();
    let closed = false;
    const popupWindow = {
      get closed() {
        return closed;
      },
      close: () => {
        closed = true;
        close();
      },
      document: popupDocument,
      focus,
      addEventListener: (type: string, listener: EventListener) => {
        if (type === "pagehide") pageHideListeners.add(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        if (type === "pagehide") pageHideListeners.delete(listener);
      },
    } as unknown as Window;
    const requestWindow = vi.fn();
    const closeMiniMap = vi.fn();
    Object.defineProperty(window, "documentPictureInPicture", {
      configurable: true,
      value: {
        window: { close: closeMiniMap },
        requestWindow,
      },
    });

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
    expect(popupDocument.title).toBe("Tarkov Helper Quest List");
    expect(popupDocument.body.textContent).toContain(
      "일반 브라우저 창입니다 · 항상 위 기능은 바로 실행 버전에서 지원됩니다.",
    );
    expect(requestWindow).not.toHaveBeenCalled();
    expect(closeMiniMap).not.toHaveBeenCalled();

    for (const listener of pageHideListeners) listener(new Event("pagehide"));
    await waitFor(() => {
      expect(pageHideListeners.size).toBe(0);
    });
    expect(close).not.toHaveBeenCalled();
  });

  it("turns the Direct popup into an independent always-on-top quest overlay", async () => {
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
    const order: string[] = [];
    let resolveClaim!: (response: Response) => void;
    const claimResponse = new Promise<Response>((resolve) => {
      resolveClaim = resolve;
    });
    const attachment = {
      protocolVersion: 2,
      overlayKind: "quest-list",
      overlayId: "o".repeat(43),
      state: "ATTACHED",
      mode: "UNLOCKED",
      globalHotkeysAvailable: false,
      bounds: { left: 20, top: 40, width: 430, height: 680 },
    } as const;
    const nativeRequest = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path.endsWith("/session")) return jsonResponse(nativeV2Session);
      if (path.endsWith("/claims")) {
        order.push("CLAIM");
        return claimResponse;
      }
      if (path.endsWith("/windows") && method === "POST") {
        order.push("ATTACH");
        return jsonResponse(attachment, 201);
      }
      if (path.endsWith("/windows") && method === "DELETE") {
        order.push("DETACH");
        return new Promise<Response>(() => undefined);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(
      <OverlayHarness
        nativeRequest={nativeRequest}
        openPopup={() => {
          order.push("OPEN");
          return popupWindow;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    expect(order).toEqual(["OPEN"]);
    expect(popupDocument.title).toMatch(
      /^Tarkov Helper Quest List \[[A-Za-z0-9_-]{43}\]$/,
    );
    await waitFor(() => expect(nativeRequest).toHaveBeenCalledWith(
      "/api/v2/native-overlay/session",
      expect.any(Object),
    ));
    await waitFor(() => expect(order).toEqual(["OPEN", "CLAIM"]));
    const claimBody = JSON.parse(
      nativeRequest.mock.calls.find(([input]) => String(input).endsWith("/claims"))?.[1]
        ?.body as string,
    );
    expect(claimBody).toEqual({
      overlayKind: "quest-list",
      windowNonce: popupDocument.title.slice(-44, -1),
    });
    resolveClaim(jsonResponse({
      protocolVersion: 2,
      overlayKind: "quest-list",
      claimId: "c".repeat(43),
      expiresAt: "2026-08-13T12:00:15.000Z",
    }, 201));
    await waitFor(() => expect(order).toEqual(["OPEN", "CLAIM", "ATTACH"]));
    expect(popupDocument.title).toBe("Tarkov Helper Quest List");
    expect(popupDocument.body.textContent).toContain("화면 위에 표시됨 · 이동 가능");
    expect(popupDocument.body.textContent).toContain("물병자리 작전");

    popupDocument.dispatchEvent(new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    await waitFor(() => expect(order.at(-1)).toBe("DETACH"));
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
    expect(pageHideListeners.size).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    expect(order.filter((entry) => entry === "OPEN")).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps a usable regular popup when native window matching fails closed", async () => {
    const popupDocument = document.implementation.createHTMLDocument("");
    const close = vi.fn();
    const popupWindow = {
      closed: false,
      close,
      document: popupDocument,
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const nativeRequest = vi.fn<typeof fetch>(async (input, init) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path.endsWith("/session")) return jsonResponse(nativeV2Session);
      if (path.endsWith("/claims")) {
        return jsonResponse({
          protocolVersion: 2,
          overlayKind: "quest-list",
          claimId: "c".repeat(43),
          expiresAt: "2026-08-13T12:00:15.000Z",
        }, 201);
      }
      if (path.endsWith("/windows") && method === "POST") {
        return jsonResponse({
          error: {
            code: "AMBIGUOUS_WINDOW",
            message: "untrusted native detail",
          },
        }, 409);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    });

    render(<OverlayHarness nativeRequest={nativeRequest} openPopup={() => popupWindow} />);
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    await waitFor(() => expect(nativeRequest).toHaveBeenCalledWith(
      "/api/v2/native-overlay/session",
      expect.any(Object),
    ));

    await waitFor(() => expect(popupDocument.body.textContent).toContain(
      "화면 위 연결을 사용할 수 없어 일반 퀘스트 창으로 열었습니다.",
    ));
    expect(popupDocument.body.textContent).toContain("물병자리 작전");
    expect(close).not.toHaveBeenCalled();
    expect(nativeRequest.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    expect(recordClientDiagnostic.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        code: "QUEST_OVERLAY_ATTACH_FAILED",
        level: "warning",
        operation: "quest-native-attach",
        source: "optional-resource",
      }),
    ]);

    popupDocument.querySelector<HTMLButtonElement>(
      'button[aria-label="퀘스트 창 닫기"]',
    )?.click();
    await waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("records an active native claim failure but not an unsupported session", async () => {
    const popupDocument = document.implementation.createHTMLDocument("");
    const popupWindow = {
      closed: false,
      close: vi.fn(),
      document: popupDocument,
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const nativeRequest = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/session")) return jsonResponse(nativeV2Session);
      if (String(input).endsWith("/claims")) {
        return jsonResponse({ error: { code: "NATIVE_FAILURE", message: "private body" } }, 500);
      }
      return jsonResponse({}, 404);
    });

    const { unmount } = render(
      <OverlayHarness nativeRequest={nativeRequest} openPopup={() => popupWindow} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    await waitFor(() => expect(popupDocument.body.textContent).toContain(
      "화면 위 연결을 사용할 수 없어 일반 퀘스트 창으로 열었습니다.",
    ));

    expect(recordClientDiagnostic.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        code: "QUEST_OVERLAY_CLAIM_FAILED",
        level: "warning",
        operation: "quest-native-claim",
        source: "optional-resource",
      }),
    ]);
    expect(recordClientDiagnostic.mock.calls[0]?.[0]?.message).not.toContain("private body");

    unmount();
    recordClientDiagnostic.mockClear();
    const unsupportedDocument = document.implementation.createHTMLDocument("");
    const unsupportedWindow = {
      closed: false,
      close: vi.fn(),
      document: unsupportedDocument,
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    render(
      <OverlayHarness
        nativeRequest={vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 404))}
        openPopup={() => unsupportedWindow}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    await waitFor(() => expect(unsupportedDocument.body.textContent).toContain(
      "일반 브라우저 창입니다",
    ));
    expect(recordClientDiagnostic).not.toHaveBeenCalled();
  });

  it("records an actionable native session failure before using the regular popup", async () => {
    const popupDocument = document.implementation.createHTMLDocument("");
    const popupWindow = {
      closed: false,
      close: vi.fn(),
      document: popupDocument,
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const nativeRequest = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 500));

    render(<OverlayHarness nativeRequest={nativeRequest} openPopup={() => popupWindow} />);
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    await waitFor(() => expect(popupDocument.body.textContent).toContain(
      "일반 브라우저 창입니다",
    ));

    expect(recordClientDiagnostic.mock.calls.map(([entry]) => entry)).toEqual([
      expect.objectContaining({
        code: "QUEST_OVERLAY_SESSION_FAILED",
        level: "warning",
        operation: "quest-native-session",
        source: "optional-resource",
      }),
    ]);
  });

  it("opens synchronously and cleans up the native quest window when its opener unloads", async () => {
    const popupDocument = document.implementation.createHTMLDocument("");
    const close = vi.fn();
    const popupWindow = {
      closed: false,
      close,
      document: popupDocument,
      focus: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    let resolveSession!: (response: Response) => void;
    const sessionResponse = new Promise<Response>((resolve) => {
      resolveSession = resolve;
    });
    const nativeRequest = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith("/session")) return sessionResponse;
      return jsonResponse({ error: "unexpected" }, 500);
    });
    const openPopup = vi.fn(() => popupWindow);

    render(
      <OverlayHarness nativeRequest={nativeRequest} openPopup={openPopup} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));

    expect(openPopup).toHaveBeenCalledOnce();
    expect(popupDocument.body.textContent).toContain("물병자리 작전");
    window.dispatchEvent(new Event("pagehide"));
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("complementary", { name: "퀘스트 창" }))
      .not.toBeInTheDocument();
    resolveSession(jsonResponse(nativeV2Session));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nativeRequest.mock.calls.some(([input]) => String(input).endsWith("/claims")))
      .toBe(false);
    expect(recordClientDiagnostic).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pageshow"));
    fireEvent.click(screen.getByRole("button", { name: "퀘스트 창 토글" }));
    expect(openPopup).toHaveBeenCalledTimes(2);
  });
});
