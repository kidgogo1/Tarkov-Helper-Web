const UPDATE_PROTOCOL_VERSION = 1 as const;
const SESSION_PATH = "/api/v1/app-update/session";
const CHECK_PATH = "/api/v1/app-update/check";
const STAGE_PATH = "/api/v1/app-update/stage";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

export type PublicUpdateOperation = "CHECK" | "STAGE";

export type PublicUpdateStatus =
  | {
      state: "DISABLED";
      currentVersion: string;
      reason: "NOT_CONFIGURED";
    }
  | {
      state: "IDLE";
      currentVersion: string;
    }
  | {
      state: "CURRENT";
      currentVersion: string;
      latestVersion: string;
      checkedAt: string;
    }
  | {
      state: "AVAILABLE";
      currentVersion: string;
      latestVersion: string;
      publishedAt: string;
      releasePageUrl: string;
      downloadBytes: number;
    }
  | {
      state: "READY_TO_RESTART";
      currentVersion: string;
      latestVersion: string;
      stagedAt: string;
    }
  | {
      state: "ERROR";
      currentVersion: string;
      operation: PublicUpdateOperation;
      code: string;
      message: string;
    };

export interface PublicUpdateSession {
  protocolVersion: typeof UPDATE_PROTOCOL_VERSION;
  capability: "PUBLIC_GITHUB_RELEASES";
  token: string;
  repository: string | null;
  status: PublicUpdateStatus;
}

type UpdateRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export class PublicUpdateApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PublicUpdateApiError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isSemVer(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && SEMVER_PATTERN.test(value);
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isReleasePageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.username === "" &&
      url.password === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/v[^/]+$/.test(url.pathname) &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function parseStatus(value: unknown): PublicUpdateStatus | null {
  if (!isRecord(value) || typeof value.state !== "string" || !isSemVer(value.currentVersion)) {
    return null;
  }

  switch (value.state) {
    case "DISABLED":
      return hasExactKeys(value, ["state", "currentVersion", "reason"]) &&
        value.reason === "NOT_CONFIGURED"
        ? { state: "DISABLED", currentVersion: value.currentVersion, reason: "NOT_CONFIGURED" }
        : null;
    case "IDLE":
      return hasExactKeys(value, ["state", "currentVersion"])
        ? { state: "IDLE", currentVersion: value.currentVersion }
        : null;
    case "CURRENT":
      return hasExactKeys(value, ["state", "currentVersion", "latestVersion", "checkedAt"]) &&
        isSemVer(value.latestVersion) && isIsoUtc(value.checkedAt)
        ? {
            state: "CURRENT",
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            checkedAt: value.checkedAt,
          }
        : null;
    case "AVAILABLE":
      return hasExactKeys(value, [
        "state",
        "currentVersion",
        "latestVersion",
        "publishedAt",
        "releasePageUrl",
        "downloadBytes",
      ]) &&
        isSemVer(value.latestVersion) &&
        isIsoUtc(value.publishedAt) &&
        isReleasePageUrl(value.releasePageUrl) &&
        typeof value.downloadBytes === "number" &&
        Number.isSafeInteger(value.downloadBytes) &&
        value.downloadBytes > 0 &&
        value.downloadBytes <= 536_870_912
        ? {
            state: "AVAILABLE",
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            publishedAt: value.publishedAt,
            releasePageUrl: value.releasePageUrl,
            downloadBytes: value.downloadBytes,
          }
        : null;
    case "READY_TO_RESTART":
      return hasExactKeys(value, ["state", "currentVersion", "latestVersion", "stagedAt"]) &&
        isSemVer(value.latestVersion) && isIsoUtc(value.stagedAt)
        ? {
            state: "READY_TO_RESTART",
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            stagedAt: value.stagedAt,
          }
        : null;
    case "ERROR":
      return hasExactKeys(value, ["state", "currentVersion", "operation", "code", "message"]) &&
        (value.operation === "CHECK" || value.operation === "STAGE") &&
        typeof value.code === "string" && ERROR_CODE_PATTERN.test(value.code) &&
        typeof value.message === "string" && value.message.length >= 1 && value.message.length <= 500
        ? {
            state: "ERROR",
            currentVersion: value.currentVersion,
            operation: value.operation,
            code: value.code,
            message: value.message,
          }
        : null;
    default:
      return null;
  }
}

async function readJson(response: Response): Promise<unknown | null> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!contentType.toLocaleLowerCase().startsWith("application/json")) return null;
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function parseSession(value: unknown): PublicUpdateSession | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["protocolVersion", "capability", "token", "repository", "status"]) ||
    value.protocolVersion !== UPDATE_PROTOCOL_VERSION ||
    value.capability !== "PUBLIC_GITHUB_RELEASES" ||
    typeof value.token !== "string" ||
    !TOKEN_PATTERN.test(value.token) ||
    (value.repository !== null &&
      (typeof value.repository !== "string" || !REPOSITORY_PATTERN.test(value.repository)))
  ) {
    return null;
  }
  const status = parseStatus(value.status);
  if (!status) return null;
  if ((value.repository === null) !== (status.state === "DISABLED")) return null;
  return {
    protocolVersion: UPDATE_PROTOCOL_VERSION,
    capability: "PUBLIC_GITHUB_RELEASES",
    token: value.token,
    repository: value.repository,
    status,
  };
}

async function parseMutationResponse(response: Response): Promise<PublicUpdateStatus> {
  const value = await readJson(response);
  if (!response.ok) {
    if (
      isRecord(value) &&
      hasExactKeys(value, ["error"]) &&
      isRecord(value.error) &&
      hasExactKeys(value.error, ["code", "message"]) &&
      typeof value.error.code === "string" &&
      ERROR_CODE_PATTERN.test(value.error.code) &&
      typeof value.error.message === "string" &&
      value.error.message.length >= 1 &&
      value.error.message.length <= 500
    ) {
      throw new PublicUpdateApiError(value.error.code, value.error.message);
    }
    throw new PublicUpdateApiError("REQUEST_FAILED", `Update request failed (${response.status}).`);
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["protocolVersion", "status"]) ||
    value.protocolVersion !== UPDATE_PROTOCOL_VERSION
  ) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "The launcher returned an invalid update response.");
  }
  const status = parseStatus(value.status);
  if (!status) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "The launcher returned an invalid update status.");
  }
  return status;
}

export async function fetchPublicUpdateSession(
  signal?: AbortSignal,
  request: UpdateRequest = globalThis.fetch,
): Promise<PublicUpdateSession | null> {
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

async function sendUpdateMutation(
  path: string,
  session: PublicUpdateSession,
  body: string,
  request: UpdateRequest,
): Promise<PublicUpdateStatus> {
  let response: Response;
  try {
    response = await request(path, {
      method: "POST",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Tarkov-Update": session.token,
      },
      body,
    });
  } catch {
    throw new PublicUpdateApiError("REQUEST_FAILED", "The local update service could not be reached.");
  }
  return parseMutationResponse(response);
}

export function checkForPublicUpdate(
  session: PublicUpdateSession,
  request: UpdateRequest = globalThis.fetch,
): Promise<PublicUpdateStatus> {
  return sendUpdateMutation(CHECK_PATH, session, "{}", request);
}

export async function stagePublicUpdate(
  session: PublicUpdateSession,
  version: string,
  request: UpdateRequest = globalThis.fetch,
): Promise<Extract<PublicUpdateStatus, { state: "READY_TO_RESTART" }>> {
  if (!isSemVer(version)) {
    throw new PublicUpdateApiError("INVALID_VERSION", "The requested update version is invalid.");
  }
  const status = await sendUpdateMutation(
    STAGE_PATH,
    session,
    JSON.stringify({ version }),
    request,
  );
  if (status.state !== "READY_TO_RESTART" || status.latestVersion !== version) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "The launcher staged a different update version.");
  }
  return status;
}
