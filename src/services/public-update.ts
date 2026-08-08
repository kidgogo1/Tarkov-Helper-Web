const UPDATE_PROTOCOL_VERSION = 1 as const;
const SESSION_PATH = "/api/v1/app-update/session";
const STATUS_PATH = "/api/v1/app-update/status";
const CHECK_PATH = "/api/v1/app-update/check";
const STAGE_PATH = "/api/v1/app-update/stage";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SEMVER_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;
const CANDIDATE_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;

export type PublicUpdateOperation = "CHECK" | "STAGE" | "APPLY" | "ROLLBACK";

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
      state: "CHECKING";
      currentVersion: string;
      startedAt: string;
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
      candidateId: string;
    }
  | {
      state: "DOWNLOADING";
      currentVersion: string;
      latestVersion: string;
      candidateId: string;
      downloadedBytes: number;
      downloadBytes: number;
      startedAt: string;
    }
  | {
      state: "VERIFYING";
      currentVersion: string;
      latestVersion: string;
      candidateId: string;
      startedAt: string;
    }
  | {
      state: "READY_TO_RESTART";
      currentVersion: string;
      latestVersion: string;
      candidateId: string;
      stagedAt: string;
    }
  | {
      state: "APPLYING" | "ROLLING_BACK";
      currentVersion: string;
      latestVersion: string;
      startedAt: string;
    }
  | {
      state: "UPDATED";
      currentVersion: string;
      previousVersion: string;
      updatedAt: string;
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

function compareSemVer(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function isIsoUtc(value: unknown): value is string {
  return typeof value === "string" && ISO_UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isReleasePageUrl(value: unknown, repository?: string, version?: string): value is string {
  if (typeof value !== "string" || value.length > 500) return false;
  try {
    const url = new URL(value);
    const expectedPath = repository && version
      ? `/${repository}/releases/tag/v${version}`
      : null;
    return url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.username === "" &&
      url.password === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/v[^/]+$/.test(url.pathname) &&
      (expectedPath === null || url.pathname === expectedPath) &&
      url.search === "" &&
      url.hash === "";
  } catch {
    return false;
  }
}

function parseStatus(value: unknown, repository?: string): PublicUpdateStatus | null {
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
    case "CHECKING":
      return hasExactKeys(value, ["state", "currentVersion", "startedAt"]) && isIsoUtc(value.startedAt)
        ? { state: "CHECKING", currentVersion: value.currentVersion, startedAt: value.startedAt }
        : null;
    case "CURRENT":
      return hasExactKeys(value, ["state", "currentVersion", "latestVersion", "checkedAt"]) &&
        isSemVer(value.latestVersion) &&
        compareSemVer(value.latestVersion, value.currentVersion) <= 0 &&
        isIsoUtc(value.checkedAt)
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
        "candidateId",
      ]) &&
        isSemVer(value.latestVersion) &&
        compareSemVer(value.latestVersion, value.currentVersion) > 0 &&
        isIsoUtc(value.publishedAt) &&
        isReleasePageUrl(value.releasePageUrl, repository, value.latestVersion) &&
        typeof value.downloadBytes === "number" &&
        Number.isSafeInteger(value.downloadBytes) &&
        value.downloadBytes > 0 &&
        value.downloadBytes <= 536_870_912 &&
        typeof value.candidateId === "string" &&
        CANDIDATE_PATTERN.test(value.candidateId)
        ? {
            state: "AVAILABLE",
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            publishedAt: value.publishedAt,
            releasePageUrl: value.releasePageUrl,
            downloadBytes: value.downloadBytes,
            candidateId: value.candidateId,
          }
        : null;
    case "DOWNLOADING":
      return hasExactKeys(value, [
        "state",
        "currentVersion",
        "latestVersion",
        "candidateId",
        "downloadedBytes",
        "downloadBytes",
        "startedAt",
      ]) &&
        isSemVer(value.latestVersion) &&
        compareSemVer(value.latestVersion, value.currentVersion) > 0 &&
        typeof value.candidateId === "string" && CANDIDATE_PATTERN.test(value.candidateId) &&
        typeof value.downloadedBytes === "number" && Number.isSafeInteger(value.downloadedBytes) &&
        typeof value.downloadBytes === "number" && Number.isSafeInteger(value.downloadBytes) &&
        value.downloadedBytes >= 0 && value.downloadedBytes <= value.downloadBytes &&
        value.downloadBytes > 0 && value.downloadBytes <= 536_870_912 && isIsoUtc(value.startedAt)
        ? {
            state: "DOWNLOADING",
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            candidateId: value.candidateId,
            downloadedBytes: value.downloadedBytes,
            downloadBytes: value.downloadBytes,
            startedAt: value.startedAt,
          }
        : null;
    case "VERIFYING":
      return hasExactKeys(value, [
        "state",
        "currentVersion",
        "latestVersion",
        "candidateId",
        "startedAt",
      ]) &&
        isSemVer(value.latestVersion) &&
        compareSemVer(value.latestVersion, value.currentVersion) > 0 &&
        typeof value.candidateId === "string" && CANDIDATE_PATTERN.test(value.candidateId) &&
        isIsoUtc(value.startedAt)
        ? {
            state: "VERIFYING",
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            candidateId: value.candidateId,
            startedAt: value.startedAt,
          }
        : null;
    case "READY_TO_RESTART":
      return hasExactKeys(value, ["state", "currentVersion", "latestVersion", "candidateId", "stagedAt"]) &&
        isSemVer(value.latestVersion) &&
        compareSemVer(value.latestVersion, value.currentVersion) > 0 &&
        typeof value.candidateId === "string" && CANDIDATE_PATTERN.test(value.candidateId) &&
        isIsoUtc(value.stagedAt)
        ? {
            state: "READY_TO_RESTART",
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            candidateId: value.candidateId,
            stagedAt: value.stagedAt,
          }
        : null;
    case "APPLYING":
    case "ROLLING_BACK":
      return hasExactKeys(value, ["state", "currentVersion", "latestVersion", "startedAt"]) &&
        isSemVer(value.latestVersion) && isIsoUtc(value.startedAt)
        ? {
            state: value.state,
            currentVersion: value.currentVersion,
            latestVersion: value.latestVersion,
            startedAt: value.startedAt,
          }
        : null;
    case "UPDATED":
      return hasExactKeys(value, ["state", "currentVersion", "previousVersion", "updatedAt"]) &&
        isSemVer(value.previousVersion) &&
        compareSemVer(value.currentVersion, value.previousVersion) > 0 &&
        isIsoUtc(value.updatedAt)
        ? {
            state: "UPDATED",
            currentVersion: value.currentVersion,
            previousVersion: value.previousVersion,
            updatedAt: value.updatedAt,
          }
        : null;
    case "ERROR":
      return hasExactKeys(value, ["state", "currentVersion", "operation", "code", "message"]) &&
        (value.operation === "CHECK" || value.operation === "STAGE" ||
          value.operation === "APPLY" || value.operation === "ROLLBACK") &&
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
  const status = parseStatus(value.status, typeof value.repository === "string" ? value.repository : undefined);
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

async function parseMutationResponse(
  response: Response,
  session: PublicUpdateSession,
): Promise<PublicUpdateStatus> {
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
  const status = parseStatus(value.status, session.repository ?? undefined);
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
  return parseMutationResponse(response, session);
}

export async function fetchPublicUpdateStatus(
  session: PublicUpdateSession,
  signal?: AbortSignal,
  request: UpdateRequest = globalThis.fetch,
): Promise<PublicUpdateStatus> {
  let response: Response;
  try {
    response = await request(STATUS_PATH, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "X-Tarkov-Update": session.token,
      },
      signal,
    });
  } catch {
    throw new PublicUpdateApiError("REQUEST_FAILED", "The local update service could not be reached.");
  }
  return parseMutationResponse(response, session);
}

export function checkForPublicUpdate(
  session: PublicUpdateSession,
  request: UpdateRequest = globalThis.fetch,
): Promise<PublicUpdateStatus> {
  return sendUpdateMutation(CHECK_PATH, session, "{}", request);
}

export async function stagePublicUpdate(
  session: PublicUpdateSession,
  candidateId: string,
  request: UpdateRequest = globalThis.fetch,
): Promise<PublicUpdateStatus> {
  if (!CANDIDATE_PATTERN.test(candidateId)) {
    throw new PublicUpdateApiError("INVALID_CANDIDATE", "The requested update candidate is invalid.");
  }
  const status = await sendUpdateMutation(
    STAGE_PATH,
    session,
    JSON.stringify({ candidateId }),
    request,
  );
  if (
    !(status.state === "DOWNLOADING" || status.state === "VERIFYING" || status.state === "READY_TO_RESTART") ||
    status.candidateId !== candidateId
  ) {
    throw new PublicUpdateApiError("INVALID_RESPONSE", "The launcher staged a different update candidate.");
  }
  return status;
}
