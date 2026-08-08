import { useCallback, useEffect, useRef, useState } from "react";

import {
  PublicUpdateApiError,
  checkForPublicUpdate,
  fetchPublicUpdateSession,
  fetchPublicUpdateStatus,
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

function isPendingStatus(status: PublicUpdateStatus): boolean {
  return status.state === "CHECKING" ||
    status.state === "DOWNLOADING" ||
    status.state === "VERIFYING" ||
    status.state === "APPLYING" ||
    status.state === "ROLLING_BACK";
}

function waitForNextPoll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 250);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollUntilSettled(
  session: PublicUpdateSession,
  initialStatus: PublicUpdateStatus,
  signal: AbortSignal,
  request: UpdateRequest,
): Promise<PublicUpdateStatus> {
  let current = initialStatus;
  for (let attempt = 0; isPendingStatus(current) && attempt < 7_200; attempt += 1) {
    if (attempt > 0) await waitForNextPoll(signal);
    current = await fetchPublicUpdateStatus(session, signal, request);
  }
  if (isPendingStatus(current)) {
    throw new PublicUpdateApiError("POLL_TIMEOUT", "업데이트 작업이 제한 시간 안에 끝나지 않았습니다.");
  }
  return current;
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
  const operationControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    let active = true;

    void fetchPublicUpdateSession(controller.signal, request).then(async (loadedSession) => {
      if (!active) return;
      setSession(loadedSession);
      setStatus(loadedSession?.status ?? null);
      setInitializing(false);
      if (
        !loadedSession ||
        loadedSession.status.state === "DISABLED" ||
        (loadedSession.status.state !== "IDLE" && !isPendingStatus(loadedSession.status)) ||
        busyRef.current
      ) return;

      busyRef.current = true;
      const operation = loadedSession.status.state === "IDLE" ||
        loadedSession.status.state === "CHECKING"
        ? "CHECK"
        : "STAGE";
      setBusy(operation);
      operationControllerRef.current = controller;
      try {
        const initial = loadedSession.status.state === "IDLE"
          ? await checkForPublicUpdate(loadedSession, request)
          : loadedSession.status;
        const settled = isPendingStatus(initial)
          ? await pollUntilSettled(loadedSession, initial, controller.signal, request)
          : initial;
        if (active) setStatus(settled);
      } catch (error: unknown) {
        if (active && !(error instanceof DOMException && error.name === "AbortError")) {
          setClientError(updateErrorMessage(error));
        }
      } finally {
        busyRef.current = false;
        operationControllerRef.current = null;
        if (active) setBusy(null);
      }
    });

    return () => {
      active = false;
      mountedRef.current = false;
      operationControllerRef.current?.abort();
      controller.abort();
    };
  }, [request]);

  const check = useCallback(async () => {
    if (!session || busyRef.current || session.status.state === "DISABLED") return;
    busyRef.current = true;
    setBusy("CHECK");
    setClientError(null);
    const controller = new AbortController();
    operationControllerRef.current = controller;
    try {
      const checking = await checkForPublicUpdate(session, request);
      const settled = isPendingStatus(checking)
        ? await pollUntilSettled(session, checking, controller.signal, request)
        : checking;
      if (mountedRef.current) setStatus(settled);
    } catch (error: unknown) {
      if (mountedRef.current) setClientError(updateErrorMessage(error));
    } finally {
      busyRef.current = false;
      operationControllerRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  }, [request, session]);

  const stage = useCallback(async () => {
    if (!session || busyRef.current || status?.state !== "AVAILABLE") return;
    busyRef.current = true;
    setBusy("STAGE");
    setClientError(null);
    const controller = new AbortController();
    operationControllerRef.current = controller;
    try {
      const staging = await stagePublicUpdate(session, status.candidateId, request);
      const settled = isPendingStatus(staging)
        ? await pollUntilSettled(session, staging, controller.signal, request)
        : staging;
      if (mountedRef.current) setStatus(settled);
    } catch (error: unknown) {
      if (mountedRef.current) setClientError(updateErrorMessage(error));
    } finally {
      busyRef.current = false;
      operationControllerRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  }, [request, session, status]);

  return { session, status, initializing, busy, clientError, check, stage };
}
