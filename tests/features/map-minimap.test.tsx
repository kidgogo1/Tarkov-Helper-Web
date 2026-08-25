import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { APP_STATE_STORAGE_KEY, AppStoreProvider, createDefaultState } from "../../src/app/store";
import {
  MapMiniMap,
  type MapMiniMapLegendItem,
  type MapMiniMapMarker,
  type MapMiniMapPlayer,
  type MapMiniMapRoute,
} from "../../src/features/map/MapMiniMap";
import {
  clearClientDiagnostics,
  getClientDiagnosticSnapshot,
} from "../../src/services/client-diagnostics";
import type { MapConfig } from "../../src/types/data";
import type { MapDisplaySettings } from "../../src/types/state";

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

function renderMiniMap(
  currentPlayer: MapMiniMapPlayer | undefined = player,
  markers: readonly MapMiniMapMarker[] = [],
  markerLegend: readonly MapMiniMapLegendItem[] = [],
  routes: readonly MapMiniMapRoute[] = [],
) {
  return render(
    <MapMiniMap
      config={config}
      markerLegend={markerLegend}
      markers={markers}
      routes={routes}
      orderedFloors={config.floors}
      player={currentPlayer}
      playerMarkerSize={18}
      selectedFloor="main"
    />,
    { wrapper: StoreWrapper },
  );
}

function persistMapSettings(patch: Partial<MapDisplaySettings>) {
  const state = createDefaultState();
  Object.assign(state.settings.map, patch);
  window.localStorage.setItem(APP_STATE_STORAGE_KEY, JSON.stringify(state));
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

const nativeSessionPayload = {
  protocolVersion: 1,
  capability: "WINDOWS_DOCUMENT_PIP",
  token: "t".repeat(43),
  windowTitle: "Tarkov Helper Web",
  sizeLimits: {
    minWidth: 240,
    minHeight: 240,
    maxWidth: 1000,
    maxHeight: 1000,
  },
} as const;

const nativeClaimId = "c".repeat(43);
const nativeOverlayId = "o".repeat(43);

function nativeAttachment(
  mode: "UNLOCKED" | "LOCKED" | "CLICK_THROUGH",
  globalHotkeysAvailable = true,
) {
  return {
    protocolVersion: 1,
    overlayId: nativeOverlayId,
    state: "ATTACHED",
    mode,
    globalHotkeysAvailable,
    bounds: mode === "LOCKED"
      ? { left: 80, top: 60, width: 300, height: 300 }
      : { left: 80, top: 60, width: 1200, height: 720 },
  } as const;
}

function createNativeOverlayApi(options: {
  claimResponse?: Promise<Response>;
  eventBatches?: unknown[];
  failAttach?: boolean;
  globalHotkeysAvailable?: boolean;
  loseOverlayAfterLock?: boolean;
} = {}) {
  const order: string[] = [];
  const eventSignals: AbortSignal[] = [];
  const eventBatches = [...(options.eventBatches ?? [])];
  let patchCount = 0;
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path.endsWith("/api/v1/native-overlay/session") && method === "GET") {
      order.push("SESSION");
      return jsonResponse(nativeSessionPayload);
    }
    if (path.endsWith("/api/v1/native-overlay/claims") && method === "POST") {
      order.push("CLAIM");
      if (options.claimResponse) return options.claimResponse;
      return jsonResponse({
        protocolVersion: 1,
        claimId: nativeClaimId,
        expiresAt: "2026-08-08T12:00:15.000Z",
      }, 201);
    }
    if (path.endsWith("/api/v1/native-overlay/minimap") && method === "POST") {
      order.push("ATTACH");
      if (options.failAttach) {
        return jsonResponse({
          error: {
            code: "WINDOW_NOT_FOUND",
            message: "internal native detail",
          },
        }, 409);
      }
      return jsonResponse(nativeAttachment(
        "UNLOCKED",
        options.globalHotkeysAvailable,
      ), 201);
    }
    if (path.endsWith("/api/v1/native-overlay/minimap") && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as { mode: "UNLOCKED" | "LOCKED" | "CLICK_THROUGH" };
      order.push(`PATCH_${body.mode}`);
      patchCount += 1;
      if (options.loseOverlayAfterLock && patchCount > 1) {
        return jsonResponse({
          error: {
            code: "OVERLAY_NOT_FOUND",
            message: "gone",
          },
        }, 404);
      }
      return jsonResponse(nativeAttachment(
        body.mode,
        options.globalHotkeysAvailable,
      ));
    }
    if (path.endsWith("/api/v1/native-overlay/minimap") && method === "DELETE") {
      order.push("DETACH");
      return new Response(null, { status: 204 });
    }
    if (path.includes("/api/v1/native-overlay/events?") && method === "GET") {
      order.push("EVENTS");
      if (init?.signal) eventSignals.push(init.signal);
      const after = Number(new URL(path, window.location.href).searchParams.get("after"));
      const nextBatch = await eventBatches.shift();
      return jsonResponse(nextBatch === undefined ? {
        protocolVersion: 1,
        latestCursor: after,
        events: [],
      } : nextBatch);
    }
    throw new Error(`Unexpected native overlay request: ${method} ${path}`);
  });
  return { eventSignals, order, request };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("MapMiniMap", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearClientDiagnostics();
    setPictureInPictureController(undefined);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new TypeError("static host")));
  });

  afterEach(() => {
    setPictureInPictureController(undefined);
    vi.unstubAllGlobals();
  });

  it("fills and tracks the resizable Picture-in-Picture viewport while copying stylesheet links", async () => {
    const api = createNativeOverlayApi();
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow({ width: 640, height: 360 });
    const requestWindow = vi.fn().mockResolvedValue(pipWindow as unknown as Window);
    setPictureInPictureController({ requestWindow });
    const stylesheet = document.createElement("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = "/assets/app.css";
    document.head.append(stylesheet);

    const view = renderMiniMap(player, [], [], [{
      id: "pip-route",
      start: player.screen,
      end: { x: 300, y: 330 },
    }]);
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    await waitFor(() => expect(requestWindow).toHaveBeenCalledWith({ width: 300, height: 300 }));
    const pipDialog = within(pipWindow.document.body).getByRole("dialog", { name: "Customs 미니맵" });
    expect(pipDialog).toHaveClass("map-minimap--pip");
    expect(pipDialog.querySelector(".map-minimap-header")).not.toBeInTheDocument();
    expect(pipDialog.querySelector(".map-minimap-settings")).not.toBeInTheDocument();
    expect(pipDialog.querySelector(".map-minimap-browser-note")).not.toBeInTheDocument();
    const pipWorld = within(pipWindow.document.body).getByTestId("map-minimap-world");
    expect(within(pipWindow.document.body).getByTestId("map-minimap-quest-route-line"))
      .toHaveAttribute("x2", "300");
    expect(pipWorld.style.transform).toBe("translate(275px, 90px) scale(0.45)");
    expect(pipWorld).toHaveStyle({ "--mini-map-scale": "0.45" });

    act(() => pipWindow.dispatchResize(400, 400));
    await waitFor(() => {
      expect(pipWorld.style.transform).toBe("translate(160px, 120px) scale(0.4)");
    });
    expect(pipWorld).toHaveStyle({ "--mini-map-scale": "0.4" });
    expect(pipWindow.document.head.querySelector('link[rel="stylesheet"]')).toHaveAttribute(
      "href",
      stylesheet.href,
    );
    expect(screen.queryByTestId("map-minimap-fallback")).not.toBeInTheDocument();

    view.unmount();
    expect(pipWindow.close).toHaveBeenCalledTimes(1);
    stylesheet.remove();
  });

  it("uses the configured window size when opening the mini-map", async () => {
    const api = createNativeOverlayApi();
    vi.stubGlobal("fetch", api.request);
    persistMapSettings({ miniMapWindowSize: 480 });
    const pipWindow = createPictureInPictureWindow({ width: 480, height: 480 });
    const requestWindow = vi.fn().mockResolvedValue(pipWindow as unknown as Window);
    setPictureInPictureController({ requestWindow });

    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    await waitFor(() => {
      expect(requestWindow).toHaveBeenCalledWith({ width: 480, height: 480 });
    });
  });

  it("still opens after React Strict Mode replays mount effects", async () => {
    const api = createNativeOverlayApi();
    vi.stubGlobal("fetch", api.request);
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
    const fallbackDialog = screen.getByRole("dialog", { name: "Customs 미니맵" });
    expect(fallbackDialog).toHaveClass("map-minimap-fallback");
    expect(
      await within(fallbackDialog).findByRole("region", { name: "Customs 미니맵" }),
    ).toHaveClass("map-minimap--fallback");
    expect(within(fallbackDialog).getByRole("button", { name: "페이지 안 미니맵 닫기" }))
      .toHaveFocus();
    expect(screen.getByTestId("map-minimap-world").style.transform).toBe(
      "translate(120px, 90px) scale(0.3)",
    );

    fireEvent.click(screen.getByRole("button", { name: "미니맵 닫기" }));
    await waitFor(() => {
      expect(screen.queryByTestId("map-minimap-fallback")).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "미니맵 열기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("starts as a clean overlay without internal top or bottom chrome", async () => {
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    await screen.findByTestId("map-minimap-fallback");
    expect(document.querySelector(".map-minimap-header")).not.toBeInTheDocument();
    expect(document.querySelector(".map-minimap-settings")).not.toBeInTheDocument();
    expect(document.querySelector(".map-minimap-browser-note")).not.toBeInTheDocument();
  });

  it("keeps the minimap shell transparent so the desktop behind it remains visible", async () => {
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    const dialog = await screen.findByRole("dialog", { name: "Customs 미니맵" });
    const surface = await within(dialog).findByRole("region", { name: "Customs 미니맵" });
    expect(surface.style.backgroundColor).toBe("transparent");
  });

  it("zooms with Alt plus and Alt minus while the fallback has focus", async () => {
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await screen.findByTestId("map-minimap-world");

    const zoomIn = new KeyboardEvent("keydown", {
      altKey: true,
      bubbles: true,
      cancelable: true,
      code: "Equal",
      key: "+",
      shiftKey: true,
    });
    fireEvent(document, zoomIn);
    expect(zoomIn.defaultPrevented).toBe(true);
    expect(world.style.transform).toBe("translate(118.5px, 87px) scale(0.315)");

    const zoomOut = new KeyboardEvent("keydown", {
      altKey: true,
      bubbles: true,
      cancelable: true,
      code: "Minus",
      key: "-",
    });
    fireEvent(document, zoomOut);
    expect(zoomOut.defaultPrevented).toBe(true);
    expect(world.style.transform).toBe("translate(120px, 90px) scale(0.3)");

    fireEvent.keyDown(document, { key: "+", code: "Equal" });
    expect(world.style.transform).toBe("translate(120px, 90px) scale(0.3)");
  });

  it("uses the configured zoom keys in the fallback", async () => {
    persistMapSettings({
      miniMapZoomStep: 0.1,
      miniMapZoomInKey: "Ctrl+Z",
      miniMapZoomOutKey: "Ctrl+X",
    });
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await screen.findByTestId("map-minimap-world");
    const zoomIn = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      code: "KeyZ",
      ctrlKey: true,
      key: "z",
    });

    fireEvent(document, zoomIn);

    expect(zoomIn.defaultPrevented).toBe(true);
    expect(world.style.transform).toBe("translate(117px, 84px) scale(0.33)");
  });

  it("handles Alt zoom in the PiP document and validated native hotkey events", async () => {
    const api = createNativeOverlayApi({
      eventBatches: [{ protocolVersion: 1, latestCursor: 0, events: [] }],
      globalHotkeysAvailable: false,
    });
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(pipWindow as unknown as Window),
    });
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const pipWorld = await within(pipWindow.document.body).findByTestId("map-minimap-world");

    fireEvent.keyDown(pipWindow.document, {
      altKey: true,
      code: "NumpadAdd",
      key: "+",
    });
    await waitFor(() => {
      expect(pipWorld.style.transform).toBe("translate(118.5px, 87px) scale(0.315)");
    });

    act(() => window.dispatchEvent(new CustomEvent("tarkov-helper:native-hotkey", {
      detail: { protocolVersion: 1, action: "MINIMAP_ZOOM_OUT" },
    })));
    expect(pipWorld.style.transform).toBe("translate(120px, 90px) scale(0.3)");

    act(() => window.dispatchEvent(new CustomEvent("tarkov-helper:native-hotkey", {
      detail: { protocolVersion: 2, action: "MINIMAP_ZOOM_IN" },
    })));
    expect(pipWorld.style.transform).toBe("translate(120px, 90px) scale(0.3)");
  });

  it("follows position updates in tracking mode but keeps the map fixed in fixed mode", async () => {
    const trackingView = renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await screen.findByTestId("map-minimap-world");
    const trackingTransform = world.style.transform;

    trackingView.rerender(
      <MapMiniMap
        config={config}
        orderedFloors={config.floors}
        player={{ screen: { x: 700, y: 600 }, angle: 90 }}
        playerMarkerSize={18}
        selectedFloor="main"
      />,
    );
    expect(world.style.transform).not.toBe(trackingTransform);
    trackingView.unmount();

    persistMapSettings({ miniMapViewMode: "fixed" });
    const fixedView = renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const fixedWorld = await screen.findByTestId("map-minimap-world");
    const fixedTransform = fixedWorld.style.transform;
    fixedView.rerender(
      <MapMiniMap
        config={config}
        orderedFloors={config.floors}
        player={{ screen: { x: 250, y: 300 }, angle: 180 }}
        playerMarkerSize={18}
        selectedFloor="main"
      />,
    );
    expect(fixedWorld).toHaveAttribute("data-view-mode", "fixed");
    expect(fixedWorld.style.transform).toBe(fixedTransform);
  });

  it("pans fixed view with a middle-button pointer drag", async () => {
    persistMapSettings({ miniMapViewMode: "fixed" });
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await screen.findByTestId("map-minimap-world");
    const stage = screen.getByTestId("map-minimap-stage");
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
  });

  it("keeps at least one quarter of the map visible after an extreme fixed-view pan", async () => {
    persistMapSettings({ miniMapViewMode: "fixed" });
    renderMiniMap();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
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
    expect(document.querySelector(".map-minimap-browser-note")).not.toBeInTheDocument();
  });

  it("renders compact extraction names and shows the categorized legend at the bottom", async () => {
    renderMiniMap(player, [
      {
        id: "quest:water-room:visit",
        kind: "quest",
        screen: { x: 200, y: 240 },
        summary: "퀘스트 목표 · Water Room · Visit",
        selected: true,
      },
      {
        id: "extract-crossroads",
        kind: "data",
        label: "Crossroads",
        screen: { x: 300, y: 330 },
        summary: "탈출구 · Crossroads",
      },
    ], [
      { id: "extract", label: "탈출구", count: 2 },
      { id: "boss", label: "보스", count: 1 },
      { id: "cultist", label: "컬티", count: 0 },
      { id: "pmc-spawn", label: "PMC 스폰 위치", count: 3 },
      { id: "pmc-extract", label: "PMC 탈출구", count: 1 },
      { id: "scav-extract", label: "스캐브 탈출구", count: 2 },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(await screen.findAllByTestId("map-minimap-marker")).toHaveLength(2);
    expect(screen.queryByTestId("map-minimap-marker-summary")).not.toBeInTheDocument();
    const legend = screen.getByTestId("map-minimap-marker-legend");
    expect(legend).toHaveTextContent("탈출구");
    expect(legend).toHaveTextContent("보스");
    expect(legend).toHaveTextContent("컬티");
    expect(legend).toHaveTextContent("PMC 스폰 위치");
    expect(legend).toHaveTextContent("PMC 탈출구");
    expect(legend).toHaveTextContent("스캐브 탈출구");
    expect(within(legend).getAllByTestId("map-minimap-legend-item")).toHaveLength(6);
    expect(screen.queryByText("Water Room")).not.toBeInTheDocument();
    expect(screen.getByTestId("map-minimap-marker-label")).toHaveTextContent("Crossroads");
  });

  it("draws selected quest routes in map coordinates below mini-map markers", async () => {
    renderMiniMap(player, [{
      id: "quest-target",
      kind: "quest",
      screen: { x: 300, y: 330 },
      summary: "퀘스트 목표 · 물방 찾기",
    }], [], [{
      id: "route:quest-water:objective-water",
      start: player.screen,
      end: { x: 300, y: 330 },
    }]);
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    const line = await screen.findByTestId("map-minimap-quest-route-line");
    expect(line).toHaveAttribute("x1", "100");
    expect(line).toHaveAttribute("y1", "200");
    expect(line).toHaveAttribute("x2", "300");
    expect(line).toHaveAttribute("y2", "330");
    expect(line.closest("svg")).toHaveAttribute("viewBox", "0 0 1000 800");
  });

  it("uses the same icon and shape variants as the full map markers", async () => {
    renderMiniMap(player, [
      {
        id: "quest-icon",
        kind: "quest",
        shape: "quest",
        iconUrl: "/assets/map-icons/Quest_Mark.svg",
        screen: { x: 200, y: 240 },
        summary: "퀘스트 목표 · Mark",
      },
      {
        id: "optional-icon",
        kind: "quest",
        shape: "optional",
        optionalLabel: "선택 1",
        screen: { x: 240, y: 280 },
        summary: "퀘스트 선택지 · 1",
      },
      {
        id: "extract-icon",
        kind: "data",
        shape: "icon",
        iconUrl: "/assets/map-icons/PMC%20Extraction.webp",
        screen: { x: 300, y: 330 },
        summary: "탈출구 · Crossroads",
      },
      {
        id: "custom-pin",
        kind: "custom",
        shape: "custom",
        color: "#4f8cff",
        size: 24,
        screen: { x: 360, y: 390 },
        summary: "커스텀 마커 · Custom",
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    const markers = await screen.findAllByTestId("map-minimap-marker");
    expect(markers[0]).toHaveAttribute("data-marker-shape", "quest");
    expect(markers[0].querySelector("img")).toHaveAttribute(
      "src",
      "/assets/map-icons/Quest_Mark.svg",
    );
    expect(markers[1]).toHaveAttribute("data-marker-shape", "optional");
    expect(within(markers[1]).getByText("선택 1")).toBeInTheDocument();
    expect(markers[2]).toHaveAttribute("data-marker-shape", "icon");
    expect(markers[2].querySelector("img")).toHaveAttribute(
      "src",
      "/assets/map-icons/PMC%20Extraction.webp",
    );
    expect(markers[3]).toHaveAttribute("data-marker-shape", "custom");
    expect(markers[3].querySelector(".map-minimap-custom-pin")).toBeInTheDocument();
  });

  it("offers separate mini-map marker toggles beside the overlay controls", async () => {
    const api = createNativeOverlayApi();
    vi.stubGlobal("fetch", api.request);
    setPictureInPictureController({ requestWindow: vi.fn() });

    renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });

    fireEvent.click(screen.getByRole("button", { name: "미니맵 마커 설정" }));
    const panel = screen.getByRole("group", { name: "미니맵 마커 표시 설정" });
    expect(panel).toHaveClass("map-marker-layer-panel");
    expect(within(panel).getByText("미니맵 레이어")).toBeInTheDocument();
    expect(within(panel).getByRole("heading", { name: "마커 표시" })).toBeInTheDocument();
    expect(panel.querySelector(".map-marker-layer-grid")).toBeInTheDocument();
    expect(within(panel).getByRole("checkbox", {
      name: "일반 퀘스트 마커 (선택 경로 제외)",
    })).toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: "탈출구 이름표 표시" })).toBeChecked();
    expect(within(panel).getByRole("checkbox", { name: "PMC 탈출구 표시" })).toBeChecked();

    fireEvent.click(within(panel).getByRole("checkbox", { name: "탈출구 이름표 표시" }));
    fireEvent.click(within(panel).getByRole("checkbox", { name: "PMC 탈출구 표시" }));
    const stored = JSON.parse(window.localStorage.getItem(APP_STATE_STORAGE_KEY) ?? "{}");
    expect(stored.settings.map.miniMapShowExtractLabels).toBe(false);
    expect(stored.settings.map.miniMapShowPmcExtracts).toBe(false);
    expect(stored.settings.map.showPmcExtracts).toBe(true);
  });

  it("claims the PiP before opening, applies a 300px locked overlay, and keeps click-through controls on the main page", async () => {
    const api = createNativeOverlayApi();
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow({ width: 1200, height: 720 });
    const requestWindow = vi.fn(async () => {
      api.order.push("REQUEST_WINDOW");
      return pipWindow as unknown as Window;
    });
    setPictureInPictureController({ requestWindow });
    pipWindow.close.mockImplementation(() => {
      api.order.push("WINDOW_CLOSE");
    });

    renderMiniMap();
    expect(await screen.findByRole("button", { name: "오버레이 위치 고정" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(await screen.findByText("오버레이 고정됨 · 클릭 통과 꺼짐")).toBeInTheDocument();
    expect(api.order.slice(0, 5)).toEqual([
      "SESSION",
      "CLAIM",
      "REQUEST_WINDOW",
      "ATTACH",
      "PATCH_LOCKED",
    ]);
    expect(pipWindow.document.title).toBe(nativeSessionPayload.windowTitle);
    expect(pipWindow.document.documentElement.style.background).toBe("transparent");
    expect(pipWindow.document.body.style.background).toBe("transparent");
    const firstPatch = api.request.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(firstPatch?.[1]?.body))).toEqual({
      overlayId: nativeOverlayId,
      mode: "LOCKED",
      width: 300,
      height: 300,
      opacity: 0.8,
    });

    const lockButton = screen.getByRole("button", { name: "오버레이 위치 잠금 해제" });
    expect(lockButton).toHaveAttribute("aria-pressed", "true");
    expect(within(pipWindow.document.body).queryByRole("group", {
      name: "미니맵 오버레이 제어",
    })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "클릭 통과 켜기" }));
    expect(await screen.findByRole("button", { name: "클릭 통과 끄기" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("클릭 통과 켜짐 · 메인 지도에서 언제든 끌 수 있습니다")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "클릭 통과 끄기" }));
    expect(await screen.findByRole("button", { name: "클릭 통과 켜기" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "오버레이 위치 잠금 해제" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "오버레이 위치 잠금 해제" }));
    expect(await screen.findByRole("button", { name: "오버레이 위치 고정" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByText("위치 잠금 해제됨 · 창을 이동하거나 크기를 조절하세요")).toBeInTheDocument();
    const unlockedPatch = api.request.mock.calls
      .filter(([, init]) => init?.method === "PATCH")
      .at(-1);
    expect(JSON.parse(String(unlockedPatch?.[1]?.body))).toEqual({
      overlayId: nativeOverlayId,
      mode: "UNLOCKED",
      opacity: 0.8,
    });
    expect(within(pipWindow.document.body).getByRole("dialog")).toHaveStyle({
      "--mini-map-opacity": "1",
    });

    fireEvent.click(screen.getByRole("button", { name: "오버레이 위치 고정" }));
    await screen.findByText("오버레이 고정됨 · 클릭 통과 꺼짐");
    const patchCalls = api.request.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patchCalls.at(-1)?.[1]?.body))).toEqual({
      overlayId: nativeOverlayId,
      mode: "LOCKED",
      opacity: 0.8,
    });

    await waitFor(() => expect(api.eventSignals.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "미니맵 닫기" }));
    await waitFor(() => expect(pipWindow.close).toHaveBeenCalledTimes(1));
    expect(api.eventSignals.length).toBeGreaterThan(0);
    expect(api.eventSignals.every((signal) => signal.aborted)).toBe(true);
    expect(api.order.indexOf("DETACH")).toBeLessThan(api.order.indexOf("WINDOW_CLOSE"));
  });

  it("polls attached native hotkeys without also applying the PiP document shortcut", async () => {
    let resolveFirstBatch: ((batch: unknown) => void) | undefined;
    const firstBatch = new Promise<unknown>((resolve) => {
      resolveFirstBatch = resolve;
    });
    const api = createNativeOverlayApi({
      eventBatches: [firstBatch],
    });
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(pipWindow as unknown as Window),
    });

    renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await within(pipWindow.document.body).findByTestId("map-minimap-world");
    await screen.findByText("오버레이 고정됨 · 클릭 통과 꺼짐");
    await waitFor(() => expect(api.eventSignals.length).toBeGreaterThan(0));

    const documentShortcut = new KeyboardEvent("keydown", {
      altKey: true,
      bubbles: true,
      cancelable: true,
      code: "NumpadAdd",
      key: "+",
    });
    fireEvent(pipWindow.document, documentShortcut);
    expect(documentShortcut.defaultPrevented).toBe(false);
    expect(world.style.transform).toBe("translate(120px, 90px) scale(0.3)");

    resolveFirstBatch?.({
      protocolVersion: 1,
      latestCursor: 1,
      events: [{ cursor: 1, action: "ZOOM_IN" }],
    });

    await waitFor(() => {
      expect(world.style.transform).toBe("translate(118.5px, 87px) scale(0.315)");
    });
    expect(api.order).toContain("EVENTS");

    fireEvent.click(screen.getByRole("button", { name: "미니맵 닫기" }));
    await waitFor(() => expect(pipWindow.close).toHaveBeenCalledOnce());
    expect(api.eventSignals.every((signal) => signal.aborted)).toBe(true);
  });

  it("records one diagnostic when an attached native hotkey poll terminates", async () => {
    const api = createNativeOverlayApi({ eventBatches: [{ malformed: true }] });
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(pipWindow as unknown as Window),
    });

    renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    await screen.findByText("오버레이 고정됨 · 클릭 통과 꺼짐");

    await waitFor(() => expect(getClientDiagnosticSnapshot().entries).toEqual([
      expect.objectContaining({
        code: "NATIVE_OVERLAY_INVALID_RESPONSE",
        count: 1,
        operation: "EVENT_POLL",
        source: "optional-resource",
      }),
    ]));
    fireEvent.click(screen.getByRole("button", { name: "미니맵 닫기" }));
  });

  it("keeps focused PiP Alt zoom when global native hotkeys are unavailable", async () => {
    const api = createNativeOverlayApi({ globalHotkeysAvailable: false });
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(pipWindow as unknown as Window),
    });

    renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    const world = await within(pipWindow.document.body).findByTestId("map-minimap-world");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "전역 단축키 등록 실패—미니맵을 클릭한 뒤 사용",
    );
    const documentShortcut = new KeyboardEvent("keydown", {
      altKey: true,
      bubbles: true,
      cancelable: true,
      code: "NumpadAdd",
      key: "+",
    });
    fireEvent(pipWindow.document, documentShortcut);

    expect(documentShortcut.defaultPrevented).toBe(true);
    expect(world.style.transform).toBe("translate(118.5px, 87px) scale(0.315)");
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    expect(api.eventSignals).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "미니맵 닫기" }));
    await waitFor(() => expect(pipWindow.close).toHaveBeenCalledOnce());
  });

  it("stops native event polling when the attached overlay is lost", async () => {
    const api = createNativeOverlayApi({ loseOverlayAfterLock: true });
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(pipWindow as unknown as Window),
    });

    renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    await screen.findByText("오버레이 고정됨 · 클릭 통과 꺼짐");
    await waitFor(() => expect(api.eventSignals.length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "오버레이 위치 잠금 해제" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "오버레이 연결이 종료되었습니다",
    );
    expect(api.eventSignals.every((signal) => signal.aborted)).toBe(true);
    expect(screen.getByRole("button", { name: "오버레이 위치 고정" })).toBeDisabled();
  });

  it("does not open a framed PiP window when the native bridge is unavailable", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "missing" }, 404));
    vi.stubGlobal("fetch", request);
    const requestWindow = vi.fn();
    setPictureInPictureController({ requestWindow });

    renderMiniMap();
    await waitFor(() => expect(request).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(await screen.findByTestId("map-minimap-fallback")).toBeInTheDocument();
    expect(requestWindow).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "미니맵 오버레이 제어" })).not.toBeInTheDocument();
    expect(screen.getByText("브라우저 상단 탭을 숨긴 페이지 안 미니맵으로 열었습니다.")).toBeInTheDocument();
    expect(request.mock.calls.every(([, init]) => (init?.method ?? "GET") === "GET")).toBe(true);
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
  });

  it("records an actionable native bridge session failure without a response body", async () => {
    const secret = "s".repeat(43);
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: secret }, 503));
    vi.stubGlobal("fetch", request);

    renderMiniMap();
    await waitFor(() => expect(request).toHaveBeenCalled());

    const snapshot = getClientDiagnosticSnapshot();
    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        code: "NATIVE_OVERLAY_REQUEST_FAILED",
        count: 1,
        operation: "SESSION",
        source: "optional-resource",
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(secret);
  });

  it("falls back to the chrome-free page minimap when native attachment fails", async () => {
    const api = createNativeOverlayApi({ failAttach: true });
    vi.stubGlobal("fetch", api.request);
    const pipWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(pipWindow as unknown as Window),
    });

    renderMiniMap();
    expect(await screen.findByRole("button", { name: "오버레이 위치 고정" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(await screen.findByTestId("map-minimap-fallback")).toBeInTheDocument();
    expect(pipWindow.close).toHaveBeenCalledOnce();
    const snapshot = getClientDiagnosticSnapshot();
    expect(snapshot.entries).toEqual([
      expect.objectContaining({
        source: "optional-resource",
        code: "NATIVE_OVERLAY_WINDOW_NOT_FOUND",
        operation: "ATTACH",
        count: 1,
      }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain(nativeSessionPayload.token);
    expect(JSON.stringify(snapshot)).not.toContain(nativeClaimId);
    expect(JSON.stringify(snapshot)).not.toContain(nativeOverlayId);
    expect(screen.queryByRole("group", { name: "미니맵 오버레이 제어" })).not.toBeInTheDocument();
    expect(screen.getByText("브라우저 상단 탭을 숨긴 페이지 안 미니맵으로 열었습니다.")).toBeInTheDocument();
  });

  it("clears the native preparing state when the browser rejects the PiP request", async () => {
    const api = createNativeOverlayApi();
    vi.stubGlobal("fetch", api.request);
    setPictureInPictureController({
      requestWindow: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")),
    });

    renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(await screen.findByTestId("map-minimap-fallback")).toBeInTheDocument();
    expect(screen.queryByText("Windows 오버레이 창 준비 중…")).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "미니맵 오버레이 제어" })).not.toBeInTheDocument();
    expect(api.order).toContain("CLAIM");
    expect(api.order).not.toContain("ATTACH");
    expect(getClientDiagnosticSnapshot().entries).toHaveLength(0);
  });

  it("does not leave unusable native controls when Document PiP is unsupported", async () => {
    const api = createNativeOverlayApi();
    vi.stubGlobal("fetch", api.request);
    setPictureInPictureController(undefined);

    renderMiniMap();
    await waitFor(() => expect(api.request).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "미니맵 오버레이 제어" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));

    expect(await screen.findByTestId("map-minimap-fallback")).toBeInTheDocument();
    expect(screen.queryByText("Windows 오버레이 창 준비 중…")).not.toBeInTheDocument();
    expect(api.order).not.toContain("CLAIM");
  });

  it("does not request a PiP window when unmounted while the native claim is pending", async () => {
    let resolveClaim: ((response: Response) => void) | undefined;
    const claimResponse = new Promise<Response>((resolve) => {
      resolveClaim = resolve;
    });
    const api = createNativeOverlayApi({ claimResponse });
    vi.stubGlobal("fetch", api.request);
    const requestWindow = vi.fn();
    setPictureInPictureController({ requestWindow });

    const view = renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    await waitFor(() => expect(api.order).toContain("CLAIM"));
    view.unmount();

    await act(async () => {
      resolveClaim?.(jsonResponse({
        protocolVersion: 1,
        claimId: nativeClaimId,
        expiresAt: "2026-08-08T12:00:15.000Z",
      }, 201));
      await claimResponse;
      await Promise.resolve();
    });

    expect(requestWindow).not.toHaveBeenCalled();
    expect(api.order).not.toContain("REQUEST_WINDOW");
  });

  it("best-effort detaches and restores the native window on PiP pagehide and unmount", async () => {
    const pageHideApi = createNativeOverlayApi();
    vi.stubGlobal("fetch", pageHideApi.request);
    const pageHideWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(pageHideWindow as unknown as Window),
    });
    const firstView = renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    await screen.findByText("오버레이 고정됨 · 클릭 통과 꺼짐");
    await waitFor(() => expect(pageHideApi.eventSignals.length).toBeGreaterThan(0));

    act(() => pageHideWindow.dispatchPageHide());
    await waitFor(() => {
      const detachCall = pageHideApi.request.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(detachCall?.[1]).toMatchObject({ keepalive: true });
    });
    expect(screen.queryByTestId("map-minimap-fallback")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Customs 미니맵" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "미니맵 열기" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(pageHideApi.eventSignals.every((signal) => signal.aborted)).toBe(true);
    firstView.unmount();

    const unmountApi = createNativeOverlayApi();
    vi.stubGlobal("fetch", unmountApi.request);
    const unmountWindow = createPictureInPictureWindow();
    setPictureInPictureController({
      requestWindow: vi.fn().mockResolvedValue(unmountWindow as unknown as Window),
    });
    const secondView = renderMiniMap();
    await screen.findByRole("button", { name: "오버레이 위치 고정" });
    fireEvent.click(screen.getByRole("button", { name: "미니맵 열기" }));
    await screen.findByText("오버레이 고정됨 · 클릭 통과 꺼짐");
    await waitFor(() => expect(unmountApi.eventSignals.length).toBeGreaterThan(0));

    secondView.unmount();
    await waitFor(() => {
      const detachCall = unmountApi.request.mock.calls.find(([, init]) => init?.method === "DELETE");
      expect(detachCall?.[1]).toMatchObject({ keepalive: true });
    });
    expect(unmountApi.eventSignals.every((signal) => signal.aborted)).toBe(true);
    expect(unmountWindow.close).toHaveBeenCalledTimes(1);
  });
});
