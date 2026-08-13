import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type {
  MapConfig,
  MapFloorLocation,
  ProfileType,
  QuestData,
} from "../../types/data";
import type { ProfileState } from "../../types/state";
import {
  attachNativeOverlayWindow,
  beginNativeOverlayV2Claim,
  detachNativeOverlayWindow,
  fetchNativeOverlayV2Session,
  type NativeOverlayV2Attachment,
  type NativeOverlayV2Session,
} from "../../services/native-overlay-v2";
import { QuestOverlaySurface } from "./QuestOverlaySurface";
import "../../styles/quest-overlay.css";

const QUEST_WINDOW_NAME = "tarkov-helper-quest-list";
const QUEST_WINDOW_TITLE = "Tarkov Helper Quest List";
const QUEST_WINDOW_WIDTH = 430;
const QUEST_WINDOW_HEIGHT = 680;
const NATIVE_DETACH_CLOSE_DELAY_MS = 300;

interface QuestOverlayPortal {
  root: HTMLElement;
}

interface QuestNativeNotice {
  kind: "status" | "warning";
  text: string;
}

export interface QuestOverlayHandle {
  close: () => void;
  toggle: () => void;
}

interface QuestOverlayProps {
  activeProfile: ProfileType;
  onObjectiveChange: (objectiveId: string, completed: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  onQuestMapRouteChange: (
    questId: string,
    visible: boolean,
    selectableQuestIds?: readonly string[],
  ) => void;
  onQuestTrackedChange: (
    questId: string,
    tracked: boolean,
    selectableQuestIds?: readonly string[],
  ) => void;
  /** Injectable only so the Direct launcher boundary can be tested without a local server. */
  nativeRequest?: typeof fetch;
  /** Injectable only so popup-blocking and lifecycle behavior can be tested without real windows. */
  openPopup?: (windowName: string) => Window | null;
  profile: ProfileState;
  mapConfigs: readonly MapConfig[];
  mapFloorLocations: readonly MapFloorLocation[];
  quests: readonly QuestData[];
}

function defaultOpenPopup(windowName: string): Window | null {
  const width = QUEST_WINDOW_WIDTH;
  const height = QUEST_WINDOW_HEIGHT;
  const screenX = Number.isFinite(window.screenX) ? window.screenX : 0;
  const screenY = Number.isFinite(window.screenY) ? window.screenY : 0;
  const outerWidth = Number.isFinite(window.outerWidth) ? window.outerWidth : width + 32;
  const left = Math.max(0, Math.round(screenX + outerWidth - width - 32));
  const top = Math.max(0, Math.round(screenY + 72));
  return window.open(
    "",
    windowName,
    `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=no`,
  );
}

function copyPageStyles(targetDocument: Document): void {
  for (const stylesheet of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
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

function createQuestWindowNonce(): string | null {
  try {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
    return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  } catch {
    return null;
  }
}

function closeAfterNativeCleanup(
  cleanup: Promise<void>,
  finishClose: () => void,
): void {
  let finished = false;
  const finishOnce = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeoutId);
    finishClose();
  };
  const timeoutId = setTimeout(finishOnce, NATIVE_DETACH_CLOSE_DELAY_MS);
  void cleanup.then(finishOnce, finishOnce);
}

function preparePopupDocument(popupWindow: Window, title: string): HTMLElement {
  const popupDocument = popupWindow.document;
  popupDocument.open();
  popupDocument.write(
    "<!doctype html><html><head><meta charset=\"UTF-8\"></head><body></body></html>",
  );
  popupDocument.close();
  popupDocument.title = title;
  popupDocument.documentElement.lang = document.documentElement.lang || "ko";
  popupDocument.documentElement.style.width = "100%";
  popupDocument.documentElement.style.height = "100%";
  popupDocument.body.style.width = "100%";
  popupDocument.body.style.height = "100%";
  popupDocument.body.style.margin = "0";
  popupDocument.body.style.overflow = "hidden";
  copyPageStyles(popupDocument);

  const root = popupDocument.createElement("div");
  root.className = "quest-overlay-popup-root";
  popupDocument.body.append(root);
  return root;
}

export const QuestOverlay = forwardRef<QuestOverlayHandle, QuestOverlayProps>(
  function QuestOverlay({
    activeProfile,
    onObjectiveChange,
    onOpenChange,
    onQuestMapRouteChange,
    onQuestTrackedChange,
    nativeRequest = globalThis.fetch,
    openPopup = defaultOpenPopup,
    profile,
    mapConfigs,
    mapFloorLocations,
    quests,
  }, ref) {
    const [portal, setPortal] = useState<QuestOverlayPortal | null>(null);
    const [fallbackOpen, setFallbackOpen] = useState(false);
    const [isOpening, setIsOpening] = useState(false);
    const [nativeNotice, setNativeNotice] = useState<QuestNativeNotice>();
    const popupRef = useRef<Window | null>(null);
    const fallbackOpenRef = useRef(false);
    const lifecycleCleanupRef = useRef<(() => void) | null>(null);
    const nativeSessionRef = useRef<NativeOverlayV2Session | null>(null);
    const nativeSessionPromiseRef = useRef<Promise<NativeOverlayV2Session | null> | null>(null);
    const nativeSessionCheckedRef = useRef(false);
    const nativeAttachmentRef = useRef<NativeOverlayV2Attachment | null>(null);
    const openingRef = useRef(false);
    const openAttemptRef = useRef(0);
    const mountedRef = useRef(true);
    const openerRef = useRef<HTMLElement | null>(null);
    const fallbackSurfaceRef = useRef<HTMLElement>(null);
    const popupSurfaceRef = useRef<HTMLElement>(null);

    const setFallback = useCallback((open: boolean) => {
      fallbackOpenRef.current = open;
      if (mountedRef.current) setFallbackOpen(open);
    }, []);

    const clearLifecycle = useCallback(() => {
      const cleanup = lifecycleCleanupRef.current;
      lifecycleCleanupRef.current = null;
      cleanup?.();
    }, []);

    const resolveNativeSession = useCallback(async () => {
      if (nativeSessionRef.current) return nativeSessionRef.current;
      if (nativeSessionPromiseRef.current) return nativeSessionPromiseRef.current;
      if (nativeSessionCheckedRef.current) return null;

      const detection = fetchNativeOverlayV2Session(undefined, nativeRequest);
      nativeSessionPromiseRef.current = detection;
      try {
        const session = await detection;
        nativeSessionRef.current = session;
        return session;
      } finally {
        nativeSessionCheckedRef.current = true;
        if (nativeSessionPromiseRef.current === detection) {
          nativeSessionPromiseRef.current = null;
        }
      }
    }, [nativeRequest]);

    const detachNativeOverlay = useCallback(async (keepalive: boolean) => {
      const session = nativeSessionRef.current;
      const attachment = nativeAttachmentRef.current;
      nativeAttachmentRef.current = null;
      if (!session || !attachment) return;
      try {
        await detachNativeOverlayWindow(
          session,
          "quest-list",
          attachment.overlayId,
          keepalive ? { keepalive: true } : {},
          nativeRequest,
        );
      } catch {
        // The popup may already be closing. The launcher also restores every
        // attached window during shutdown, so lifecycle cleanup is best-effort.
      }
    }, [nativeRequest]);

    const restoreOpenerFocus = useCallback(() => {
      const opener = openerRef.current;
      openerRef.current = null;
      if (
        opener?.isConnected &&
        !opener.closest('[aria-hidden="true"]') &&
        getComputedStyle(opener).visibility !== "hidden"
      ) {
        opener.focus();
        return;
      }
      document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
    }, []);

    const close = useCallback(() => {
      openAttemptRef.current += 1;
      const wasOpen = Boolean(
        openingRef.current || popupRef.current || fallbackOpenRef.current,
      );
      openingRef.current = false;
      if (mountedRef.current) setIsOpening(false);
      clearLifecycle();
      const popup = popupRef.current;
      popupRef.current = null;
      if (mountedRef.current) setPortal(null);
      setFallback(false);
      if (mountedRef.current) setNativeNotice(undefined);
      const finishClose = () => {
        if (popup && !popup.closed) popup.close();
        if (wasOpen) queueMicrotask(restoreOpenerFocus);
      };
      if (nativeAttachmentRef.current) {
        closeAfterNativeCleanup(detachNativeOverlay(false), finishClose);
      } else {
        finishClose();
      }
    }, [clearLifecycle, detachNativeOverlay, restoreOpenerFocus, setFallback]);

    const open = useCallback(async () => {
      const existing = popupRef.current;
      if (existing && !existing.closed) {
        existing.focus();
        return;
      }
      if (fallbackOpenRef.current || openingRef.current) return;

      openerRef.current = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
      const attemptId = openAttemptRef.current + 1;
      openAttemptRef.current = attemptId;
      const isCurrentAttempt = () =>
        mountedRef.current && openAttemptRef.current === attemptId;
      openingRef.current = true;
      setIsOpening(true);

      const windowNonce = createQuestWindowNonce();
      const pendingTitle = windowNonce
        ? `${QUEST_WINDOW_TITLE} [${windowNonce}]`
        : QUEST_WINDOW_TITLE;
      let popup: Window | null = null;
      try {
        popup = openPopup(
          windowNonce ? `${QUEST_WINDOW_NAME}-${windowNonce}` : QUEST_WINDOW_NAME,
        );
        if (!popup) {
          openingRef.current = false;
          setIsOpening(false);
          setNativeNotice(undefined);
          setFallback(true);
          return;
        }
        const root = preparePopupDocument(popup, pendingTitle);
        const handlePageHide = () => {
          if (popupRef.current !== popup) return;
          popupRef.current = null;
          openingRef.current = false;
          openAttemptRef.current += 1;
          clearLifecycle();
          if (mountedRef.current) setPortal(null);
          setFallback(false);
          setNativeNotice(undefined);
          void detachNativeOverlay(true);
          queueMicrotask(restoreOpenerFocus);
        };
        const handlePopupKeyDown = (event: KeyboardEvent) => {
          if (event.key !== "Escape" || popup?.document.querySelector("dialog[open]")) return;
          event.preventDefault();
          close();
        };
        popup.addEventListener("pagehide", handlePageHide);
        popup.document.addEventListener("keydown", handlePopupKeyDown);
        lifecycleCleanupRef.current = () => {
          popup?.removeEventListener("pagehide", handlePageHide);
          popup?.document.removeEventListener("keydown", handlePopupKeyDown);
        };
        popupRef.current = popup;
        setFallback(false);
        if (mountedRef.current) setPortal({ root });
        popup.focus();

        const session = windowNonce ? await resolveNativeSession() : null;
        if (!isCurrentAttempt() || popupRef.current !== popup || popup.closed) return;
        if (!session || !windowNonce) {
          popup.document.title = QUEST_WINDOW_TITLE;
          setNativeNotice({
            kind: "status",
            text: "일반 브라우저 창입니다 · 항상 위 기능은 바로 실행 버전에서 지원됩니다.",
          });
          return;
        }

        setNativeNotice({ kind: "status", text: "화면 위 퀘스트 창 준비 중…" });
        try {
          const claim = await beginNativeOverlayV2Claim(
            session,
            "quest-list",
            { windowNonce },
            nativeRequest,
          );
          if (!isCurrentAttempt() || popupRef.current !== popup || popup.closed) return;
          popup.document.title = QUEST_WINDOW_TITLE;
          const attachment = await attachNativeOverlayWindow(
            session,
            "quest-list",
            claim.claimId,
            nativeRequest,
          );
          if (!isCurrentAttempt() || popupRef.current !== popup || popup.closed) {
            await detachNativeOverlayWindow(
              session,
              "quest-list",
              attachment.overlayId,
              { keepalive: true },
              nativeRequest,
            ).catch(() => undefined);
            if (!popup.closed) popup.close();
            return;
          }
          nativeAttachmentRef.current = attachment;
          setNativeNotice({ kind: "status", text: "화면 위에 표시됨 · 이동 가능" });
        } catch {
          popup.document.title = QUEST_WINDOW_TITLE;
          await detachNativeOverlay(false);
          if (isCurrentAttempt()) {
            setNativeNotice({
              kind: "warning",
              text: "화면 위 연결을 사용할 수 없어 일반 퀘스트 창으로 열었습니다.",
            });
          }
        }
      } catch {
        if (popup && !popup.closed) popup.close();
        popupRef.current = null;
        clearLifecycle();
        if (mountedRef.current) setPortal(null);
        setNativeNotice(undefined);
        setFallback(true);
      } finally {
        if (isCurrentAttempt()) {
          openingRef.current = false;
          setIsOpening(false);
        }
      }
    }, [
      clearLifecycle,
      close,
      detachNativeOverlay,
      nativeRequest,
      openPopup,
      resolveNativeSession,
      restoreOpenerFocus,
      setFallback,
    ]);

    const toggle = useCallback(() => {
      if (
        openingRef.current ||
        (popupRef.current && !popupRef.current.closed) ||
        fallbackOpenRef.current
      ) {
        close();
      } else {
        void open();
      }
    }, [close, open]);

    useImperativeHandle(ref, () => ({ close, toggle }), [close, toggle]);

    useEffect(() => {
      onOpenChange?.(Boolean(isOpening || portal || fallbackOpen));
    }, [fallbackOpen, isOpening, onOpenChange, portal]);

    useEffect(() => {
      if (!fallbackOpen) return;
      fallbackSurfaceRef.current?.focus();
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
        event.preventDefault();
        close();
      };
      document.addEventListener("keydown", handleKeyDown);
      return () => document.removeEventListener("keydown", handleKeyDown);
    }, [close, fallbackOpen]);

    useEffect(() => {
      if (!portal) return;
      popupSurfaceRef.current?.focus();
    }, [portal]);

    useEffect(() => {
      const handleOpenerPageHide = () => {
        openAttemptRef.current += 1;
        openingRef.current = false;
        clearLifecycle();
        void detachNativeOverlay(true);
        const popup = popupRef.current;
        popupRef.current = null;
        if (popup && !popup.closed) popup.close();
        if (mountedRef.current) {
          setIsOpening(false);
          setPortal(null);
          setFallback(false);
          setNativeNotice(undefined);
        }
      };
      window.addEventListener("pagehide", handleOpenerPageHide);
      return () => window.removeEventListener("pagehide", handleOpenerPageHide);
    }, [clearLifecycle, detachNativeOverlay, setFallback]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        openingRef.current = false;
        openAttemptRef.current += 1;
        clearLifecycle();
        void detachNativeOverlay(true);
        const popup = popupRef.current;
        popupRef.current = null;
        if (popup && !popup.closed) popup.close();
      };
    }, [clearLifecycle, detachNativeOverlay]);

    const surface = (
      <QuestOverlaySurface
        activeProfile={activeProfile}
        onClose={close}
        onObjectiveChange={onObjectiveChange}
        onQuestMapRouteChange={onQuestMapRouteChange}
        onQuestTrackedChange={onQuestTrackedChange}
        presentation={portal ? "popup" : "dock"}
        profile={profile}
        mapConfigs={mapConfigs}
        mapFloorLocations={mapFloorLocations}
        nativeNotice={portal ? nativeNotice : undefined}
        quests={quests}
        surfaceRef={portal ? popupSurfaceRef : fallbackOpen ? fallbackSurfaceRef : undefined}
      />
    );

    return (
      <>
        {fallbackOpen ? createPortal(surface, document.body) : null}
        {portal ? createPortal(surface, portal.root) : null}
      </>
    );
  },
);
