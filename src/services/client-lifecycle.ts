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
    value.timeoutMs > 60_000
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
  try {
    const response = await request(SESSION_PATH, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status !== 200) return null;
    return parseSession(await readJson(response));
  } catch {
    return null;
  }
}

function sendLeaseCommand(
  path: string,
  leaseToken: string,
  request: LifecycleRequest,
  signal?: AbortSignal,
): Promise<Response | undefined> {
  return request(path, {
    method: "POST",
    cache: "no-store",
    keepalive: path === CLOSE_PATH,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ leaseToken }),
    signal,
  }).catch(() => undefined);
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

  void fetchClientLifecycleSession(controller.signal, request).then((session) => {
    if (!session || stopped) {
      window.removeEventListener("pagehide", closeLease);
      return;
    }
    leaseToken = session.leaseToken;
    heartbeatTimer = window.setInterval(() => {
      if (stopped || !leaseToken) return;
      void sendLeaseCommand(HEARTBEAT_PATH, leaseToken, request, controller.signal);
    }, session.heartbeatIntervalMs);
  });

  return closeLease;
}

