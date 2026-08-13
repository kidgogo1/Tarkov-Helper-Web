export const LOCAL_TRACKER_PROTOCOL_VERSION = 1 as const;
export const LOCAL_TRACKER_PAGE_SIZE = 100 as const;

export type ScreenshotWatcherStatus =
  | { state: "WATCHING"; folderPath: string }
  | { state: "NOT_FOUND" }
  | { state: "ERROR"; message: string };

export interface LocalTrackerStatus {
  protocolVersion: typeof LOCAL_TRACKER_PROTOCOL_VERSION;
  /** Changes whenever the in-memory launcher event history is recreated. */
  instanceId?: string;
  screenshotWatcher: ScreenshotWatcherStatus;
  latestCursor: number;
}

export interface ScreenshotCreatedEvent {
  type: "SCREENSHOT_CREATED";
  sequence: number;
  fileName: string;
  detectedAt: string;
  /** Optional map identity supplied by newer launchers. Omitted by protocol-v1 launchers. */
  mapKey?: string;
}

export interface LocalTrackerPagination {
  afterCursor: number;
  nextCursor: number;
  hasMore: boolean;
  isResetRequired?: boolean;
}

export interface LocalTrackerEventPage {
  protocolVersion: typeof LOCAL_TRACKER_PROTOCOL_VERSION;
  instanceId?: string;
  data: ScreenshotCreatedEvent[];
  pagination: LocalTrackerPagination;
}

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type LocalTrackerFailureCode =
  | "INVALID_RESPONSE"
  | "NETWORK_ERROR"
  | "NOT_FOUND"
  | "REQUEST_FAILED";

export class LocalTrackerApiError extends Error {
  readonly code: LocalTrackerFailureCode;
  readonly status: number;

  constructor(code: LocalTrackerFailureCode, status: number) {
    super("Local tracker request failed.");
    this.name = "LocalTrackerApiError";
    this.code = code;
    this.status = status;
  }
}

export type LocalTrackerFailureHandler = (error: LocalTrackerApiError) => void;

function isAbortError(error: unknown): boolean {
  try {
    return typeof error === "object" && error !== null &&
      "name" in error && error.name === "AbortError";
  } catch {
    return false;
  }
}

function notifyFailure(
  onFailure: LocalTrackerFailureHandler | undefined,
  error: LocalTrackerApiError,
): void {
  try {
    onFailure?.(error);
  } catch {
    // Optional diagnostics must not change tracker availability behavior.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maximumLength &&
    !value.includes("\0")
  );
}

function parseInstanceId(value: unknown): string | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === "string" && /^[a-f0-9]{32}$/i.test(value)
    ? value
    : null;
}

function parseWatcherStatus(value: unknown): ScreenshotWatcherStatus | null {
  if (!isRecord(value) || typeof value.state !== "string") return null;

  switch (value.state) {
    case "WATCHING":
      return isNonEmptyString(value.folderPath, 32_767)
        ? { state: "WATCHING", folderPath: value.folderPath }
        : null;
    case "NOT_FOUND":
      return { state: "NOT_FOUND" };
    case "ERROR": {
      const structuredMessage = isRecord(value.error) ? value.error.message : undefined;
      const message = isNonEmptyString(value.message, 1_000)
        ? value.message
        : isNonEmptyString(structuredMessage, 1_000)
          ? structuredMessage
          : null;
      return message ? { state: "ERROR", message } : null;
    }
    default:
      return null;
  }
}

function parseStatus(value: unknown): LocalTrackerStatus | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== LOCAL_TRACKER_PROTOCOL_VERSION ||
    !isNonNegativeInteger(value.latestCursor)
  ) {
    return null;
  }
  const instanceId = parseInstanceId(value.instanceId);
  if (instanceId === null) return null;
  const screenshotWatcher = parseWatcherStatus(value.screenshotWatcher);
  if (!screenshotWatcher) return null;
  return {
    protocolVersion: LOCAL_TRACKER_PROTOCOL_VERSION,
    ...(instanceId === undefined ? {} : { instanceId }),
    screenshotWatcher,
    latestCursor: value.latestCursor,
  };
}

function parseScreenshotEvent(value: unknown): ScreenshotCreatedEvent | null {
  const hasMapKey = isRecord(value) && Object.prototype.hasOwnProperty.call(value, "mapKey");
  if (
    !isRecord(value) ||
    value.type !== "SCREENSHOT_CREATED" ||
    !isNonNegativeInteger(value.sequence) ||
    value.sequence === 0 ||
    !isNonEmptyString(value.fileName, 512) ||
    value.fileName.includes("/") ||
    value.fileName.includes("\\") ||
    !value.fileName.toLocaleLowerCase("en-US").endsWith(".png") ||
    !isNonEmptyString(value.detectedAt, 100) ||
    !Number.isFinite(Date.parse(value.detectedAt)) ||
    (hasMapKey && !isNonEmptyString(value.mapKey, 128))
  ) {
    return null;
  }
  return {
    type: "SCREENSHOT_CREATED",
    sequence: value.sequence,
    fileName: value.fileName,
    detectedAt: value.detectedAt,
    ...(hasMapKey ? { mapKey: (value.mapKey as string).trim() } : {}),
  };
}

function parseEventPage(value: unknown, requestedCursor: number): LocalTrackerEventPage | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== LOCAL_TRACKER_PROTOCOL_VERSION ||
    !Array.isArray(value.data) ||
    !isRecord(value.pagination)
  ) {
    return null;
  }
  const instanceId = parseInstanceId(value.instanceId);
  if (instanceId === null) return null;

  const { afterCursor, nextCursor, hasMore, isResetRequired } = value.pagination;
  if (
    !isNonNegativeInteger(afterCursor) ||
    afterCursor !== requestedCursor ||
    !isNonNegativeInteger(nextCursor) ||
    nextCursor < afterCursor ||
    typeof hasMore !== "boolean" ||
    (isResetRequired !== undefined && typeof isResetRequired !== "boolean")
  ) {
    return null;
  }

  const data: ScreenshotCreatedEvent[] = [];
  for (const candidate of value.data) {
    const event = parseScreenshotEvent(candidate);
    if (!event || event.sequence > nextCursor) return null;
    data.push(event);
  }

  return {
    protocolVersion: LOCAL_TRACKER_PROTOCOL_VERSION,
    ...(instanceId === undefined ? {} : { instanceId }),
    data,
    pagination: {
      afterCursor,
      nextCursor,
      hasMore,
      ...(isResetRequired === undefined ? {} : { isResetRequired }),
    },
  };
}

type JsonRequestResult =
  | { ok: true; payload: unknown }
  | { ok: false };

async function requestJson(
  path: string,
  signal: AbortSignal | undefined,
  request: FetchRequest,
  onFailure?: LocalTrackerFailureHandler,
): Promise<JsonRequestResult> {
  try {
    const response = await request(path, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      notifyFailure(
        onFailure,
        new LocalTrackerApiError(
          response.status === 404 ? "NOT_FOUND" : "REQUEST_FAILED",
          response.status,
        ),
      );
      return { ok: false };
    }
    try {
      return { ok: true, payload: await response.json() as unknown };
    } catch {
      notifyFailure(onFailure, new LocalTrackerApiError("INVALID_RESPONSE", response.status));
      return { ok: false };
    }
  } catch (error) {
    if (!isAbortError(error)) {
      notifyFailure(onFailure, new LocalTrackerApiError("NETWORK_ERROR", 0));
    }
    return { ok: false };
  }
}

export async function fetchLocalTrackerStatus(
  signal?: AbortSignal,
  request: FetchRequest = globalThis.fetch,
  onFailure?: LocalTrackerFailureHandler,
): Promise<LocalTrackerStatus | null> {
  const result = await requestJson(
    "/api/v1/local-tracker/status",
    signal,
    request,
    onFailure,
  );
  if (!result.ok) return null;
  const status = parseStatus(result.payload);
  if (!status) notifyFailure(onFailure, new LocalTrackerApiError("INVALID_RESPONSE", 200));
  return status;
}

export async function fetchLocalTrackerEvents(
  afterCursor: number,
  signal?: AbortSignal,
  request: FetchRequest = globalThis.fetch,
  onFailure?: LocalTrackerFailureHandler,
): Promise<LocalTrackerEventPage | null> {
  if (!isNonNegativeInteger(afterCursor)) return null;
  const query = new URLSearchParams({
    afterCursor: String(afterCursor),
    pageSize: String(LOCAL_TRACKER_PAGE_SIZE),
  });
  const result = await requestJson(
    `/api/v1/local-tracker/events?${query}`,
    signal,
    request,
    onFailure,
  );
  if (!result.ok) return null;
  const page = parseEventPage(result.payload, afterCursor);
  if (!page) notifyFailure(onFailure, new LocalTrackerApiError("INVALID_RESPONSE", 200));
  return page;
}
