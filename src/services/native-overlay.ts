export const NATIVE_OVERLAY_PROTOCOL_VERSION = 1 as const;
export const NATIVE_OVERLAY_CAPABILITY = "WINDOWS_DOCUMENT_PIP" as const;
export const NATIVE_OVERLAY_HOTKEY_EVENT = "tarkov-helper:native-hotkey" as const;

export type NativeOverlayMode = "UNLOCKED" | "LOCKED" | "CLICK_THROUGH";
export type NativeOverlayEventAction = "ZOOM_IN" | "ZOOM_OUT";
export type NativeOverlayHotkeyAction =
  | "MINIMAP_ZOOM_IN"
  | "MINIMAP_ZOOM_OUT";

export interface NativeOverlaySizeLimits {
  minWidth: 240;
  minHeight: 240;
  maxWidth: 1000;
  maxHeight: 1000;
}

export interface NativeOverlaySession {
  protocolVersion: typeof NATIVE_OVERLAY_PROTOCOL_VERSION;
  capability: typeof NATIVE_OVERLAY_CAPABILITY;
  token: string;
  windowTitle: string;
  sizeLimits: NativeOverlaySizeLimits;
}

export interface NativeOverlayClaim {
  protocolVersion: typeof NATIVE_OVERLAY_PROTOCOL_VERSION;
  claimId: string;
  expiresAt: string;
}

export interface NativeOverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface NativeOverlayAttachment {
  protocolVersion: typeof NATIVE_OVERLAY_PROTOCOL_VERSION;
  overlayId: string;
  state: "ATTACHED";
  mode: NativeOverlayMode;
  globalHotkeysAvailable: boolean;
  bounds: NativeOverlayBounds;
}

export interface NativeOverlayEvent {
  cursor: number;
  action: NativeOverlayEventAction;
}

export interface NativeOverlayEventBatch {
  protocolVersion: typeof NATIVE_OVERLAY_PROTOCOL_VERSION;
  latestCursor: number;
  events: NativeOverlayEvent[];
}

export interface NativeOverlayDetachOptions {
  keepalive?: boolean;
}

export interface NativeOverlayUpdateOptions {
  width?: number;
  height?: number;
  /** Window alpha used by the native layered overlay (0.1 = mostly transparent). */
  opacity?: number;
}

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const SESSION_PATH = "/api/v1/native-overlay/session";
const CLAIM_PATH = "/api/v1/native-overlay/claims";
const MINIMAP_PATH = "/api/v1/native-overlay/minimap";
const EVENTS_PATH = "/api/v1/native-overlay/events";
const EVENT_BATCH_LIMIT = 100;
const EVENT_POLL_INTERVAL_MS = 200;
const EVENT_POLL_RETRY_LIMIT = 3;
const EVENT_POLL_MAX_RETRY_DELAY_MS = 800;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const UTC_ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
const ALLOWED_ERROR_CODES = new Set([
  "AMBIGUOUS_WINDOW",
  "CLAIM_NOT_FOUND",
  "FORBIDDEN",
  "INVALID_JSON",
  "INVALID_QUERY",
  "INVALID_REQUEST",
  "NATIVE_FAILURE",
  "OVERLAY_ALREADY_ATTACHED",
  "OVERLAY_NOT_FOUND",
  "WINDOW_NOT_FOUND",
]);

export class NativeOverlayApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super("Native overlay request failed.");
    this.name = "NativeOverlayApiError";
    this.code = code;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key));
}

function isBoundedString(
  value: unknown,
  maximumLength: number,
): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    value.trim().length > 0 &&
    !value.includes("\0");
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isWin32Coordinate(value: unknown): value is number {
  return isSafeInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647;
}

function isWindowDimension(value: unknown): value is number {
  return isSafeInteger(value) && value >= 1 && value <= 32_768;
}

function parseSession(value: unknown): NativeOverlaySession | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "capability",
      "token",
      "windowTitle",
      "sizeLimits",
    ]) ||
    value.protocolVersion !== NATIVE_OVERLAY_PROTOCOL_VERSION ||
    value.capability !== NATIVE_OVERLAY_CAPABILITY ||
    !isOpaqueId(value.token) ||
    value.windowTitle !== "Tarkov Helper Web" ||
    !isRecord(value.sizeLimits) ||
    !hasExactKeys(value.sizeLimits, [
      "minWidth",
      "minHeight",
      "maxWidth",
      "maxHeight",
    ]) ||
    value.sizeLimits.minWidth !== 240 ||
    value.sizeLimits.minHeight !== 240 ||
    value.sizeLimits.maxWidth !== 1000 ||
    value.sizeLimits.maxHeight !== 1000
  ) {
    return null;
  }

  return {
    protocolVersion: NATIVE_OVERLAY_PROTOCOL_VERSION,
    capability: NATIVE_OVERLAY_CAPABILITY,
    token: value.token,
    windowTitle: value.windowTitle,
    sizeLimits: {
      minWidth: 240,
      minHeight: 240,
      maxWidth: 1000,
      maxHeight: 1000,
    },
  };
}

function parseClaim(value: unknown): NativeOverlayClaim | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["protocolVersion", "claimId", "expiresAt"]) ||
    value.protocolVersion !== NATIVE_OVERLAY_PROTOCOL_VERSION ||
    !isOpaqueId(value.claimId) ||
    !isBoundedString(value.expiresAt, 64) ||
    !UTC_ISO_TIMESTAMP_PATTERN.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  return {
    protocolVersion: NATIVE_OVERLAY_PROTOCOL_VERSION,
    claimId: value.claimId,
    expiresAt: value.expiresAt,
  };
}

function isMode(value: unknown): value is NativeOverlayMode {
  return value === "UNLOCKED" ||
    value === "LOCKED" ||
    value === "CLICK_THROUGH";
}

function parseAttachment(
  value: unknown,
): NativeOverlayAttachment | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "overlayId",
      "state",
      "mode",
      "globalHotkeysAvailable",
      "bounds",
    ]) ||
    value.protocolVersion !== NATIVE_OVERLAY_PROTOCOL_VERSION ||
    !isOpaqueId(value.overlayId) ||
    value.state !== "ATTACHED" ||
    !isMode(value.mode) ||
    typeof value.globalHotkeysAvailable !== "boolean" ||
    !isRecord(value.bounds) ||
    !hasExactKeys(value.bounds, ["left", "top", "width", "height"])
  ) {
    return null;
  }

  const { left, top, width, height } = value.bounds;
  if (
    !isWin32Coordinate(left) ||
    !isWin32Coordinate(top) ||
    !isWindowDimension(width) ||
    !isWindowDimension(height)
  ) {
    return null;
  }

  return {
    protocolVersion: NATIVE_OVERLAY_PROTOCOL_VERSION,
    overlayId: value.overlayId,
    state: "ATTACHED",
    mode: value.mode,
    globalHotkeysAvailable: value.globalHotkeysAvailable,
    bounds: { left, top, width, height },
  };
}

function parseEventBatch(
  value: unknown,
  after: number,
): NativeOverlayEventBatch | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["protocolVersion", "latestCursor", "events"]) ||
    value.protocolVersion !== NATIVE_OVERLAY_PROTOCOL_VERSION ||
    !isSafeInteger(value.latestCursor) ||
    value.latestCursor < after ||
    !Array.isArray(value.events) ||
    value.events.length > EVENT_BATCH_LIMIT
  ) {
    return null;
  }

  const events: NativeOverlayEvent[] = [];
  let previousCursor = after;
  for (const candidate of value.events) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ["cursor", "action"]) ||
      !isSafeInteger(candidate.cursor) ||
      candidate.cursor <= previousCursor ||
      candidate.cursor > value.latestCursor ||
      (candidate.action !== "ZOOM_IN" && candidate.action !== "ZOOM_OUT")
    ) {
      return null;
    }
    events.push({
      cursor: candidate.cursor,
      action: candidate.action,
    });
    previousCursor = candidate.cursor;
  }

  if (
    (events.length === 0 && value.latestCursor !== after) ||
    (events.length > 0 && previousCursor !== value.latestCursor)
  ) {
    return null;
  }

  return {
    protocolVersion: NATIVE_OVERLAY_PROTOCOL_VERSION,
    latestCursor: value.latestCursor,
    events,
  };
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function authenticatedHeaders(session: NativeOverlaySession): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Tarkov-Overlay": session.token,
  };
}

function authenticatedReadHeaders(session: NativeOverlaySession): HeadersInit {
  return {
    Accept: "application/json",
    "X-Tarkov-Overlay": session.token,
  };
}

async function commandError(response: Response): Promise<NativeOverlayApiError> {
  const payload = await readJson(response);
  if (
    isRecord(payload) &&
    hasExactKeys(payload, ["error"]) &&
    isRecord(payload.error) &&
    hasExactKeys(payload.error, ["code", "message"]) &&
    typeof payload.error.code === "string" &&
    ALLOWED_ERROR_CODES.has(payload.error.code) &&
    isBoundedString(payload.error.message, 1_000)
  ) {
    return new NativeOverlayApiError(payload.error.code, response.status);
  }
  return new NativeOverlayApiError("REQUEST_FAILED", response.status);
}

async function fetchCommand(
  input: RequestInfo | URL,
  init: RequestInit,
  request: FetchRequest,
): Promise<Response> {
  try {
    return await request(input, init);
  } catch {
    throw new NativeOverlayApiError("NETWORK_ERROR", 0);
  }
}

export async function fetchNativeOverlaySession(
  signal?: AbortSignal,
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlaySession | null> {
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

export async function fetchNativeOverlayEvents(
  session: NativeOverlaySession,
  after: number,
  signal?: AbortSignal,
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlayEventBatch> {
  if (!isSafeInteger(after) || after < 0) {
    throw new NativeOverlayApiError("INVALID_REQUEST", 0);
  }
  const response = await fetchCommand(`${EVENTS_PATH}?after=${after}`, {
    method: "GET",
    cache: "no-store",
    headers: authenticatedReadHeaders(session),
    signal,
  }, request);
  if (response.status !== 200) throw await commandError(response);
  const batch = parseEventBatch(await readJson(response), after);
  if (!batch) throw new NativeOverlayApiError("INVALID_RESPONSE", response.status);
  return batch;
}

function waitForNativeEventPoll(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function dispatchNativeOverlayHotkey(
  target: EventTarget,
  action: NativeOverlayEventAction,
): void {
  const hotkeyAction: NativeOverlayHotkeyAction = action === "ZOOM_IN"
    ? "MINIMAP_ZOOM_IN"
    : "MINIMAP_ZOOM_OUT";
  target.dispatchEvent(new CustomEvent(NATIVE_OVERLAY_HOTKEY_EVENT, {
    detail: {
      protocolVersion: NATIVE_OVERLAY_PROTOCOL_VERSION,
      action: hotkeyAction,
    },
  }));
}

export async function pollNativeOverlayEvents(
  session: NativeOverlaySession,
  signal: AbortSignal,
  target: EventTarget,
  request: FetchRequest = globalThis.fetch,
): Promise<void> {
  let cursor = 0;
  let consecutiveFailures = 0;
  let nextDelayMs = EVENT_POLL_INTERVAL_MS;

  while (await waitForNativeEventPoll(nextDelayMs, signal)) {
    try {
      const batch = await fetchNativeOverlayEvents(
        session,
        cursor,
        signal,
        request,
      );
      if (signal.aborted) return;
      for (const event of batch.events) {
        if (signal.aborted) return;
        if (event.cursor <= cursor) continue;
        cursor = event.cursor;
        dispatchNativeOverlayHotkey(target, event.action);
      }
      cursor = batch.latestCursor;
      consecutiveFailures = 0;
      nextDelayMs = EVENT_POLL_INTERVAL_MS;
    } catch (error) {
      if (signal.aborted) return;
      const retryable = error instanceof NativeOverlayApiError &&
        (error.code === "NETWORK_ERROR" || error.status >= 500);
      consecutiveFailures += 1;
      if (!retryable || consecutiveFailures > EVENT_POLL_RETRY_LIMIT) return;
      nextDelayMs = Math.min(
        EVENT_POLL_INTERVAL_MS * 2 ** (consecutiveFailures - 1),
        EVENT_POLL_MAX_RETRY_DELAY_MS,
      );
    }
  }
}

export async function beginNativeOverlayClaim(
  session: NativeOverlaySession,
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlayClaim> {
  const response = await fetchCommand(CLAIM_PATH, {
    method: "POST",
    cache: "no-store",
    headers: authenticatedHeaders(session),
    body: "{}",
  }, request);
  if (response.status !== 201) throw await commandError(response);
  const claim = parseClaim(await readJson(response));
  if (!claim) throw new NativeOverlayApiError("INVALID_RESPONSE", response.status);
  return claim;
}

export async function attachNativeMiniMap(
  session: NativeOverlaySession,
  claimId: string,
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlayAttachment> {
  if (!isOpaqueId(claimId)) {
    throw new NativeOverlayApiError("INVALID_REQUEST", 0);
  }
  const response = await fetchCommand(MINIMAP_PATH, {
    method: "POST",
    cache: "no-store",
    headers: authenticatedHeaders(session),
    body: JSON.stringify({ claimId, windowTitle: session.windowTitle }),
  }, request);
  if (response.status !== 201) throw await commandError(response);
  const attachment = parseAttachment(await readJson(response));
  if (!attachment || attachment.mode !== "UNLOCKED") {
    throw new NativeOverlayApiError("INVALID_RESPONSE", response.status);
  }
  return attachment;
}

export async function updateNativeMiniMap(
  session: NativeOverlaySession,
  overlayId: string,
  mode: NativeOverlayMode,
  options: NativeOverlayUpdateOptions = {},
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlayAttachment> {
  const optionKeys = Object.keys(options);
  const hasWidth = options.width !== undefined;
  const hasHeight = options.height !== undefined;
  const hasOpacity = options.opacity !== undefined;
  const invalidSize =
    hasWidth !== hasHeight ||
    (hasWidth && (
      !isSafeInteger(options.width) ||
      !isSafeInteger(options.height) ||
      options.width < session.sizeLimits.minWidth ||
      options.height < session.sizeLimits.minHeight ||
      options.width > session.sizeLimits.maxWidth ||
      options.height > session.sizeLimits.maxHeight ||
      mode === "UNLOCKED"
    ));
  const invalidOpacity = hasOpacity && (
    typeof options.opacity !== "number" ||
    !Number.isFinite(options.opacity) ||
    options.opacity < 0.1 ||
    options.opacity > 1
  );
  if (
    !isOpaqueId(overlayId) ||
    !isMode(mode) ||
    optionKeys.some((key) => key !== "width" && key !== "height" && key !== "opacity") ||
    invalidSize ||
    invalidOpacity
  ) {
    throw new NativeOverlayApiError("INVALID_REQUEST", 0);
  }
  const body: Record<string, unknown> = { overlayId, mode };
  if (hasWidth && hasHeight) {
    body.width = options.width;
    body.height = options.height;
  }
  if (hasOpacity) body.opacity = options.opacity;
  const response = await fetchCommand(MINIMAP_PATH, {
    method: "PATCH",
    cache: "no-store",
    headers: authenticatedHeaders(session),
    body: JSON.stringify(body),
  }, request);
  if (response.status !== 200) throw await commandError(response);
  const attachment = parseAttachment(await readJson(response));
  if (
    !attachment ||
    attachment.overlayId !== overlayId ||
    attachment.mode !== mode ||
    (hasWidth && hasHeight && (
      attachment.bounds.width !== options.width ||
      attachment.bounds.height !== options.height
    ))
  ) {
    throw new NativeOverlayApiError("INVALID_RESPONSE", response.status);
  }
  return attachment;
}

export async function detachNativeMiniMap(
  session: NativeOverlaySession,
  overlayId: string,
  options: NativeOverlayDetachOptions = {},
  request: FetchRequest = globalThis.fetch,
): Promise<void> {
  if (!isOpaqueId(overlayId)) {
    throw new NativeOverlayApiError("INVALID_REQUEST", 0);
  }
  const response = await fetchCommand(MINIMAP_PATH, {
    method: "DELETE",
    cache: "no-store",
    ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
    headers: authenticatedHeaders(session),
    body: JSON.stringify({ overlayId }),
  }, request);
  if (response.status !== 204) throw await commandError(response);
}
