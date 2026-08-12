import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { ProfileType, QuestData } from "../../types/data";
import type { ProfileState } from "../../types/state";
import { QuestOverlaySurface } from "./QuestOverlaySurface";
import "../../styles/quest-overlay.css";

const QUEST_WINDOW_NAME = "tarkov-helper-quest-list";
const QUEST_WINDOW_TITLE = "타르코프 헬퍼 퀘스트 창";

interface QuestOverlayPortal {
  root: HTMLElement;
}

export interface QuestOverlayHandle {
  close: () => void;
  toggle: () => void;
}

interface QuestOverlayProps {
  activeProfile: ProfileType;
  onObjectiveChange: (objectiveId: string, completed: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  onQuestTrackedChange: (questId: string, tracked: boolean) => void;
  /** Injectable only so popup-blocking and lifecycle behavior can be tested without real windows. */
  openPopup?: () => Window | null;
  profile: ProfileState;
  quests: readonly QuestData[];
}

function defaultOpenPopup(): Window | null {
  const width = 430;
  const height = 680;
  const screenX = Number.isFinite(window.screenX) ? window.screenX : 0;
  const screenY = Number.isFinite(window.screenY) ? window.screenY : 0;
  const outerWidth = Number.isFinite(window.outerWidth) ? window.outerWidth : width + 32;
  const left = Math.max(0, Math.round(screenX + outerWidth - width - 32));
  const top = Math.max(0, Math.round(screenY + 72));
  return window.open(
    "",
    QUEST_WINDOW_NAME,
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

function preparePopupDocument(popupWindow: Window): HTMLElement {
  const popupDocument = popupWindow.document;
  popupDocument.open();
  popupDocument.write(
    "<!doctype html><html><head><meta charset=\"UTF-8\"></head><body></body></html>",
  );
  popupDocument.close();
  popupDocument.title = QUEST_WINDOW_TITLE;
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
    onQuestTrackedChange,
    openPopup = defaultOpenPopup,
    profile,
    quests,
  }, ref) {
    const [portal, setPortal] = useState<QuestOverlayPortal | null>(null);
    const [fallbackOpen, setFallbackOpen] = useState(false);
    const popupRef = useRef<Window | null>(null);
    const fallbackOpenRef = useRef(false);
    const lifecycleCleanupRef = useRef<(() => void) | null>(null);
    const mountedRef = useRef(true);

    const setFallback = useCallback((open: boolean) => {
      fallbackOpenRef.current = open;
      if (mountedRef.current) setFallbackOpen(open);
    }, []);

    const clearLifecycle = useCallback(() => {
      const cleanup = lifecycleCleanupRef.current;
      lifecycleCleanupRef.current = null;
      cleanup?.();
    }, []);

    const close = useCallback(() => {
      clearLifecycle();
      const popup = popupRef.current;
      popupRef.current = null;
      if (mountedRef.current) setPortal(null);
      setFallback(false);
      if (popup && !popup.closed) popup.close();
    }, [clearLifecycle, setFallback]);

    const open = useCallback(() => {
      const existing = popupRef.current;
      if (existing && !existing.closed) {
        existing.focus();
        return;
      }
      if (fallbackOpenRef.current) return;

      let popup: Window | null = null;
      try {
        popup = openPopup();
        if (!popup) {
          setFallback(true);
          return;
        }
        const root = preparePopupDocument(popup);
        const handlePageHide = () => {
          if (popupRef.current !== popup) return;
          popupRef.current = null;
          clearLifecycle();
          if (mountedRef.current) setPortal(null);
          setFallback(false);
        };
        popup.addEventListener("pagehide", handlePageHide);
        lifecycleCleanupRef.current = () => {
          popup?.removeEventListener("pagehide", handlePageHide);
        };
        popupRef.current = popup;
        setFallback(false);
        if (mountedRef.current) setPortal({ root });
        popup.focus();
      } catch {
        if (popup && !popup.closed) popup.close();
        popupRef.current = null;
        clearLifecycle();
        if (mountedRef.current) setPortal(null);
        setFallback(true);
      }
    }, [clearLifecycle, openPopup, setFallback]);

    const toggle = useCallback(() => {
      if ((popupRef.current && !popupRef.current.closed) || fallbackOpenRef.current) {
        close();
      } else {
        open();
      }
    }, [close, open]);

    useImperativeHandle(ref, () => ({ close, toggle }), [close, toggle]);

    useEffect(() => {
      onOpenChange?.(Boolean(portal || fallbackOpen));
    }, [fallbackOpen, onOpenChange, portal]);

    useEffect(() => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        clearLifecycle();
        const popup = popupRef.current;
        popupRef.current = null;
        if (popup && !popup.closed) popup.close();
      };
    }, [clearLifecycle]);

    const surface = (
      <QuestOverlaySurface
        activeProfile={activeProfile}
        onClose={close}
        onObjectiveChange={onObjectiveChange}
        onQuestTrackedChange={onQuestTrackedChange}
        presentation={portal ? "popup" : "dock"}
        profile={profile}
        quests={quests}
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
