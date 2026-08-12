export const LOCAL_TRACKER_PROTOCOL_VERSION = 1 as const;
export const LOCAL_TRACKER_PAGE_SIZE = 100 as const;

export type ScreenshotWatcherStatus =
  | { state: "WATCHING"; folderPath: string }
  | { state: "NOT_FOUND" }
  | { state: "ERROR"; message: string };

export interface LocalTrackerStatus {
  protocolVersion: typeof LOCAL_TRACKER_PROTOCOL_VERSION;
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
  data: ScreenshotCreatedEvent[];
  pagination: LocalTrackerPagination;
}

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

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
  const screenshotWatcher = parseWatcherStatus(value.screenshotWatcher);
  if (!screenshotWatcher) return null;
  return {
    protocolVersion: LOCAL_TRACKER_PROTOCOL_VERSION,
    screenshotWatcher,
    latestCursor: value.latestCursor,
  };
}

function parseScreenshotEvent(value: unknown): ScreenshotCreatedEvent | null {
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
    !Number.isFinite(Date.parse(value.detectedAt))
  ) {
    return null;
  }
  return {
    type: "SCREENSHOT_CREATED",
    sequence: value.sequence,
    fileName: value.fileName,
    detectedAt: value.detectedAt,
    ...(isNonEmptyString(value.mapKey, 128) ? { mapKey: value.mapKey.trim() } : {}),
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
    data,
    pagination: {
      afterCursor,
      nextCursor,
      hasMore,
      ...(isResetRequired === undefined ? {} : { isResetRequired }),
    },
  };
}

async function requestJson(
  path: string,
  signal: AbortSignal | undefined,
  request: FetchRequest,
): Promise<unknown | null> {
  try {
    const response = await request(path, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) return null;
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

export async function fetchLocalTrackerStatus(
  signal?: AbortSignal,
  request: FetchRequest = globalThis.fetch,
): Promise<LocalTrackerStatus | null> {
  const payload = await requestJson("/api/v1/local-tracker/status", signal, request);
  return parseStatus(payload);
}

export async function fetchLocalTrackerEvents(
  afterCursor: number,
  signal?: AbortSignal,
  request: FetchRequest = globalThis.fetch,
): Promise<LocalTrackerEventPage | null> {
  if (!isNonNegativeInteger(afterCursor)) return null;
  const query = new URLSearchParams({
    afterCursor: String(afterCursor),
    pageSize: String(LOCAL_TRACKER_PAGE_SIZE),
  });
  const payload = await requestJson(
    `/api/v1/local-tracker/events?${query}`,
    signal,
    request,
  );
  return parseEventPage(payload, afterCursor);
}
