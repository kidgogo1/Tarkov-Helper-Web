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
  LocateFixed,
  MousePointer2,
  Minus,
  Navigation,
  Pin,
  Plus,
  RotateCcw,
  Scan,
  X,
} from "lucide-react";

import { useAppStore } from "../../app/store";
import {
  applySvgFloorVisibility,
  getMapDirectionAngle,
} from "../../domain/map";
import type { MapConfig, MapFloor } from "../../types/data";
import {
  NativeOverlayApiError,
  attachNativeMiniMap,
  beginNativeOverlayClaim,
  detachNativeMiniMap,
  fetchNativeOverlaySession,
  updateNativeMiniMap,
  type NativeOverlayAttachment,
  type NativeOverlayMode,
  type NativeOverlaySession,
} from "../../services/native-overlay";
import "../../styles/minimap.css";

const MINI_MAP_SIZE = 300;
const ZOOM_STEP = 0.1;

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
  pipDocument.body.style.width = "100%";
  pipDocument.body.style.height = "100%";
  pipDocument.body.style.margin = "0";
  pipDocument.body.style.overflow = "hidden";
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
  nativeOverlayMode?: NativeOverlayMode;
  onClose: () => void;
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

function MiniMapSurface({
  config,
  orderedFloors,
  selectedFloor,
  player,
  playerMarkerSize,
  nativeOverlayMode,
  onClose,
  presentation,
  viewport,
}: MiniMapSurfaceProps) {
  const { settings, updateMapSettings } = useAppStore();
  const mapSettings = settings.map;
  const mapObjectRef = useRef<HTMLObjectElement>(null);
  const panGestureRef = useRef<PanGesture | null>(null);
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
    "--mini-map-opacity": String(mapSettings.miniMapOpacity),
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
      aria-label={`${config.displayName} 미니맵`}
      className={`map-minimap map-minimap--${presentation}`}
      data-native-overlay={nativeOverlayMode ?? undefined}
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

      <header className="map-minimap-header">
        <strong>{config.displayName}</strong>
        <div className="map-minimap-actions">
          <button
            aria-label={tracking ? "고정 뷰로 전환" : "플레이어 추적 뷰로 전환"}
            className="map-minimap-icon-button"
            onClick={() => updateMapSettings({
              miniMapViewMode: tracking ? "fixed" : "playerTracking",
            })}
            title={tracking ? "고정 뷰로 전환" : "플레이어 추적 뷰로 전환"}
            type="button"
          >
            {tracking ? <Scan aria-hidden="true" /> : <LocateFixed aria-hidden="true" />}
          </button>
          <button
            aria-label="미니맵 축소"
            className="map-minimap-icon-button"
            onClick={() => updateMapSettings({
              miniMapZoom: mapSettings.miniMapZoom - ZOOM_STEP,
            })}
            type="button"
          >
            <Minus aria-hidden="true" />
          </button>
          <span className="map-minimap-zoom" aria-label="미니맵 확대율">
            {Math.round(mapSettings.miniMapZoom * 100)}%
          </span>
          <button
            aria-label="미니맵 확대"
            className="map-minimap-icon-button"
            onClick={() => updateMapSettings({
              miniMapZoom: mapSettings.miniMapZoom + ZOOM_STEP,
            })}
            type="button"
          >
            <Plus aria-hidden="true" />
          </button>
          <button
            aria-label="미니맵 위치 초기화"
            className="map-minimap-icon-button"
            disabled={
              mapSettings.miniMapOffsetX === 0 &&
              mapSettings.miniMapOffsetY === 0
            }
            onClick={() => updateMapSettings({
              miniMapOffsetX: 0,
              miniMapOffsetY: 0,
            })}
            type="button"
          >
            <RotateCcw aria-hidden="true" />
          </button>
          <button
            aria-label="미니맵 닫기"
            className="map-minimap-icon-button"
            onClick={onClose}
            type="button"
          >
            <X aria-hidden="true" />
          </button>
        </div>
      </header>

      <details className="map-minimap-settings">
        <summary>표시 설정</summary>
        <label>
          <span>투명도 {Math.round(mapSettings.miniMapOpacity * 100)}%</span>
          <input
            aria-label="미니맵 투명도"
            max="100"
            min="10"
            onChange={(event) => updateMapSettings({
              miniMapOpacity: Number(event.currentTarget.value) / 100,
            })}
            type="range"
            value={Math.round(mapSettings.miniMapOpacity * 100)}
          />
        </label>
        <label>
          <span>
            플레이어 크기 {Math.round(mapSettings.miniMapPlayerMarkerScale * 100)}%
          </span>
          <input
            aria-label="미니맵 플레이어 크기"
            max="300"
            min="50"
            onChange={(event) => updateMapSettings({
              miniMapPlayerMarkerScale: Number(event.currentTarget.value) / 100,
            })}
            type="range"
            value={Math.round(mapSettings.miniMapPlayerMarkerScale * 100)}
          />
        </label>
      </details>

      <p className="map-minimap-browser-note">
        {nativeOverlayMode
          ? "오버레이 위치와 클릭 통과는 메인 지도에서 언제든 해제할 수 있습니다."
          : "고정 뷰: 가운데 버튼 드래그 · 클릭 투과와 전역 단축키는 브라우저에서 지원하지 않습니다."}
      </p>
    </section>
  );
}

interface NativeOverlayNotice {
  kind: "status" | "error";
  text: string;
}

function nativeOverlayModeNotice(mode: NativeOverlayMode): NativeOverlayNotice {
  switch (mode) {
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
  const nativeSessionRef = useRef<NativeOverlaySession | null>(null);
  const nativeOverlayRef = useRef<NativeOverlayAttachment | null>(null);
  const sessionDetectionRef = useRef<Promise<NativeOverlaySession | null> | null>(null);
  const nativeSessionCheckedRef = useRef(false);
  const isOpen = Boolean(pictureInPicture || fallbackOpen);
  const activePipWindow = pictureInPicture?.window;

  const rememberNativeOverlay = useCallback((next: NativeOverlayAttachment | null) => {
    nativeOverlayRef.current = next;
    if (mountedRef.current) setNativeOverlay(next);
  }, []);

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
  }, []);

  const closeMiniMap = useCallback(async () => {
    if (closingRef.current) return;
    closingRef.current = true;
    const pipWindow = pipWindowRef.current;
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
  }, [detachCurrentNativeOverlay]);

  useEffect(() => {
    mountedRef.current = true;
    const handlePageHide = () => {
      void detachCurrentNativeOverlay(true);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      mountedRef.current = false;
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
      if (pipWindow) pipWindow.close();
    };
  }, [detachCurrentNativeOverlay]);

  useEffect(() => {
    void resolveNativeSession();
  }, [resolveNativeSession]);

  useEffect(() => {
    if (!activePipWindow) return;

    const handlePageHide = () => {
      if (pipWindowRef.current === activePipWindow) {
        pipWindowRef.current = null;
      }
      void detachCurrentNativeOverlay(true);
      setPictureInPicture((current) =>
        current?.window === activePipWindow ? null : current,
      );
    };
    const handleResize = () => {
      const viewport = pictureInPictureViewport(activePipWindow);
      setPictureInPicture((current) => {
        if (
          current?.window !== activePipWindow ||
          (current.viewport.width === viewport.width &&
            current.viewport.height === viewport.height)
        ) {
          return current;
        }
        return { ...current, viewport };
      });
    };
    activePipWindow.addEventListener("pagehide", handlePageHide);
    activePipWindow.addEventListener("resize", handleResize);
    handleResize();
    return () => {
      activePipWindow.removeEventListener("pagehide", handlePageHide);
      activePipWindow.removeEventListener("resize", handleResize);
    };
  }, [activePipWindow, detachCurrentNativeOverlay]);

  const updateNativeMode = useCallback(async (mode: NativeOverlayMode) => {
    const session = nativeSessionRef.current;
    const overlay = nativeOverlayRef.current;
    if (!session || !overlay || nativeBusy) return;

    setNativeBusy(true);
    try {
      const next = await updateNativeMiniMap(
        session,
        overlay.overlayId,
        mode,
      );
      if (nativeOverlayRef.current?.overlayId === overlay.overlayId) {
        rememberNativeOverlay(next);
        setNativeNotice(nativeOverlayModeNotice(next.mode));
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
  }, [nativeBusy, rememberNativeOverlay]);

  const openMiniMap = async () => {
    if (isOpen) {
      await closeMiniMap();
      return;
    }
    if (isOpening) return;

    setIsOpening(true);
    const controller = getPictureInPictureController();
    if (controller) {
      let session: NativeOverlaySession | null = null;
      let claimId: string | null = null;
      try {
        session = await resolveNativeSession();
        if (session) {
          setNativeNotice({ kind: "status", text: "Windows 오버레이 창 준비 중…" });
          try {
            const claim = await beginNativeOverlayClaim(session);
            claimId = claim.claimId;
          } catch (error) {
            setNativeNotice(nativeOverlayErrorNotice(error));
          }
        }

        const pipWindow = await controller.requestWindow({
          width: MINI_MAP_SIZE,
          height: MINI_MAP_SIZE,
        });
        const root = preparePictureInPictureDocument(
          pipWindow,
          session?.windowTitle,
        );
        if (!mountedRef.current) {
          pipWindow.close();
          return;
        }
        pipWindowRef.current = pipWindow;
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
              !mountedRef.current ||
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
            const locked = await updateNativeMiniMap(
              session,
              attached.overlayId,
              "LOCKED",
              { width: MINI_MAP_SIZE, height: MINI_MAP_SIZE },
            );
            if (nativeOverlayRef.current?.overlayId === attached.overlayId) {
              rememberNativeOverlay(locked);
              setNativeNotice(nativeOverlayModeNotice(locked.mode));
            }
          } catch (error) {
            if (mountedRef.current) {
              setNativeNotice(nativeOverlayErrorNotice(error));
            }
          }
        }
        return;
      } catch {
        // A rejected PiP request falls through to the fully functional page UI.
      } finally {
        if (mountedRef.current) setIsOpening(false);
      }
    } else {
      setIsOpening(false);
    }

    if (mountedRef.current) {
      setFallbackNotice("페이지 안 미니맵으로 열었습니다.");
      setFallbackOpen(true);
    }
  };

  const overlayLocked = nativeOverlay?.mode === "LOCKED" ||
    nativeOverlay?.mode === "CLICK_THROUGH";
  const clickThrough = nativeOverlay?.mode === "CLICK_THROUGH";
  const nativeControlDisabled = !nativeOverlay || nativeBusy || isOpening;

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

      {nativeSession ? (
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
        >
          {fallbackNotice ? (
            <p className="map-minimap-fallback-notice" role="status">
              {fallbackNotice}
            </p>
          ) : null}
          <MiniMapSurface
            {...props}
            onClose={() => void closeMiniMap()}
            presentation="fallback"
            viewport={{ width: MINI_MAP_SIZE, height: MINI_MAP_SIZE }}
          />
        </aside>
      ) : null}
      {pictureInPicture
        ? createPortal(
            <MiniMapSurface
              {...props}
              nativeOverlayMode={nativeOverlay?.mode}
              onClose={() => void closeMiniMap()}
              presentation="pip"
              viewport={pictureInPicture.viewport}
            />,
            pictureInPicture.root,
          )
        : null}
    </>
  );
}
