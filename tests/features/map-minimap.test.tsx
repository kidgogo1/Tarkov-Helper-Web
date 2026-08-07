import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppStoreProvider } from "../../src/app/store";
import {
  MapMiniMap,
  type MapMiniMapPlayer,
} from "../../src/features/map/MapMiniMap";
import type { MapConfig } from "../../src/types/data";

const config: MapConfig = {
  key: "Customs",
  displayName: "Customs",
  svgFileName: "Customs.svg",
  imageWidth: 1000,
  imageHeight: 800,
  aliases: ["bigmap"],
  floors: [
    { layerId: "main", displayName: "Ground Floor", order: 0, isDefault: true },
    { layerId: "level2", displayName: "Second Floor", order: 1, isDefault: false },
  ],
};

const player: MapMiniMapPlayer = {
  screen: { x: 100, y: 200 },
  angle: 42,
};

function StoreWrapper({ children }: PropsWithChildren) {
  return <AppStoreProvider>{children}</AppStoreProvider>;
}

function renderMiniMap(currentPlayer: MapMiniMapPlayer | undefined = player) {
  return render(
    <MapMiniMap
      config={config}
      orderedFloors={config.floors}
      player={currentPlayer}
      playerMarkerSize={18}
      selectedFloor="main"
    />,
    { wrapper: StoreWrapper },
  );
}

interface FakePictureInPictureWindow {
  document: Document;
  close: ReturnType<typeof vi.fn>;
  dispatchPageHide: () => void;
  dispatchResize: (width: number, height: number) => void;
}

function createPictureInPictureWindow(
  initialSize = { width: 300, height: 300 },
): FakePictureInPictureWindow {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const pipDocument = frame.contentDocument;
  if (!pipDocument) throw new Error("PiP test document was not created");
  const listeners = new Map<string, Set<EventListener>>();
  const pipWindow = {
    document: pipDocument,
    innerWidth: initialSize.width,
    innerHeight: initialSize.height,
    close: vi.fn(() => frame.remove()),
    dispatchPageHide: () => {
      const event = new Event("pagehide");
      listeners.get("pagehide")?.forEach((listener) => listener(event));
    },
    dispatchResize: (width: number, height: number) => {
      pipWindow.innerWidth = width;
      pipWindow.innerHeight = height;
      const event = new Event("resize");
      listeners.get("resize")?.forEach((listener) => listener(event));
    },
    addEventListener: ((type: string, listener: EventListener) => {
      const typeListeners = listeners.get(type) ?? new Set<EventListener>();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    }) as Window["addEventListener"],
    removeEventListener: ((type: string, listener: EventListener) => {
      listeners.get(type)?.delete(listener);
    }) as Window["removeEventListener"],
  };
  return pipWindow as FakePictureInPictureWindow &
    Pick<Window, "addEventListener" | "removeEventListener" | "innerWidth" | "innerHeight">;
}

function setPictureInPictureController(
  controller: { requestWindow: ReturnType<typeof vi.fn> } | undefined,
) {
  Object.defineProperty(window, "documentPictureInPicture", {
    configurable: true,
    value: controller,
  });
}

describe("MapMiniMap", () => {
  beforeEach(() => {
    window.localStorage.clear();
    setPictureInPictureController(undefined);
  });

  afterEach(() => {
    setPictureInPictureController(undefined);
  });

  it("fills and tracks the resizable Picture-in-Picture viewport while copying stylesheet links", async () => {
    const pipWindow = createPictureInPictureWindow({ width: 640, height: 360 });
    const requestWindow = vi.fn().mockResolvedValue(pipWindow as unknown as Window);
    setPictureInPictureController({ requestWindow });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/assets/app.css";
    document.head.append(stylesheet);

    const view = renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    await waitFor(() => expect(requestWindow).toHaveBeenCalledWith({ width: 300, height: 300 }));
    const pipDialog = within(pipWindow.document.body).getByRole("dialog", { name: "Customs 미니맵" });
    expect(pipDialog).toHaveClass("map-minimap--pip");
    const pipWorld = within(pipWindow.document.body).getByTestId("map-minimap-world");
    expect(pipWorld.style.transform).toBe("translate(275px, 90px) scale(0.45)");

    act(() => pipWindow.dispatchResize(400, 400));
    await waitFor(() => {
      expect(pipWorld.style.transform).toBe("translate(160px, 120px) scale(0.4)");
    });
    expect(pipWindow.document.head.querySelector('link[rel="stylesheet"]')).toHaveAttribute(
      "href",
      stylesheet.href,
    );
    expect(screen.queryByTestId("map-minimap-fallback")).not.toBeInTheDocument();

    view.unmount();
    expect(pipWindow.close).toHaveBeenCalledTimes(1);
    stylesheet.remove();
  });

  it("still opens after React Strict Mode replays mount effects", async () => {
    const pipWindow = createPictureInPictureWindow();
    const requestWindow = vi.fn().mockResolvedValue(pipWindow as unknown as Window);
    setPictureInPictureController({ requestWindow });

    render(
      <StrictMode>
        <AppStoreProvider>
          <MapMiniMap
            config={config}
            orderedFloors={config.floors}
            player={player}
            playerMarkerSize={18}
            selectedFloor="main"
          />
        </AppStoreProvider>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(
      await within(pipWindow.document.body).findByRole("dialog", {
        name: "Customs 미니맵",
      }),
    ).toBeInTheDocument();
    expect(pipWindow.close).not.toHaveBeenCalled();
  });

  it("uses an in-page fixed fallback when Document Picture-in-Picture is unsupported or rejected", async () => {
    const requestWindow = vi.fn().mockRejectedValue(new Error("denied"));
    setPictureInPictureController({ requestWindow });
    renderMiniMap();

    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(await screen.findByTestId("map-minimap-fallback")).toBeInTheDocument();
    expect(screen.getByText(/페이지 안 미니맵으로 열었습니다/)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveClass("map-minimap--fallback");
    expect(screen.getByTestId("map-minimap-world").style.transform).toBe(
      "translate(120px, 90px) scale(0.3)",
    );
  });

  it("follows position updates in tracking mode but keeps the map fixed in fixed mode", async () => {
    const view = renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await screen.findByTestId("map-minimap-world");
    const trackingTransform = world.style.transform;

    view.rerender(
      <MapMiniMap
        config={config}
        orderedFloors={config.floors}
        player={{ screen: { x: 700, y: 600 }, angle: 90 }}
        playerMarkerSize={18}
        selectedFloor="main"
      />,
    );
    expect(world.style.transform).not.toBe(trackingTransform);

    fireEvent.click(screen.getByRole("button", { name: "고정 뷰로 전환" }));
    const fixedTransform = world.style.transform;
    view.rerender(
      <MapMiniMap
        config={config}
        orderedFloors={config.floors}
        player={{ screen: { x: 250, y: 300 }, angle: 180 }}
        playerMarkerSize={18}
        selectedFloor="main"
      />,
    );
    expect(world).toHaveAttribute("data-view-mode", "fixed");
    expect(world.style.transform).toBe(fixedTransform);
  });

  it("pans fixed view with a middle-button pointer drag, ignores offsets while tracking, and resets the saved offset", async () => {
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await screen.findByTestId("map-minimap-world");
    const stage = screen.getByTestId("map-minimap-stage");
    const trackingTransform = world.style.transform;

    fireEvent.click(screen.getByRole("button", { name: "고정 뷰로 전환" }));
    const centeredFixedTransform = world.style.transform;
    fireEvent.pointerDown(stage, {
      button: 1,
      buttons: 4,
      clientX: 40,
      clientY: 50,
      pointerId: 7,
    });
    fireEvent.pointerMove(stage, {
      buttons: 4,
      clientX: 100,
      clientY: 90,
      pointerId: 7,
    });
    fireEvent.pointerUp(stage, { button: 1, pointerId: 7 });
    expect(world.style.transform).not.toBe(centeredFixedTransform);

    fireEvent.click(screen.getByRole("button", { name: "플레이어 추적 뷰로 전환" }));
    expect(world.style.transform).toBe(trackingTransform);

    fireEvent.click(screen.getByRole("button", { name: "고정 뷰로 전환" }));
    expect(world.style.transform).not.toBe(centeredFixedTransform);
    fireEvent.click(screen.getByRole("button", { name: "미니맵 위치 초기화" }));
    expect(world.style.transform).toBe(centeredFixedTransform);
  });

  it("keeps at least one quarter of the map visible after an extreme fixed-view pan", async () => {
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "고정 뷰로 전환" }));
    const world = await screen.findByTestId("map-minimap-world");
    const stage = screen.getByTestId("map-minimap-stage");

    fireEvent.pointerDown(stage, {
      button: 1,
      buttons: 4,
      clientX: 0,
      clientY: 0,
      pointerId: 8,
    });
    fireEvent.pointerMove(stage, {
      buttons: 4,
      clientX: 5_000,
      clientY: 5_000,
      pointerId: 8,
    });

    expect(world.style.transform).toBe("translate(225px, 225px) scale(0.3)");
  });

  it("renders only the current map and live player marker with the parsed direction", async () => {
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    const mapObject = await screen.findByRole("img", { name: "Customs 미니맵 지도" });
    const mapUrl = new URL(mapObject.getAttribute("data") ?? "", window.location.href);
    expect(mapUrl.origin).toBe(window.location.origin);
    expect(mapUrl.pathname).toContain("/assets/maps/Customs.svg");
    expect(screen.getByTestId("map-minimap-player")).toHaveStyle({
      "--mini-map-player-angle": "42deg",
    });
    expect(screen.queryByTestId("player-trail")).not.toBeInTheDocument();
    expect(screen.queryByText(/퀘스트|탈출구/)).not.toBeInTheDocument();
    expect(screen.getByText(/클릭 투과와 전역 단축키는 브라우저에서 지원하지 않습니다/)).toBeInTheDocument();
  });
});
