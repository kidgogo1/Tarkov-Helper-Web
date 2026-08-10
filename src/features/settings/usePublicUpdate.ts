import { useCallback, useEffect, useRef, useState } from "react";

import {
  PublicUpdateApiError,
  applyPublicUpdate,
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

const RECONNECT_POLL_INTERVAL_MS = 250;
const RECONNECT_SLOW_POLL_INTERVAL_MS = 1_000;
const RECONNECT_FAST_POLL_COUNT = 40;
const RECONNECT_TIMEOUT_MS = 90 * 60 * 1_000;

export type PublicUpdateBusyState = "CHECK" | "STAGE" | "APPLY" | null;

export interface PublicUpdateRuntime {
  reload?: () => void;
  persistState?: () => boolean;
  createUpdateChannel?: () => PublicUpdateChannel | null;
}

interface RestartBroadcast {
  repository: string;
  previousVersion: string;
  expectedVersion: string;
  candidateId: string;
}

interface PublicUpdateChannel {
  postMessage: (message: unknown) => void;
  addEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
  removeEventListener: (type: "message", listener: (event: MessageEvent<unknown>) => void) => void;
  close: () => void;
}

export interface PublicUpdateController {
  session: PublicUpdateSession | null;
  status: PublicUpdateStatus | null;
  initializing: boolean;
  busy: PublicUpdateBusyState;
  clientError: string | null;
  check: () => Promise<void>;
  install: () => Promise<void>;
  apply: () => Promise<void>;
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

function isWorkerStatus(status: PublicUpdateStatus): boolean {
  return status.state === "CHECKING" ||
    status.state === "DOWNLOADING" ||
    status.state === "VERIFYING";
}

function waitForNextPoll(signal: AbortSignal, delayMs = RECONNECT_POLL_INTERVAL_MS): Promise<void> {
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
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function pollUntilSettled(
  session: PublicUpdateSession,
  initialStatus: PublicUpdateStatus,
  signal: AbortSignal,
  request: UpdateRequest,
  onStatus?: (status: PublicUpdateStatus) => void,
  validateTransition?: (previous: PublicUpdateStatus, next: PublicUpdateStatus) => void,
): Promise<PublicUpdateStatus> {
  let current = initialStatus;
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  for (let attempt = 0; isWorkerStatus(current) && Date.now() <= deadline; attempt += 1) {
    if (attempt > 0) await waitForNextPoll(signal, reconnectPollDelay(attempt));
    const next = await fetchPublicUpdateStatus(session, signal, request);
    validateTransition?.(current, next);
    current = next;
    onStatus?.(next);
  }
  if (isWorkerStatus(current)) {
    throw new PublicUpdateApiError("POLL_TIMEOUT", "업데이트 작업이 제한 시간 안에 끝나지 않았습니다.");
  }
  return current;
}

function assertReviewedStageStatus(
  reviewed: Extract<PublicUpdateStatus, { state: "AVAILABLE" }>,
  next: PublicUpdateStatus,
  previous?: PublicUpdateStatus,
): void {
  if (next.state === "ERROR") {
    if (next.operation === "STAGE" && next.currentVersion === reviewed.currentVersion) return;
    throw new PublicUpdateApiError("INVALID_RESPONSE", "업데이트 다운로드가 올바르지 않은 작업 상태를 반환했습니다.");
  }
  if (
    next.state !== "DOWNLOADING" &&
    next.state !== "VERIFYING" &&
    next.state !== "READY_TO_RESTART"
  ) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "업데이트 다운로드가 올바르지 않은 작업 상태를 반환했습니다.");
  }
  if (
    next.currentVersion !== reviewed.currentVersion ||
    next.latestVersion !== reviewed.latestVersion ||
    next.candidateId !== reviewed.candidateId
  ) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "검토한 업데이트 후보와 다운로드 중인 후보가 일치하지 않습니다.");
  }
  if (next.state === "DOWNLOADING" && next.downloadBytes !== reviewed.downloadBytes) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "업데이트 다운로드 크기가 검토한 릴리스와 일치하지 않습니다.");
  }
  if (!previous) return;
  if (previous.state === "VERIFYING" && next.state === "DOWNLOADING") {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "업데이트 진행 상태가 이전 단계로 되돌아갔습니다.");
  }
  if (
    previous.state === "DOWNLOADING" &&
    next.state === "DOWNLOADING" &&
    next.downloadedBytes < previous.downloadedBytes &&
    (next.startedAt === previous.startedAt || Date.parse(next.startedAt) < Date.parse(previous.startedAt))
  ) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "업데이트 다운로드 진행 상태가 이전 값으로 되돌아갔습니다.");
  }
  if (previous.state === "VERIFYING" && next.state === "VERIFYING" && next.startedAt !== previous.startedAt) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "업데이트 검증 작업의 시작 시각이 예기치 않게 바뀌었습니다.");
  }
}

function reconnectPollDelay(attempt: number): number {
  return attempt <= RECONNECT_FAST_POLL_COUNT
    ? RECONNECT_POLL_INTERVAL_MS
    : RECONNECT_SLOW_POLL_INTERVAL_MS;
}


async function waitForRestartedSession(
  previousSession: PublicUpdateSession,
  expectedVersion: string,
  signal: AbortSignal,
  request: UpdateRequest,
  requireTokenRotation: boolean,
  onSession?: (session: PublicUpdateSession) => void,
  rollbackVersion = previousSession.status.currentVersion,
  retryCandidateId?: string,
): Promise<PublicUpdateSession> {
  const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
  for (let attempt = 0; Date.now() <= deadline; attempt += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (attempt > 0) await waitForNextPoll(signal, reconnectPollDelay(attempt));
    const restarted = await fetchPublicUpdateSession(signal, request);
    if (!restarted) continue;
    if (restarted.repository !== previousSession.repository) {
      throw new PublicUpdateApiError("INVALID_RESPONSE", "재시작한 업데이트 서비스의 저장소가 일치하지 않습니다.");
    }
    if (requireTokenRotation && restarted.token === previousSession.token) {
      if (
        retryCandidateId &&
        restarted.status.state === "READY_TO_RESTART" &&
        restarted.status.candidateId === retryCandidateId &&
        restarted.status.latestVersion === expectedVersion
      ) {
        onSession?.(restarted);
        throw new PublicUpdateApiError("APPLY_NOT_ACCEPTED", "로컬 서버가 업데이트 적용 요청을 받지 못했습니다.");
      }
      continue;
    }
    const restartedVersion = restarted.status.currentVersion;
    if (restartedVersion !== expectedVersion && restartedVersion !== rollbackVersion) {
      throw new PublicUpdateApiError("INVALID_RESPONSE", "재시작한 앱의 버전이 요청한 업데이트와 일치하지 않습니다.");
    }
    onSession?.(restarted);
    if (
      restartedVersion === expectedVersion &&
      (restarted.status.state === "UPDATED" || restarted.status.state === "CURRENT")
    ) {
      return restarted;
    }
    if (
      restartedVersion === rollbackVersion &&
      restarted.status.state === "ERROR" &&
      (restarted.status.operation === "APPLY" || restarted.status.operation === "ROLLBACK")
    ) {
      return restarted;
    }
    if (restartedVersion === expectedVersion) continue;
  }
  throw new PublicUpdateApiError("RECONNECT_TIMEOUT", "업데이트한 로컬 앱에 다시 연결하지 못했습니다.");
}

function defaultReload(): void {
  window.location.reload();
}

function createDefaultUpdateChannel(): PublicUpdateChannel | null {
  return typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("tarkov-helper-web:update:v1");
}

function parseBroadcastVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isSafeInteger(part))) return null;
  return parts as [number, number, number];
}

function compareBroadcastVersions(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function parseRestartBroadcast(value: unknown): RestartBroadcast | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const previousVersion = parseBroadcastVersion(record.previousVersion);
  const expectedVersion = parseBroadcastVersion(record.expectedVersion);
  if (
    Object.keys(record).length !== 6 ||
    record.protocolVersion !== 1 ||
    record.type !== "APPLYING" ||
    typeof record.repository !== "string" ||
    record.repository.length > 200 ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(record.repository) ||
    typeof record.candidateId !== "string" ||
    !/^[A-Za-z0-9_-]{40,64}$/.test(record.candidateId) ||
    !previousVersion ||
    !expectedVersion ||
    compareBroadcastVersions(expectedVersion, previousVersion) <= 0
  ) {
    return null;
  }
  return {
    repository: record.repository,
    previousVersion: record.previousVersion as string,
    expectedVersion: record.expectedVersion as string,
    candidateId: record.candidateId,
  };
}

export function usePublicUpdate(
  request: UpdateRequest = globalThis.fetch,
  runtime: PublicUpdateRuntime = {},
): PublicUpdateController {
  const [session, setSession] = useState<PublicUpdateSession | null>(null);
  const [status, setStatus] = useState<PublicUpdateStatus | null>(null);
  const [initializing, setInitializing] = useState(true);
  const [busy, setBusy] = useState<PublicUpdateBusyState>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [pendingRestart, setPendingRestart] = useState<RestartBroadcast | null>(null);
  const mountedRef = useRef(true);
  const busyRef = useRef(false);
  const operationControllerRef = useRef<AbortController | null>(null);
  const updateChannelRef = useRef<PublicUpdateChannel | null>(null);
  const reload = runtime.reload ?? defaultReload;
  const persistState = runtime.persistState;
  const createUpdateChannel = runtime.createUpdateChannel ?? createDefaultUpdateChannel;

  const reconnect = useCallback(async (
    previousSession: PublicUpdateSession,
    expectedVersion: string,
    controller: AbortController,
    requireTokenRotation = true,
    rollbackVersion = previousSession.status.currentVersion,
    retryCandidateId?: string,
  ) => {
    const restarted = await waitForRestartedSession(
      previousSession,
      expectedVersion,
      controller.signal,
      request,
      requireTokenRotation,
      (nextSession) => {
        if (!mountedRef.current) return;
        setSession(nextSession);
        setStatus(nextSession.status);
      },
      rollbackVersion,
      retryCandidateId,
    );
    if (!mountedRef.current) return;
    setSession(restarted);
    setStatus(restarted.status);
    reload();
  }, [reload, request]);

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
        !isPendingStatus(loadedSession.status) ||
        busyRef.current
      ) return;

      busyRef.current = true;
      const operation = loadedSession.status.state === "CHECKING"
        ? "CHECK"
        : loadedSession.status.state === "APPLYING" || loadedSession.status.state === "ROLLING_BACK"
          ? "APPLY"
          : "STAGE";
      setBusy(operation);
      operationControllerRef.current = controller;
      try {
        if (loadedSession.status.state === "APPLYING" || loadedSession.status.state === "ROLLING_BACK") {
          await reconnect(loadedSession, loadedSession.status.latestVersion, controller, false);
        } else {
          const initial = loadedSession.status;
          const settled = await pollUntilSettled(loadedSession, initial, controller.signal, request, (nextStatus) => {
            if (active) setStatus(nextStatus);
          });
          if (active) setStatus(settled);
        }
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
  }, [reconnect, request]);

  useEffect(() => {
    const channel = createUpdateChannel();
    updateChannelRef.current = channel;
    if (!channel) return;
    const onMessage = (event: MessageEvent<unknown>) => {
      const restart = parseRestartBroadcast(event.data);
      if (restart) setPendingRestart(restart);
    };
    channel.addEventListener("message", onMessage);
    return () => {
      channel.removeEventListener("message", onMessage);
      channel.close();
      if (updateChannelRef.current === channel) updateChannelRef.current = null;
    };
  }, [createUpdateChannel]);

  useEffect(() => {
    if (!pendingRestart || initializing || busy !== null || busyRef.current) return;
    const controller = new AbortController();
    const restart = pendingRestart;
    setPendingRestart(null);
    busyRef.current = true;
    operationControllerRef.current = controller;
    setBusy("APPLY");
    setClientError(null);

    void (async () => {
      // The tab that accepted the update already flushed its own state before
      // broadcasting. A follower can have an older in-memory snapshot; writing
      // it here would race the initiating tab and overwrite newer progress in
      // shared localStorage. Followers only reconnect and reload.
      let baseline = session;
      if (!baseline) {
        const deadline = Date.now() + RECONNECT_TIMEOUT_MS;
        for (let attempt = 0; Date.now() <= deadline && !baseline; attempt += 1) {
          if (attempt > 0) await waitForNextPoll(controller.signal, reconnectPollDelay(attempt));
          baseline = await fetchPublicUpdateSession(controller.signal, request);
        }
      }
      if (!baseline) {
        throw new PublicUpdateApiError("RECONNECT_TIMEOUT", "업데이트된 로컬 앱에 다시 연결하지 못했습니다.");
      }
      if (baseline.repository !== restart.repository) {
        throw new PublicUpdateApiError("INVALID_RESPONSE", "다시 시작한 업데이트 서버의 저장소가 일치하지 않습니다.");
      }
      const baselineVersion = baseline.status.currentVersion;
      if (
        baselineVersion === restart.expectedVersion &&
        (baseline.status.state === "UPDATED" || baseline.status.state === "CURRENT")
      ) {
        setSession(baseline);
        setStatus(baseline.status);
        reload();
        return;
      }
      if (
        baselineVersion === restart.previousVersion &&
        baseline.status.state === "ERROR" &&
        (baseline.status.operation === "APPLY" || baseline.status.operation === "ROLLBACK")
      ) {
        setSession(baseline);
        setStatus(baseline.status);
        reload();
        return;
      }
      if (baselineVersion !== restart.previousVersion && baselineVersion !== restart.expectedVersion) {
        throw new PublicUpdateApiError("INVALID_RESPONSE", "다시 시작한 앱의 버전이 요청한 업데이트와 일치하지 않습니다.");
      }
      const alreadyRestarting = baselineVersion === restart.expectedVersion ||
        baseline.status.state === "APPLYING" || baseline.status.state === "ROLLING_BACK";
      await reconnect(
        baseline,
        restart.expectedVersion,
        controller,
        !alreadyRestarting,
        restart.previousVersion,
        restart.candidateId,
      );
    })().catch((error: unknown) => {
      if (mountedRef.current && !(error instanceof DOMException && error.name === "AbortError")) {
        setClientError(updateErrorMessage(error));
      }
    }).finally(() => {
      busyRef.current = false;
      operationControllerRef.current = null;
      if (mountedRef.current) setBusy(null);
    });
  }, [busy, initializing, pendingRestart, persistState, reconnect, reload, request, session]);

  const check = useCallback(async () => {
    if (!session || busyRef.current || session.status.state === "DISABLED") return;
    busyRef.current = true;
    setBusy("CHECK");
    setClientError(null);
    const controller = new AbortController();
    operationControllerRef.current = controller;
    try {
      const checking = await checkForPublicUpdate(session, controller.signal, request);
      if (mountedRef.current) setStatus(checking);
      const settled = isWorkerStatus(checking)
        ? await pollUntilSettled(session, checking, controller.signal, request, (nextStatus) => {
            if (mountedRef.current) setStatus(nextStatus);
          })
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

  const applyReady = useCallback(async (
    candidateId: string,
    expectedVersion: string,
    controller: AbortController,
  ) => {
    if (!session) return;
    if (persistState && !persistState()) {
      throw new PublicUpdateApiError(
        "STATE_SAVE_FAILED",
        "진행도와 설정을 저장하지 못해 업데이트를 시작하지 않았습니다. 브라우저 저장 공간을 확인해 주세요.",
      );
    }
    if (!session.repository) {
      throw new PublicUpdateApiError("NOT_CONFIGURED", "공개 업데이트 저장소가 설정되지 않았습니다.");
    }

    const restoreReadyStatus = () => {
      if (!mountedRef.current) return;
      setStatus({
        state: "READY_TO_RESTART",
        currentVersion: session.status.currentVersion,
        latestVersion: expectedVersion,
        candidateId,
        stagedAt: new Date().toISOString(),
      });
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      let applyingStatus: PublicUpdateStatus | null = null;
      let restartBaseline: PublicUpdateSession | null = null;
      try {
        applyingStatus = await applyPublicUpdate(session, candidateId, expectedVersion, controller.signal, request);
      } catch (error: unknown) {
        if (!(error instanceof PublicUpdateApiError &&
          (error.code === "REQUEST_FAILED" || error.code === "INVALID_RESPONSE"))) throw error;

        let serverStillReady = false;
        for (let probe = 0; probe < 3; probe += 1) {
          if (probe > 0) await waitForNextPoll(controller.signal);
          const observed = await fetchPublicUpdateSession(controller.signal, request);
          if (!observed) continue;
          if (observed.repository !== session.repository) {
            throw new PublicUpdateApiError("INVALID_RESPONSE", "다시 연결한 업데이트 서버의 저장소가 일치하지 않습니다.");
          }
          serverStillReady = observed.token === session.token &&
            observed.status.state === "READY_TO_RESTART" &&
            observed.status.candidateId === candidateId &&
            observed.status.latestVersion === expectedVersion;
          if (!serverStillReady) restartBaseline = observed;
          break;
        }
        if (serverStillReady) {
          if (attempt < 2) continue;
          restoreReadyStatus();
          throw error;
        }

        // The old server may close after accepting the mutation but before the
        // browser observes the response. Reconnect decides success or rollback.
        applyingStatus = {
          state: "APPLYING",
          currentVersion: session.status.currentVersion,
          latestVersion: expectedVersion,
          startedAt: new Date().toISOString(),
        };
      }
      if (!applyingStatus) continue;
      if (mountedRef.current) setStatus(applyingStatus);
      try {
        updateChannelRef.current?.postMessage({
          protocolVersion: 1,
          type: "APPLYING",
          repository: session.repository,
          previousVersion: session.status.currentVersion,
          expectedVersion,
          candidateId,
        });
      } catch {
        // The initiating tab can still reconnect when BroadcastChannel is blocked.
      }

      try {
        if (restartBaseline) {
          const restartedVersion = restartBaseline.status.currentVersion;
          const isTargetTerminal = restartedVersion === expectedVersion &&
            (restartBaseline.status.state === "UPDATED" || restartBaseline.status.state === "CURRENT");
          const isRollbackTerminal = restartedVersion === session.status.currentVersion &&
            restartBaseline.status.state === "ERROR" &&
            (restartBaseline.status.operation === "APPLY" || restartBaseline.status.operation === "ROLLBACK");
          if (isTargetTerminal || isRollbackTerminal) {
            if (mountedRef.current) {
              setSession(restartBaseline);
              setStatus(restartBaseline.status);
              reload();
            }
            return;
          }
          if (restartedVersion !== session.status.currentVersion && restartedVersion !== expectedVersion) {
            throw new PublicUpdateApiError("INVALID_RESPONSE", "다시 시작한 앱의 버전이 요청한 업데이트와 일치하지 않습니다.");
          }
          await reconnect(
            restartBaseline,
            expectedVersion,
            controller,
            false,
            session.status.currentVersion,
          );
          return;
        }
        await reconnect(
          session,
          expectedVersion,
          controller,
          true,
          session.status.currentVersion,
          candidateId,
        );
        return;
      } catch (error: unknown) {
        if (error instanceof PublicUpdateApiError && error.code === "APPLY_NOT_ACCEPTED" && attempt < 2) {
          continue;
        }
        if (error instanceof PublicUpdateApiError && error.code === "APPLY_NOT_ACCEPTED") {
          restoreReadyStatus();
        }
        throw error;
      }
    }
    restoreReadyStatus();
    throw new PublicUpdateApiError("REQUEST_FAILED", "로컬 업데이트 서비스가 적용 요청을 받지 못했습니다.");
  }, [persistState, reconnect, reload, request, session]);

  const install = useCallback(async () => {
    if (!session || busyRef.current || status?.state !== "AVAILABLE") return;
    busyRef.current = true;
    setBusy("STAGE");
    setClientError(null);
    const controller = new AbortController();
    operationControllerRef.current = controller;
    try {
      const staging = await stagePublicUpdate(session, status.candidateId, controller.signal, request);
      assertReviewedStageStatus(status, staging);
      if (mountedRef.current) setStatus(staging);
      const settled = isWorkerStatus(staging)
        ? await pollUntilSettled(session, staging, controller.signal, request, (nextStatus) => {
            if (mountedRef.current) setStatus(nextStatus);
          }, (previous, next) => assertReviewedStageStatus(status, next, previous))
        : staging;
      if (mountedRef.current) setStatus(settled);
      if (settled.state === "READY_TO_RESTART") {
        setBusy("APPLY");
        await applyReady(settled.candidateId, settled.latestVersion, controller);
      }
    } catch (error: unknown) {
      if (mountedRef.current) setClientError(updateErrorMessage(error));
    } finally {
      busyRef.current = false;
      operationControllerRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  }, [applyReady, request, session, status]);

  const apply = useCallback(async () => {
    if (!session || busyRef.current || status?.state !== "READY_TO_RESTART") return;
    busyRef.current = true;
    setBusy("APPLY");
    setClientError(null);
    const controller = new AbortController();
    operationControllerRef.current = controller;
    try {
      await applyReady(status.candidateId, status.latestVersion, controller);
    } catch (error: unknown) {
      if (mountedRef.current && !(error instanceof DOMException && error.name === "AbortError")) {
        setClientError(updateErrorMessage(error));
      }
    } finally {
      busyRef.current = false;
      operationControllerRef.current = null;
      if (mountedRef.current) setBusy(null);
    }
  }, [applyReady, session, status]);

  return { session, status, initializing, busy, clientError, check, install, apply };
}
