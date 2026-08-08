import { useCallback, useEffect, useRef, useState } from "react";

import {
  PublicUpdateApiError,
  checkForPublicUpdate,
  fetchPublicUpdateSession,
  stagePublicUpdate,
  type PublicUpdateSession,
  type PublicUpdateStatus,
} from "../../services/public-update";

type UpdateRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PublicUpdateBusyState = "CHECK" | "STAGE" | null;

export interface PublicUpdateController {
  session: PublicUpdateSession | null;
  status: PublicUpdateStatus | null;
  initializing: boolean;
  busy: PublicUpdateBusyState;
  clientError: string | null;
  check: () => Promise<void>;
  stage: () => Promise<void>;
}

function updateErrorMessage(error: unknown): string {
  if (error instanceof PublicUpdateApiError) return error.message;
  return "업데이트 서비스에서 예상하지 못한 오류가 발생했습니다.";
}

export function usePublicUpdate(
  request: UpdateRequest = globalThis.fetch,
): PublicUpdateController {
  const [session, setSession] = useState<PublicUpdateSession | null>(null);
  const [status, setStatus] = useState<PublicUpdateStatus | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState<PublicUpdateBusyState>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    let active = true;

    void fetchPublicUpdateSession(controller.signal, request).then(async (loadedSession) => {
      if (!active) return;
      setSession(loadedSession);
      setStatus(loadedSession?.status ?? null);
      setInitializing(false);
      if (!loadedSession || loadedSession.status.state !== "IDLE" || busyRef.current) return;

      busyRef.current = true;
      setBusy("CHECK");
      try {
        const checked = await checkForPublicUpdate(loadedSession, request);
        if (active) setStatus(checked);
      } catch (error: unknown) {
        if (active) setClientError(updateErrorMessage(error));
      } finally {
        busyRef.current = false;
        if (active) setBusy(null);
      }
    });

    return () => {
      active = false;
      mountedRef.current = false;
      controller.abort();
    };
  }, [request]);

  const check = useCallback(async () => {
    if (!session || busyRef.current || session.status.state === "DISABLED") return;
    busyRef.current = true;
    setBusy("CHECK");
    setClientError(null);
    try {
      const checked = await checkForPublicUpdate(session, request);
      if (mountedRef.current) setStatus(checked);
    } catch (error: unknown) {
      if (mountedRef.current) setClientError(updateErrorMessage(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [request, session]);

  const stage = useCallback(async () => {
    if (!session || busyRef.current || status?.state !== "AVAILABLE") return;
    busyRef.current = true;
    setBusy("STAGE");
    setClientError(null);
    try {
      const staged = await stagePublicUpdate(session, status.latestVersion, request);
      if (mountedRef.current) setStatus(staged);
    } catch (error: unknown) {
      if (mountedRef.current) setClientError(updateErrorMessage(error));
    } finally {
      busyRef.current = false;
      if (mountedRef.current) setBusy(null);
    }
  }, [request, session, status]);

  return { session, status, initializing, busy, clientError, check, stage };
}
