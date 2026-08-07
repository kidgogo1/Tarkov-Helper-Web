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
  Minus,
  Navigation,
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
import "../../styles/minimap.css";

const MINI_MAP_SIZE = 300;
const ZOOM_STEP = 0.1;

interface DocumentPictureInPictureController {
  requestWindow: (options: { width: number; height: number }) => Promise<Window>;
}

interface PictureInPictureState {
  root: HTMLElement;
  window: Window;
}

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

function preparePictureInPictureDocument(pipWindow: Window): HTMLElement {
  const pipDocument = pipWindow.document;
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

function clampMapTranslation(translation: number, scaledMapSize: number): number {
  const minimum = MINI_MAP_SIZE * 0.25 - scaledMapSize;
  const maximum = MINI_MAP_SIZE * 0.75;
  return Math.min(maximum, Math.max(minimum, translation));
}

interface MiniMapSurfaceProps extends MapMiniMapProps {
  onClose: () => void;
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
  onClose,
}: MiniMapSurfaceProps) {
  const { settings, updateMapSettings } = useAppStore();
  const mapSettings = settings.map;
  const mapObjectRef = useRef<HTMLObjectElement>(null);
  const panGestureRef = useRef<PanGesture | null>(null);
  const mapWidth = Math.max(1, config.imageWidth);
  const mapHeight = Math.max(1, config.imageHeight);
  const fitScale = Math.min(MINI_MAP_SIZE / mapWidth, MINI_MAP_SIZE / mapHeight);
  const scale = fitScale * mapSettings.miniMapZoom;
  const tracking = mapSettings.miniMapViewMode === "playerTracking";
  const centeredX = (MINI_MAP_SIZE - mapWidth * scale) / 2;
  const centeredY = (MINI_MAP_SIZE - mapHeight * scale) / 2;
  const fixedX = clampMapTranslation(
    centeredX + mapSettings.miniMapOffsetX,
    mapWidth * scale,
  );
  const fixedY = clampMapTranslation(
    centeredY + mapSettings.miniMapOffsetY,
    mapHeight * scale,
  );
  const normalizedOffsetX = fixedX - centeredX;
  const normalizedOffsetY = fixedY - centeredY;
  const x = tracking && player
    ? MINI_MAP_SIZE / 2 - player.screen.x * scale
    : tracking ? centeredX : fixedX;
  const y = tracking && player
    ? MINI_MAP_SIZE / 2 - player.screen.y * scale
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
      className="map-minimap"
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
        고정 뷰: 가운데 버튼 드래그 · 클릭 투과와 전역 단축키는 브라우저에서 지원하지 않습니다.
      </p>
    </section>
  );
}

export function MapMiniMap(props: MapMiniMapProps) {
  const [pictureInPicture, setPictureInPicture] =
    useState<PictureInPictureState | null>(null);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [fallbackNotice, setFallbackNotice] = useState("");
  const [isOpening, setIsOpening] = useState(false);
  const pipWindowRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);
  const isOpen = Boolean(pictureInPicture || fallbackOpen);

  const closeMiniMap = useCallback(() => {
    const pipWindow = pipWindowRef.current;
    pipWindowRef.current = null;
    setPictureInPicture(null);
    setFallbackOpen(false);
    setFallbackNotice("");
    if (pipWindow) pipWindow.close();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const pipWindow = pipWindowRef.current;
      pipWindowRef.current = null;
      if (pipWindow) pipWindow.close();
    };
  }, []);

  useEffect(() => {
    if (!pictureInPicture) return;

    const handlePageHide = () => {
      if (pipWindowRef.current === pictureInPicture.window) {
        pipWindowRef.current = null;
      }
      setPictureInPicture((current) =>
        current?.window === pictureInPicture.window ? null : current,
      );
    };
    pictureInPicture.window.addEventListener("pagehide", handlePageHide);
    return () => {
      pictureInPicture.window.removeEventListener("pagehide", handlePageHide);
    };
  }, [pictureInPicture]);

  const openMiniMap = async () => {
    if (isOpen) {
      closeMiniMap();
      return;
    }
    if (isOpening) return;

    setIsOpening(true);
    const controller = getPictureInPictureController();
    if (controller) {
      try {
        const pipWindow = await controller.requestWindow({
          width: MINI_MAP_SIZE,
          height: MINI_MAP_SIZE,
        });
        const root = preparePictureInPictureDocument(pipWindow);
        if (!mountedRef.current) {
          pipWindow.close();
          return;
        }
        pipWindowRef.current = pipWindow;
        setPictureInPicture({ root, window: pipWindow });
        setFallbackNotice("");
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

  const surface = isOpen ? (
    <MiniMapSurface {...props} onClose={closeMiniMap} />
  ) : null;

  return (
    <>
      <button
        aria-expanded={isOpen}
        className="map-minimap-toggle"
        disabled={isOpening}
        onClick={openMiniMap}
        type="button"
      >
        <Navigation aria-hidden="true" />
        {isOpening ? "미니맵 여는 중" : isOpen ? "미니맵 닫기" : "미니맵 열기"}
      </button>

      {fallbackOpen && surface ? (
        <aside
          className="map-minimap-fallback"
          data-testid="map-minimap-fallback"
        >
          {fallbackNotice ? (
            <p className="map-minimap-fallback-notice" role="status">
              {fallbackNotice}
            </p>
          ) : null}
          {surface}
        </aside>
      ) : null}
      {pictureInPicture && surface
        ? createPortal(surface, pictureInPicture.root)
        : null}
    </>
  );
}
