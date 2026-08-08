import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  MousePointer2,
  Navigation,
  Pin,
} from "lucide-react";

import { useAppStore } from "../../app/store";
import {
  applySvgFloorVisibility,
  getMapDirectionAngle,
} from "../../domain/map";
import type { MapConfig, MapFloor } from "../../types/data";
import {
  DEFAULT_MINI_MAP_ZOOM_IN_KEY,
  DEFAULT_MINI_MAP_ZOOM_OUT_KEY,
  matchesMiniMapShortcut,
} from "./minimap-shortcuts";
import {
  NativeOverlayApiError,
  NATIVE_OVERLAY_HOTKEY_EVENT,
  attachNativeMiniMap,
  beginNativeOverlayClaim,
  detachNativeMiniMap,
  fetchNativeOverlaySession,
  pollNativeOverlayEvents,
  updateNativeMiniMap,
  type NativeOverlayAttachment,
  type NativeOverlayMode,
  type NativeOverlaySession,
  type NativeOverlayHotkeyAction,
} from "../../services/native-overlay";
import "../../styles/minimap.css";

const MINI_MAP_SIZE = 300;
const MINI_MAP_MIN_SIZE = 240;
const MINI_MAP_MAX_SIZE = 1000;
const ZOOM_STEP = 0.05;

interface DocumentPictureInPictureController {
  requestWindow: (options: { width: number; height: number }) => Promise<Window>;
}

interface PictureInPictureState {
  root: HTMLElement;
  window: Window;
  viewport: MiniMapViewport;
}

interface MiniMapViewport {
  width: number;
  height: number;
}

type MiniMapPresentation = "fallback" | "pip";

type MiniMapStyle = CSSProperties & Record<`--${string}`, string | number>;

export interface MapMiniMapPlayer {
  screen: {
    x: number;
    y: number;
  };
  angle?: number;
}

export interface MapMiniMapProps {
  config: MapConfig;
  orderedFloors: readonly MapFloor[];
  selectedFloor?: string;
  player?: MapMiniMapPlayer;
  playerMarkerSize: number;
}

function getPictureInPictureController():
  | DocumentPictureInPictureController
  | undefined {
  return (
    window as Window & {
      documentPictureInPicture?: DocumentPictureInPictureController;
    }
  ).documentPictureInPicture;
}

function copyPageStyles(targetDocument: Document): void {
  for (const stylesheet of document.querySelectorAll<HTMLLinkElement>(
    'link[rel="stylesheet"]',
  )) {
    const copy = targetDocument.createElement("link");
    copy.rel = "stylesheet";
    copy.href = stylesheet.href;
    if (stylesheet.media) copy.media = stylesheet.media;
    targetDocument.head.append(copy);
  }

  for (const style of document.querySelectorAll<HTMLStyleElement>("style")) {
    targetDocument.head.append(targetDocument.importNode(style, true));
  }
}

function preparePictureInPictureDocument(
  pipWindow: Window,
  windowTitle?: string,
): HTMLElement {
  const pipDocument = pipWindow.document;
  if (windowTitle) pipDocument.title = windowTitle;
  pipDocument.documentElement.lang = document.documentElement.lang || "ko";
  pipDocument.documentElement.style.width = "100%";
  pipDocument.documentElement.style.height = "100%";
  pipDocument.documentElement.style.background = "transparent";
  pipDocument.documentElement.style.backgroundImage = "none";
  pipDocument.body.style.width = "100%";
  pipDocument.body.style.height = "100%";
  pipDocument.body.style.margin = "0";
  pipDocument.body.style.overflow = "hidden";
  pipDocument.body.style.background = "transparent";
  pipDocument.body.style.backgroundImage = "none";
  copyPageStyles(pipDocument);

  const root = pipDocument.createElement("div");
  root.className = "map-minimap-pip-root";
  pipDocument.body.append(root);
  return root;
}

function mapAssetUrl(fileName: string): string {
  const relativePath = `${import.meta.env.BASE_URL}assets/maps/${encodeURIComponent(fileName)}`;
  return new URL(relativePath, window.location.href).href;
}

function pictureInPictureViewport(pipWindow: Window): MiniMapViewport {
  const width = Number.isFinite(pipWindow.innerWidth) && pipWindow.innerWidth > 0
    ? pipWindow.innerWidth
    : MINI_MAP_SIZE;
  const height = Number.isFinite(pipWindow.innerHeight) && pipWindow.innerHeight > 0
    ? pipWindow.innerHeight
    : MINI_MAP_SIZE;
  return { width, height };
}

function clampMapTranslation(
  translation: number,
  scaledMapSize: number,
  viewportSize: number,
): number {
  const minimum = viewportSize * 0.25 - scaledMapSize;
  const maximum = viewportSize * 0.75;
  return Math.min(maximum, Math.max(minimum, translation));
}

interface MiniMapSurfaceProps extends MapMiniMapProps {
  nativeGlobalHotkeysAvailable?: boolean;
  nativeOverlayMode?: NativeOverlayMode;
  presentation: MiniMapPresentation;
  viewport: MiniMapViewport;
}

interface PanGesture {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startOffsetX: number;
  startOffsetY: number;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const candidate = target as { matches?: unknown } | null;
  return typeof candidate?.matches === "function" &&
    (candidate.matches as (selector: string) => boolean)(
      "input, select, textarea, [contenteditable]:not([contenteditable='false'])",
    );
}

function nativeHotkeyAction(event: Event): NativeOverlayHotkeyAction | undefined {
  if (!(event instanceof CustomEvent)) return undefined;
  const detail: unknown = event.detail;
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    return undefined;
  }
  const record = detail as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !keys.includes("protocolVersion") ||
    !keys.includes("action") ||
    record.protocolVersion !== 1
  ) {
    return undefined;
  }
  return record.action === "MINIMAP_ZOOM_IN" || record.action === "MINIMAP_ZOOM_OUT"
    ? record.action
    : undefined;
}

function MiniMapSurface({
  config,
  orderedFloors,
  selectedFloor,
  player,
  playerMarkerSize,
  nativeGlobalHotkeysAvailable,
  nativeOverlayMode,
  presentation,
  viewport,
}: MiniMapSurfaceProps) {
  const { settings, updateMapSettings } = useAppStore();
  const mapSettings = settings.map;
  const surfaceRef = useRef<HTMLElement>(null);
  const mapObjectRef = useRef<HTMLObjectElement>(null);
  const panGestureRef = useRef<PanGesture | null>(null);
  const zoomRef = useRef(mapSettings.miniMapZoom);
  const mapWidth = Math.max(1, config.imageWidth);
  const mapHeight = Math.max(1, config.imageHeight);
  const viewportWidth = Math.max(1, viewport.width);
  const viewportHeight = Math.max(1, viewport.height);
  const fitScale = Math.min(
    viewportWidth / mapWidth,
    viewportHeight / mapHeight,
  );
  const scale = fitScale * mapSettings.miniMapZoom;
  const tracking = mapSettings.miniMapViewMode === "playerTracking";
  const centeredX = (viewportWidth - mapWidth * scale) / 2;
  const centeredY = (viewportHeight - mapHeight * scale) / 2;
  const fixedX = clampMapTranslation(
    centeredX + mapSettings.miniMapOffsetX,
    mapWidth * scale,
    viewportWidth,
  );
  const fixedY = clampMapTranslation(
    centeredY + mapSettings.miniMapOffsetY,
    mapHeight * scale,
    viewportHeight,
  );
  const normalizedOffsetX = fixedX - centeredX;
  const normalizedOffsetY = fixedY - centeredY;
  const x = tracking && player
    ? viewportWidth / 2 - player.screen.x * scale
    : tracking ? centeredX : fixedX;
  const y = tracking && player
    ? viewportHeight / 2 - player.screen.y * scale
    : tracking ? centeredY : fixedY;
  const mapUrl = useMemo(
    () => mapAssetUrl(config.svgFileName),
    [config.svgFileName],
  );
  const direction = player?.angle === undefined
    ? 0
    : getMapDirectionAngle(player.angle, config.key, config.mapRotation);
  const markerSize = Math.max(1, playerMarkerSize)
    * mapSettings.miniMapPlayerMarkerScale;
  const nativeShortcutsCompatible = Boolean(
    nativeGlobalHotkeysAvailable &&
    mapSettings.miniMapKeyboardShortcutsEnabled &&
    mapSettings.miniMapZoomInKey === DEFAULT_MINI_MAP_ZOOM_IN_KEY &&
    mapSettings.miniMapZoomOutKey === DEFAULT_MINI_MAP_ZOOM_OUT_KEY,
  );

  useEffect(() => {
    zoomRef.current = mapSettings.miniMapZoom;
  }, [mapSettings.miniMapZoom]);

  const zoomBy = useCallback((direction: -1 | 1) => {
    const nextZoom = Math.min(15, Math.max(0.01, zoomRef.current + direction * ZOOM_STEP));
    zoomRef.current = nextZoom;
    updateMapSettings({ miniMapZoom: nextZoom });
  }, [updateMapSettings]);

  useEffect(() => {
    if (!mapSettings.miniMapKeyboardShortcutsEnabled || nativeShortcutsCompatible) return;
    const surfaceDocument = surfaceRef.current?.ownerDocument;
    if (!surfaceDocument) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const zoomIn = matchesMiniMapShortcut(event, mapSettings.miniMapZoomInKey);
      const zoomOut = matchesMiniMapShortcut(event, mapSettings.miniMapZoomOutKey);
      if (!zoomIn && !zoomOut) return;
      event.preventDefault();
      zoomBy(zoomIn ? 1 : -1);
    };
    surfaceDocument.addEventListener("keydown", handleKeyDown);
    return () => surfaceDocument.removeEventListener("keydown", handleKeyDown);
  }, [mapSettings.miniMapKeyboardShortcutsEnabled, mapSettings.miniMapZoomInKey,
    mapSettings.miniMapZoomOutKey, nativeShortcutsCompatible, zoomBy]);

  useEffect(() => {
    if (
      !mapSettings.miniMapKeyboardShortcutsEnabled ||
      (nativeGlobalHotkeysAvailable === true && !nativeShortcutsCompatible)
    ) return;
    const handleNativeHotkey = (event: Event) => {
      const action = nativeHotkeyAction(event);
      if (!action) return;
      zoomBy(action === "MINIMAP_ZOOM_IN" ? 1 : -1);
    };
    window.addEventListener(NATIVE_OVERLAY_HOTKEY_EVENT, handleNativeHotkey);
    return () => window.removeEventListener(NATIVE_OVERLAY_HOTKEY_EVENT, handleNativeHotkey);
  }, [mapSettings.miniMapKeyboardShortcutsEnabled, nativeGlobalHotkeysAvailable,
    nativeShortcutsCompatible, zoomBy]);

  const syncFloor = useCallback(() => {
    try {
      const svgDocument = mapObjectRef.current?.contentDocument;
      if (svgDocument) {
        applySvgFloorVisibility(svgDocument, orderedFloors, selectedFloor);
      }
    } catch {
      // Same-origin bundled SVGs are expected. If the browser blocks access,
      // the complete SVG remains visible instead of breaking the mini-map.
    }
  }, [orderedFloors, selectedFloor]);

  useEffect(() => {
    syncFloor();
  }, [syncFloor, mapUrl]);

  useEffect(() => {
    if (
      tracking ||
      (Math.abs(normalizedOffsetX - mapSettings.miniMapOffsetX) < 0.001 &&
        Math.abs(normalizedOffsetY - mapSettings.miniMapOffsetY) < 0.001)
    ) {
      return;
    }
    updateMapSettings({
      miniMapOffsetX: normalizedOffsetX,
      miniMapOffsetY: normalizedOffsetY,
    });
  }, [
    mapSettings.miniMapOffsetX,
    mapSettings.miniMapOffsetY,
    normalizedOffsetX,
    normalizedOffsetY,
    tracking,
    updateMapSettings,
  ]);

  const worldStyle: MiniMapStyle = {
    width: mapWidth,
    height: mapHeight,
    transform: `translate(${x}px, ${y}px) scale(${scale})`,
    "--mini-map-inverse-scale": String(1 / Math.max(scale, 0.0001)),
  };
  const rootStyle: MiniMapStyle = {
    backgroundColor: "transparent",
    // The native window applies the configured opacity at the OS compositor
    // level in every attached mode so pixels behind the overlay remain visible.
    // Avoid multiplying that alpha a second time on the SVG itself.
    "--mini-map-opacity": nativeOverlayMode !== undefined
      ? "1"
      : String(mapSettings.miniMapOpacity),
  };
  const playerStyle: MiniMapStyle | undefined = player
    ? {
        left: player.screen.x,
        top: player.screen.y,
        width: markerSize,
        height: markerSize,
        "--mini-map-player-angle": `${direction}deg`,
      }
    : undefined;

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = panGestureRef.current;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    panGestureRef.current = null;
    try {
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Losing capture while the auxiliary button is released is harmless.
    }
  };

  const startPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (tracking || event.button !== 1) return;
    event.preventDefault();
    panGestureRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startOffsetX: mapSettings.miniMapOffsetX,
      startOffsetY: mapSettings.miniMapOffsetY,
    };
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is an enhancement; windowed pointer events still work.
    }
  };

  const pan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = panGestureRef.current;
    if (
      tracking ||
      !gesture ||
      gesture.pointerId !== event.pointerId ||
      (event.buttons & 4) === 0
    ) {
      return;
    }
    event.preventDefault();
    updateMapSettings({
      miniMapOffsetX:
        gesture.startOffsetX + event.clientX - gesture.startClientX,
      miniMapOffsetY:
        gesture.startOffsetY + event.clientY - gesture.startClientY,
    });
  };

  return (
    <section
      aria-keyshortcuts={`${mapSettings.miniMapZoomInKey} ${mapSettings.miniMapZoomOutKey}`}
      aria-label={`${config.displayName} 미니맵`}
      className={`map-minimap map-minimap--${presentation}`}
      data-native-overlay={nativeOverlayMode ?? undefined}
      ref={surfaceRef}
      role="dialog"
      style={rootStyle}
    >
      <div
        className="map-minimap-stage"
        data-pannable={!tracking || undefined}
        data-testid="map-minimap-stage"
        onAuxClick={(event) => {
          if (!tracking && event.button === 1) event.preventDefault();
        }}
        onPointerCancel={endPan}
        onPointerDown={startPan}
        onPointerMove={pan}
        onPointerUp={endPan}
      >
        <div
          className="map-minimap-world"
          data-testid="map-minimap-world"
          data-view-mode={mapSettings.miniMapViewMode}
          style={worldStyle}
        >
          <object
            key={`${config.key}:${config.svgFileName}`}
            ref={mapObjectRef}
            aria-label={`${config.displayName} 미니맵 지도`}
            className="map-minimap-map"
            data={mapUrl}
            height={mapHeight}
            onLoad={syncFloor}
            role="img"
            type="image/svg+xml"
            width={mapWidth}
          />
          {player && playerStyle ? (
            <span
              aria-label="현재 플레이어 위치와 방향"
              className="map-minimap-player"
              data-testid="map-minimap-player"
              role="img"
              style={playerStyle}
            >
              <span className="map-minimap-player-pulse" />
              <Navigation aria-hidden="true" />
            </span>
          ) : null}
        </div>
      </div>

    </section>
  );
}

interface NativeOverlayNotice {
  kind: "status" | "error";
  text: string;
}

function nativeOverlayModeNotice(
  overlay: NativeOverlayAttachment,
): NativeOverlayNotice {
  if (!overlay.globalHotkeysAvailable) {
    return {
      kind: "error",
      text: "전역 단축키 등록 실패—미니맵을 클릭한 뒤 사용",
    };
  }
  switch (overlay.mode) {
    case "UNLOCKED":
      return {
        kind: "status",
        text: "위치 잠금 해제됨 · 창을 이동하거나 크기를 조절하세요",
      };
    case "LOCKED":
      return {
        kind: "status",
        text: "오버레이 고정됨 · 클릭 통과 꺼짐",
      };
    case "CLICK_THROUGH":
      return {
        kind: "status",
        text: "클릭 통과 켜짐 · 메인 지도에서 언제든 끌 수 있습니다",
      };
  }
}

function nativeOverlayErrorNotice(error: unknown): NativeOverlayNotice {
  if (error instanceof NativeOverlayApiError) {
    switch (error.code) {
      case "AMBIGUOUS_WINDOW":
      case "WINDOW_NOT_FOUND":
        return {
          kind: "error",
          text: "미니맵 창을 정확히 찾지 못했습니다. 창을 닫고 다시 열어 주세요.",
        };
      case "CLAIM_NOT_FOUND":
        return {
          kind: "error",
          text: "오버레이 연결 시간이 만료되었습니다. 미니맵을 닫고 다시 열어 주세요.",
        };
      case "FORBIDDEN":
        return {
          kind: "error",
          text: "실행기 인증이 만료되었습니다. Tarkov Helper를 다시 실행해 주세요.",
        };
      case "OVERLAY_ALREADY_ATTACHED":
        return {
          kind: "error",
          text: "이미 연결된 미니맵 창이 있습니다. 기존 창을 닫고 다시 시도해 주세요.",
        };
      case "OVERLAY_NOT_FOUND":
        return {
          kind: "error",
          text: "오버레이 연결이 종료되었습니다. 미니맵을 다시 열어 주세요.",
        };
      case "INVALID_JSON":
      case "INVALID_REQUEST":
      case "INVALID_RESPONSE":
        return {
          kind: "error",
          text: "실행기 응답을 확인할 수 없어 일반 미니맵 창으로 유지합니다.",
        };
    }
  }
  return {
    kind: "error",
    text: "Windows 오버레이에 연결하지 못했습니다. 일반 미니맵 창은 계속 사용할 수 있습니다.",
  };
}

export function MapMiniMap(props: MapMiniMapProps) {
  const { settings } = useAppStore();
  const mapSettings = settings.map;
  const miniMapSize = Math.min(
    MINI_MAP_MAX_SIZE,
    Math.max(MINI_MAP_MIN_SIZE, settings.map.miniMapWindowSize),
  );
  const [pictureInPicture, setPictureInPicture] =
    useState<PictureInPictureState | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [fallbackNotice, setFallbackNotice] = useState("");
  const [isOpening, setIsOpening] = useState(false);
  const [nativeSession, setNativeSession] =
    useState<NativeOverlaySession | null>(null);
  const [nativeOverlay, setNativeOverlay] =
    useState<NativeOverlayAttachment | null>(null);
  const [nativeNotice, setNativeNotice] =
    useState<NativeOverlayNotice | null>(null);
  const [nativeBusy, setNativeBusy] = useState(false);
  const pipWindowRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);
  const closingRef = useRef(false);
  const openAttemptRef = useRef(0);
  const nativeSessionRef = useRef<NativeOverlaySession | null>(null);
  const nativeOverlayRef = useRef<NativeOverlayAttachment | null>(null);
  const nativeOpacityRef = useRef<number | null>(null);
  const nativeEventPollingAbortRef = useRef<AbortController | null>(null);
  const sessionDetectionRef = useRef<Promise<NativeOverlaySession | null> | null>(null);
  const nativeSessionCheckedRef = useRef(false);
  const pipLifecycleCleanupRef = useRef<(() => void) | null>(null);
  const isOpen = Boolean(pictureInPicture || fallbackOpen);

  const stopNativeEventPolling = useCallback(() => {
    nativeEventPollingAbortRef.current?.abort();
    nativeEventPollingAbortRef.current = null;
  }, []);

  const startNativeEventPolling = useCallback((session: NativeOverlaySession) => {
    stopNativeEventPolling();
    const controller = new AbortController();
    nativeEventPollingAbortRef.current = controller;
    void pollNativeOverlayEvents(
      session,
      controller.signal,
      window,
    ).finally(() => {
      if (nativeEventPollingAbortRef.current === controller) {
        nativeEventPollingAbortRef.current = null;
      }
    });
  }, [stopNativeEventPolling]);

  const rememberNativeOverlay = useCallback((next: NativeOverlayAttachment | null) => {
    if (!next?.globalHotkeysAvailable) stopNativeEventPolling();
    if (!next) nativeOpacityRef.current = null;
    nativeOverlayRef.current = next;
    if (mountedRef.current) setNativeOverlay(next);
  }, [stopNativeEventPolling]);

  const resolveNativeSession = useCallback(async () => {
    if (nativeSessionRef.current) return nativeSessionRef.current;
    if (sessionDetectionRef.current) return sessionDetectionRef.current;
    if (nativeSessionCheckedRef.current) return null;

    const detection = fetchNativeOverlaySession();
    sessionDetectionRef.current = detection;
    try {
      const session = await detection;
      if (session && mountedRef.current) {
        nativeSessionRef.current = session;
        setNativeSession(session);
      }
      return session;
    } finally {
      nativeSessionCheckedRef.current = true;
      if (sessionDetectionRef.current === detection) {
        sessionDetectionRef.current = null;
      }
    }
  }, []);

  const detachCurrentNativeOverlay = useCallback(async (keepalive: boolean) => {
    stopNativeEventPolling();
    const session = nativeSessionRef.current;
    const overlay = nativeOverlayRef.current;
    if (!session || !overlay) return;

    nativeOverlayRef.current = null;
    if (mountedRef.current) setNativeOverlay(null);
    try {
      await detachNativeMiniMap(
        session,
        overlay.overlayId,
        keepalive ? { keepalive: true } : {},
      );
    } catch {
      // The browser window may already be gone. The launcher also restores
      // attached windows during shutdown, so cleanup remains best-effort.
    }
  }, [stopNativeEventPolling]);

  const clearPictureInPictureLifecycle = useCallback(() => {
    const cleanup = pipLifecycleCleanupRef.current;
    pipLifecycleCleanupRef.current = null;
    cleanup?.();
  }, []);

  const registerPictureInPictureLifecycle = useCallback((pipWindow: Window) => {
    clearPictureInPictureLifecycle();
    const handlePageHide = () => {
      if (pipWindowRef.current !== pipWindow) return;
      pipWindowRef.current = null;
      openAttemptRef.current += 1;
      clearPictureInPictureLifecycle();
      void detachCurrentNativeOverlay(true);
      // PiP can disappear when the browser or native crop bridge tears down
      // the auxiliary window. Keep the feature usable by switching to the
      // in-page fallback; an explicit closeMiniMap() clears the lifecycle
      // listener first, so intentional closes still stay closed.
      if (mountedRef.current && !closingRef.current) {
        setPictureInPicture((current) =>
          current?.window === pipWindow ? null : current,
        );
        setFallbackNotice(
          "브라우저 미니맵 창이 닫혀 페이지 안 미니맵으로 전환했습니다.",
        );
        setFallbackOpen(true);
        setNativeNotice(null);
      }
    };
    const handleResize = () => {
      if (!mountedRef.current) return;
      const viewport = pictureInPictureViewport(pipWindow);
      setPictureInPicture((current) => {
        if (
          current?.window !== pipWindow ||
          (current.viewport.width === viewport.width &&
            current.viewport.height === viewport.height)
        ) {
          return current;
        }
        return { ...current, viewport };
      });
    };
    pipWindow.addEventListener("pagehide", handlePageHide);
    pipWindow.addEventListener("resize", handleResize);
    pipLifecycleCleanupRef.current = () => {
      pipWindow.removeEventListener("pagehide", handlePageHide);
      pipWindow.removeEventListener("resize", handleResize);
    };
  }, [clearPictureInPictureLifecycle, detachCurrentNativeOverlay]);

  const closeMiniMap = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    openAttemptRef.current += 1;
    const pipWindow = pipWindowRef.current;
    clearPictureInPictureLifecycle();
    await detachCurrentNativeOverlay(false);
    pipWindowRef.current = null;
    if (mountedRef.current) {
      setPictureInPicture(null);
      setFallbackOpen(false);
      setFallbackNotice("");
      setNativeNotice(null);
    }
    if (pipWindow) pipWindow.close();
    closingRef.current = false;
  }, [clearPictureInPictureLifecycle, detachCurrentNativeOverlay]);

  useEffect(() => {
    mountedRef.current = true;
    const handlePageHide = () => {
      openAttemptRef.current += 1;
      void detachCurrentNativeOverlay(true);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      mountedRef.current = false;
      openAttemptRef.current += 1;
      stopNativeEventPolling();
      const session = nativeSessionRef.current;
      const overlay = nativeOverlayRef.current;
      nativeOverlayRef.current = null;
      nativeSessionRef.current = null;
      nativeSessionCheckedRef.current = false;
      if (session && overlay) {
        void detachNativeMiniMap(
          session,
          overlay.overlayId,
          { keepalive: true },
        ).catch(() => undefined);
      }
      const pipWindow = pipWindowRef.current;
      pipWindowRef.current = null;
      clearPictureInPictureLifecycle();
      if (pipWindow) pipWindow.close();
    };
  }, [clearPictureInPictureLifecycle, detachCurrentNativeOverlay, stopNativeEventPolling]);

  useEffect(() => {
    void resolveNativeSession();
  }, [resolveNativeSession]);

  const updateNativeMode = useCallback(async (mode: NativeOverlayMode) => {
    const session = nativeSessionRef.current;
    const overlay = nativeOverlayRef.current;
    if (!session || !overlay || nativeBusy) return;

    setNativeBusy(true);
    try {
      const opacity = mapSettings.miniMapOpacity;
      const next = await updateNativeMiniMap(
        session,
        overlay.overlayId,
        mode,
        { opacity },
      );
      if (nativeOverlayRef.current?.overlayId === overlay.overlayId) {
        nativeOpacityRef.current = opacity;
        rememberNativeOverlay(next);
        setNativeNotice(nativeOverlayModeNotice(next));
      }
    } catch (error) {
      if (
        error instanceof NativeOverlayApiError &&
        error.code === "OVERLAY_NOT_FOUND"
      ) {
        rememberNativeOverlay(null);
      }
      if (mountedRef.current) setNativeNotice(nativeOverlayErrorNotice(error));
    } finally {
      if (mountedRef.current) setNativeBusy(false);
    }
  }, [mapSettings.miniMapOpacity, nativeBusy, rememberNativeOverlay]);

  useEffect(() => {
    const session = nativeSessionRef.current;
    const overlay = nativeOverlayRef.current;
    const opacity = mapSettings.miniMapOpacity;
    if (
      nativeBusy ||
      !session ||
      !overlay ||
      nativeOpacityRef.current === opacity
    ) {
      return;
    }
    nativeOpacityRef.current = opacity;
    setNativeBusy(true);
    void updateNativeMiniMap(
      session,
      overlay.overlayId,
      overlay.mode,
      { opacity },
    ).then((next) => {
      if (nativeOverlayRef.current?.overlayId === overlay.overlayId) {
        rememberNativeOverlay(next);
      }
    }).catch((error: unknown) => {
      nativeOpacityRef.current = null;
      if (mountedRef.current) setNativeNotice(nativeOverlayErrorNotice(error));
    }).finally(() => {
      if (mountedRef.current) setNativeBusy(false);
    });
  }, [mapSettings.miniMapOpacity, nativeBusy, rememberNativeOverlay]);

  const openMiniMap = async () => {
    if (isOpen) {
      await closeMiniMap();
      return;
    }
    if (isOpening) return;

    const attemptId = openAttemptRef.current + 1;
    openAttemptRef.current = attemptId;
    const isCurrentAttempt = () =>
      mountedRef.current && openAttemptRef.current === attemptId;
    setIsOpening(true);
    const controller = getPictureInPictureController();
    if (controller) {
      let session: NativeOverlaySession | null = null;
      let claimId: string | null = null;
      let nativeClaimFailed = false;
      try {
        session = await resolveNativeSession();
        if (!isCurrentAttempt()) return;
        if (!session) {
          // A static host (or an older launcher) cannot crop Chromium's
          // Document-PiP chrome. Do not open a framed PiP window in that
          // case; use the in-page overlay, which has no browser tab/title bar.
          if (mountedRef.current) {
            setNativeNotice(null);
            setFallbackNotice(
              "브라우저 상단 탭을 숨긴 페이지 안 미니맵으로 열었습니다.",
            );
            setFallbackOpen(true);
          }
          return;
        }

        setNativeNotice({ kind: "status", text: "Windows 오버레이 창 준비 중…" });
        try {
          const claim = await beginNativeOverlayClaim(session);
          claimId = claim.claimId;
        } catch (error) {
          nativeClaimFailed = true;
          if (isCurrentAttempt()) {
            setNativeNotice(nativeOverlayErrorNotice(error));
          }
        }

        if (!isCurrentAttempt()) return;
        if (session && nativeClaimFailed) {
          if (mountedRef.current) {
            setNativeNotice(null);
            setFallbackNotice(
              "브라우저 상단 탭을 숨긴 페이지 안 미니맵으로 열었습니다.",
            );
            setFallbackOpen(true);
          }
          return;
        }

        const pipWindow = await controller.requestWindow({
          width: miniMapSize,
          height: miniMapSize,
        });
        if (!isCurrentAttempt()) {
          pipWindow.close();
          return;
        }
        const root = preparePictureInPictureDocument(
          pipWindow,
          session?.windowTitle,
        );
        pipWindowRef.current = pipWindow;
        registerPictureInPictureLifecycle(pipWindow);
        setPictureInPicture({
          root,
          window: pipWindow,
          viewport: pictureInPictureViewport(pipWindow),
        });
        setFallbackNotice("");

        if (session && claimId) {
          try {
            const attached = await attachNativeMiniMap(session, claimId);
            if (
              !isCurrentAttempt() ||
              pipWindowRef.current !== pipWindow
            ) {
              await detachNativeMiniMap(
                session,
                attached.overlayId,
                { keepalive: true },
              ).catch(() => undefined);
              return;
            }
            rememberNativeOverlay(attached);
            if (attached.globalHotkeysAvailable) {
              startNativeEventPolling(session);
            }
            nativeOpacityRef.current = mapSettings.miniMapOpacity;
            const locked = await updateNativeMiniMap(
              session,
              attached.overlayId,
              "LOCKED",
              {
                width: miniMapSize,
                height: miniMapSize,
                opacity: mapSettings.miniMapOpacity,
              },
            );
            if (
              isCurrentAttempt() &&
              nativeOverlayRef.current?.overlayId === attached.overlayId
            ) {
              rememberNativeOverlay(locked);
              setNativeNotice(nativeOverlayModeNotice(locked));
            }
          } catch (error) {
            if (
              error instanceof NativeOverlayApiError &&
              error.code === "OVERLAY_NOT_FOUND"
            ) {
              rememberNativeOverlay(null);
            }
            if (isCurrentAttempt()) {
              // A regular Document-PiP window exposes the browser's own
              // title/tab chrome. If the native crop bridge cannot attach,
              // close that window and use the in-page fallback instead of
              // leaving the user with a framed mini-map.
              clearPictureInPictureLifecycle();
              const failedPipWindow = pipWindowRef.current;
              pipWindowRef.current = null;
              await detachCurrentNativeOverlay(true);
              if (mountedRef.current) {
                setPictureInPicture(null);
                setFallbackOpen(true);
                setFallbackNotice(
                  "브라우저 상단 탭을 숨긴 페이지 안 미니맵으로 열었습니다.",
                );
                setNativeNotice(null);
              }
              failedPipWindow?.close();
            }
          }
        }
        return;
      } catch {
        // A rejected PiP request falls through to the fully functional page UI.
        if (isCurrentAttempt()) setNativeNotice(null);
      } finally {
        if (isCurrentAttempt()) setIsOpening(false);
      }
    } else {
      if (isCurrentAttempt()) {
        setIsOpening(false);
        setNativeNotice(null);
      }
    }

    if (isCurrentAttempt()) {
      setFallbackNotice("페이지 안 미니맵으로 열었습니다.");
      setFallbackOpen(true);
    }
  };

  const overlayLocked = nativeOverlay?.mode === "LOCKED" ||
    nativeOverlay?.mode === "CLICK_THROUGH";
  const clickThrough = nativeOverlay?.mode === "CLICK_THROUGH";
  const nativeControlDisabled = !nativeOverlay || nativeBusy || isOpening;
  const showNativeControls = Boolean(
    nativeSession && getPictureInPictureController() && !fallbackOpen,
  );
  const fallbackStyle: MiniMapStyle = {
    "--mini-map-window-size": `${miniMapSize}px`,
  };

  return (
    <>
      <button
        aria-expanded={isOpen}
        className="map-minimap-toggle"
        disabled={isOpening}
        onClick={() => void openMiniMap()}
        type="button"
      >
        <Navigation aria-hidden="true" />
        {isOpening ? "미니맵 여는 중" : isOpen ? "미니맵 닫기" : "미니맵 열기"}
      </button>

      {showNativeControls ? (
        <div
          aria-label="미니맵 오버레이 제어"
          className="map-minimap-native-controls"
          role="group"
        >
          <button
            aria-label={overlayLocked ? "오버레이 위치 잠금 해제" : "오버레이 위치 고정"}
            aria-pressed={overlayLocked}
            className="map-minimap-native-button"
            disabled={nativeControlDisabled}
            onClick={() => void updateNativeMode(overlayLocked ? "UNLOCKED" : "LOCKED")}
            title={overlayLocked ? "위치와 크기 조정 허용" : "현재 위치에 항상 위로 고정"}
            type="button"
          >
            <Pin aria-hidden="true" />
            <span>{overlayLocked ? "위치 고정" : "이동 가능"}</span>
          </button>
          <button
            aria-label={clickThrough ? "클릭 통과 끄기" : "클릭 통과 켜기"}
            aria-pressed={clickThrough}
            className="map-minimap-native-button"
            disabled={nativeControlDisabled}
            onClick={() => void updateNativeMode(clickThrough ? "LOCKED" : "CLICK_THROUGH")}
            title={clickThrough ? "오버레이 입력 다시 받기" : "게임으로 마우스 클릭 통과"}
            type="button"
          >
            <MousePointer2 aria-hidden="true" />
            <span>클릭 통과</span>
          </button>
          {nativeNotice ? (
            <span
              className={`map-minimap-native-status ${nativeNotice.kind === "error" ? "error" : ""}`}
              role={nativeNotice.kind === "error" ? "alert" : "status"}
            >
              {nativeNotice.text}
            </span>
          ) : null}
        </div>
      ) : null}

      {fallbackOpen ? (
        <aside
          className="map-minimap-fallback"
          data-testid="map-minimap-fallback"
          style={fallbackStyle}
        >
          {fallbackNotice ? (
            <p className="map-minimap-fallback-notice" role="status">
              {fallbackNotice}
            </p>
          ) : null}
          <MiniMapSurface
            {...props}
            presentation="fallback"
            viewport={{ width: miniMapSize, height: miniMapSize }}
          />
        </aside>
      ) : null}
      {pictureInPicture
        ? createPortal(
            <MiniMapSurface
              {...props}
              nativeGlobalHotkeysAvailable={nativeOverlay?.globalHotkeysAvailable}
              nativeOverlayMode={nativeOverlay?.mode}
              presentation="pip"
              viewport={pictureInPicture.viewport}
            />,
            pictureInPicture.root,
          )
        : null}
    </>
  );
}
