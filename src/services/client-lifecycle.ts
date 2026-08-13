import { recordClientDiagnostic } from "./client-diagnostics";

const CLIENT_PROTOCOL_VERSION = 1 as const;
const SESSION_PATH = "/api/v1/client/session";
const HEARTBEAT_PATH = "/api/v1/client/heartbeat";
const CLOSE_PATH = "/api/v1/client/close";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

export interface ClientLifecycleSession {
  protocolVersion: typeof CLIENT_PROTOCOL_VERSION;
  leaseToken: string;
  heartbeatIntervalMs: number;
  timeoutMs: number;
}

type LifecycleRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

interface SessionAttempt {
  session: ClientLifecycleSession | null;
  retryable: boolean;
  failure?: {
    kind: "aborted" | "http" | "malformed" | "transport";
    error?: unknown;
  };
}

function isAbortError(error: unknown): boolean {
  try {
    return typeof error === "object" && error !== null &&
      "name" in error && error.name === "AbortError";
  } catch {
    return false;
  }
}

async function requestSession(
  signal: AbortSignal | undefined,
  request: LifecycleRequest,
): Promise<SessionAttempt> {
  try {
    const response = await request(SESSION_PATH, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status === 404) return { session: null, retryable: false };
    if (response.status !== 200) {
      return {
        session: null,
        retryable: response.status >= 500 || response.status === 429,
        failure: { kind: "http" },
      };
    }
    const session = parseSession(await readJson(response));
    // A malformed successful response is a bad build/configuration, not a
    // transient startup race; stop rather than polling a broken server.
    return {
      session,
      retryable: false,
      ...(session ? {} : { failure: { kind: "malformed" as const } }),
    };
  } catch (error) {
    if (isAbortError(error)) {
      return {
        session: null,
        retryable: false,
        failure: { kind: "aborted" },
      };
    }
    return {
      session: null,
      retryable: true,
      failure: { kind: "transport", error },
    };
  }
}

function recordSessionFailure(attempt: SessionAttempt): void {
  const failure = attempt.failure;
  if (!failure || failure.kind === "aborted") return;
  if (failure.kind === "malformed") {
    recordClientDiagnostic({
      source: "global",
      code: "CLIENT_LIFECYCLE_SESSION_MALFORMED",
      level: "warning",
      message: "The Direct client lifecycle session response was malformed.",
      operation: "client-session",
    });
    return;
  }
  recordClientDiagnostic({
    source: "global",
    code: "CLIENT_LIFECYCLE_SESSION_FAILED",
    level: "warning",
    ...(failure.kind === "transport"
      ? { error: failure.error, message: "The Direct client lifecycle session request failed." }
      : { message: "The Direct client lifecycle session request returned a non-success status." }),
    operation: "client-session",
  });
}

function waitForRetry(signal: AbortSignal, delayMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseSession(value: unknown): ClientLifecycleSession | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "leaseToken",
      "heartbeatIntervalMs",
      "timeoutMs",
    ]) ||
    value.protocolVersion !== CLIENT_PROTOCOL_VERSION ||
    typeof value.leaseToken !== "string" ||
    !TOKEN_PATTERN.test(value.leaseToken) ||
    typeof value.heartbeatIntervalMs !== "number" ||
    !Number.isSafeInteger(value.heartbeatIntervalMs) ||
    value.heartbeatIntervalMs < 500 ||
    value.heartbeatIntervalMs > 10_000 ||
    typeof value.timeoutMs !== "number" ||
    !Number.isSafeInteger(value.timeoutMs) ||
    value.timeoutMs < value.heartbeatIntervalMs * 2 ||
    value.timeoutMs > 600_000
  ) {
    return null;
  }
  return {
    protocolVersion: CLIENT_PROTOCOL_VERSION,
    leaseToken: value.leaseToken,
    heartbeatIntervalMs: value.heartbeatIntervalMs,
    timeoutMs: value.timeoutMs,
  };
}

export async function fetchClientLifecycleSession(
  signal?: AbortSignal,
  request: LifecycleRequest = globalThis.fetch,
): Promise<ClientLifecycleSession | null> {
  return (await requestSession(signal, request)).session;
}

interface LeaseCommandAttempt {
  response?: Response;
  error?: unknown;
  aborted: boolean;
}

async function sendLeaseCommand(
  path: string,
  leaseToken: string,
  request: LifecycleRequest,
  signal?: AbortSignal,
): Promise<LeaseCommandAttempt> {
  try {
    return {
      response: await request(path, {
        method: "POST",
        cache: "no-store",
        keepalive: path === CLOSE_PATH,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ leaseToken }),
        signal,
      }),
      aborted: false,
    };
  } catch (error) {
    return { error, aborted: isAbortError(error) };
  }
}

/**
 * Keeps the local launcher alive only while at least one app tab is present.
 * Static hosts simply return 404 for the session endpoint and remain unaffected.
 */
export function startClientLifecycle(
  request: LifecycleRequest = globalThis.fetch,
): () => void {
  const controller = new AbortController();
  let stopped = false;
  let closeSent = false;
  let leaseToken: string | null = null;
  let heartbeatTimer: number | null = null;
  let heartbeatInFlight = false;
  let heartbeatFailureActive = false;

  const clearHeartbeat = () => {
    if (heartbeatTimer !== null) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  };

  const closeLease = () => {
    if (stopped) return;
    stopped = true;
    clearHeartbeat();
    controller.abort();
    window.removeEventListener("pagehide", closeLease);
    const token = leaseToken;
    if (token && !closeSent) {
      closeSent = true;
      void sendLeaseCommand(CLOSE_PATH, token, request);
    }
  };

  window.addEventListener("pagehide", closeLease, { once: true });

  void (async () => {
    // The direct launcher can need a few seconds to finish binding its
    // listener on slower disks/antivirus scans. Retry only transport/server
    // failures; a static host's 404 and malformed contracts remain one-shot.
    const retryDelays = [100, 250, 500, 1_000, 2_000] as const;
    let session: ClientLifecycleSession | null = null;
    let finalAttempt: SessionAttempt | null = null;
    for (let attempt = 0; attempt <= retryDelays.length && !stopped; attempt += 1) {
      const result = await requestSession(controller.signal, request);
      finalAttempt = result;
      session = result.session;
      if (session || !result.retryable || stopped || attempt === retryDelays.length) break;
      if (!await waitForRetry(controller.signal, retryDelays[attempt])) return;
    }
    if (!session || stopped) {
      window.removeEventListener("pagehide", closeLease);
      if (!stopped && finalAttempt) recordSessionFailure(finalAttempt);
      return;
    }
    leaseToken = session.leaseToken;
    heartbeatTimer = window.setInterval(() => {
      if (stopped || !leaseToken || heartbeatInFlight) return;
      heartbeatInFlight = true;
      void sendLeaseCommand(HEARTBEAT_PATH, leaseToken, request, controller.signal)
        .then((result) => {
          if (stopped || result.aborted) return;
          if (result.response?.ok) {
            heartbeatFailureActive = false;
            return;
          }
          if (heartbeatFailureActive) return;
          heartbeatFailureActive = true;
          recordClientDiagnostic({
            source: "global",
            code: "CLIENT_LIFECYCLE_HEARTBEAT_FAILED",
            level: "warning",
            ...(result.error
              ? { error: result.error, message: "The Direct client lifecycle heartbeat failed." }
              : { message: "The Direct client lifecycle heartbeat returned a non-success status." }),
            operation: "client-heartbeat",
          });
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, session.heartbeatIntervalMs);
  })();

  return closeLease;
}
