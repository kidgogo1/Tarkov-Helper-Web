import type {
  NativeOverlayBounds,
  NativeOverlayDetachOptions,
  NativeOverlayMode,
  NativeOverlaySizeLimits,
  NativeOverlayUpdateOptions,
} from "./native-overlay";

export const NATIVE_OVERLAY_V2_PROTOCOL_VERSION = 2 as const;
export const NATIVE_OVERLAY_V2_CAPABILITY = "WINDOWS_MULTI_OVERLAY" as const;

export type NativeOverlayKind = "minimap" | "quest-list";

export interface NativeOverlayV2Session {
  protocolVersion: typeof NATIVE_OVERLAY_V2_PROTOCOL_VERSION;
  capability: typeof NATIVE_OVERLAY_V2_CAPABILITY;
  token: string;
  windowTitles: {
    minimap: "Tarkov Helper Web";
    questList: "Tarkov Helper Quest List";
  };
  sizeLimits: NativeOverlaySizeLimits;
}

export interface NativeOverlayV2Claim {
  protocolVersion: typeof NATIVE_OVERLAY_V2_PROTOCOL_VERSION;
  overlayKind: NativeOverlayKind;
  claimId: string;
  expiresAt: string;
}

export interface NativeOverlayV2Attachment {
  protocolVersion: typeof NATIVE_OVERLAY_V2_PROTOCOL_VERSION;
  overlayKind: NativeOverlayKind;
  overlayId: string;
  state: "ATTACHED";
  mode: NativeOverlayMode;
  globalHotkeysAvailable: boolean;
  bounds: NativeOverlayBounds;
}

export interface NativeOverlayV2ClaimOptions {
  windowNonce?: string;
}

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type NativeOverlayV2FailureHandler = (error: NativeOverlayV2ApiError) => void;

const SESSION_PATH = "/api/v2/native-overlay/session";
const CLAIM_PATH = "/api/v2/native-overlay/claims";
const WINDOWS_PATH = "/api/v2/native-overlay/windows";
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;
const QUEST_WINDOW_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UTC_ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/;
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

export class NativeOverlayV2ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number) {
    super("Native multi-overlay request failed.");
    this.name = "NativeOverlayV2ApiError";
    this.code = code;
    this.status = status;
  }
}

function isAbortError(error: unknown): boolean {
  try {
    return typeof error === "object" && error !== null &&
      "name" in error && error.name === "AbortError";
  } catch {
    return false;
  }
}

function notifyFailure(
  onFailure: NativeOverlayV2FailureHandler | undefined,
  error: NativeOverlayV2ApiError,
): void {
  try {
    onFailure?.(error);
  } catch {
    // Optional diagnostics must not affect the native bridge boundary.
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

function isOpaqueId(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isOverlayKind(value: unknown): value is NativeOverlayKind {
  return value === "minimap" || value === "quest-list";
}

function isMode(value: unknown): value is NativeOverlayMode {
  return value === "UNLOCKED" || value === "LOCKED" || value === "CLICK_THROUGH";
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

function parseSession(value: unknown): NativeOverlayV2Session | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "capability",
      "token",
      "windowTitles",
      "sizeLimits",
    ]) ||
    value.protocolVersion !== NATIVE_OVERLAY_V2_PROTOCOL_VERSION ||
    value.capability !== NATIVE_OVERLAY_V2_CAPABILITY ||
    !isOpaqueId(value.token) ||
    !isRecord(value.windowTitles) ||
    !hasExactKeys(value.windowTitles, ["minimap", "questList"]) ||
    value.windowTitles.minimap !== "Tarkov Helper Web" ||
    value.windowTitles.questList !== "Tarkov Helper Quest List" ||
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
    protocolVersion: NATIVE_OVERLAY_V2_PROTOCOL_VERSION,
    capability: NATIVE_OVERLAY_V2_CAPABILITY,
    token: value.token,
    windowTitles: {
      minimap: "Tarkov Helper Web",
      questList: "Tarkov Helper Quest List",
    },
    sizeLimits: {
      minWidth: 240,
      minHeight: 240,
      maxWidth: 1000,
      maxHeight: 1000,
    },
  };
}

function parseClaim(
  value: unknown,
  overlayKind: NativeOverlayKind,
): NativeOverlayV2Claim | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["protocolVersion", "overlayKind", "claimId", "expiresAt"]) ||
    value.protocolVersion !== NATIVE_OVERLAY_V2_PROTOCOL_VERSION ||
    value.overlayKind !== overlayKind ||
    !isOpaqueId(value.claimId) ||
    typeof value.expiresAt !== "string" ||
    value.expiresAt.length > 64 ||
    !UTC_ISO_TIMESTAMP_PATTERN.test(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    return null;
  }
  return {
    protocolVersion: NATIVE_OVERLAY_V2_PROTOCOL_VERSION,
    overlayKind,
    claimId: value.claimId,
    expiresAt: value.expiresAt,
  };
}

function parseAttachment(
  value: unknown,
  overlayKind: NativeOverlayKind,
): NativeOverlayV2Attachment | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "overlayKind",
      "overlayId",
      "state",
      "mode",
      "globalHotkeysAvailable",
      "bounds",
    ]) ||
    value.protocolVersion !== NATIVE_OVERLAY_V2_PROTOCOL_VERSION ||
    value.overlayKind !== overlayKind ||
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
    protocolVersion: NATIVE_OVERLAY_V2_PROTOCOL_VERSION,
    overlayKind,
    overlayId: value.overlayId,
    state: "ATTACHED",
    mode: value.mode,
    globalHotkeysAvailable: value.globalHotkeysAvailable,
    bounds: { left, top, width, height },
  };
}

async function readJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

function headers(session: NativeOverlayV2Session): HeadersInit {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    "X-Tarkov-Overlay": session.token,
  };
}

async function commandError(response: Response): Promise<NativeOverlayV2ApiError> {
  const payload = await readJson(response);
  if (
    isRecord(payload) &&
    hasExactKeys(payload, ["error"]) &&
    isRecord(payload.error) &&
    hasExactKeys(payload.error, ["code", "message"]) &&
    typeof payload.error.code === "string" &&
    ALLOWED_ERROR_CODES.has(payload.error.code) &&
    typeof payload.error.message === "string" &&
    payload.error.message.length <= 256
  ) {
    return new NativeOverlayV2ApiError(payload.error.code, response.status);
  }
  return new NativeOverlayV2ApiError("REQUEST_FAILED", response.status);
}

async function command(
  input: RequestInfo | URL,
  init: RequestInit,
  request: FetchRequest,
): Promise<Response> {
  try {
    return await request(input, init);
  } catch {
    throw new NativeOverlayV2ApiError("NETWORK_ERROR", 0);
  }
}

export async function fetchNativeOverlayV2Session(
  signal?: AbortSignal,
  request: FetchRequest = globalThis.fetch,
  onFailure?: NativeOverlayV2FailureHandler,
): Promise<NativeOverlayV2Session | null> {
  try {
    const response = await request(SESSION_PATH, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status !== 200) {
      if (response.status !== 404) {
        notifyFailure(onFailure, new NativeOverlayV2ApiError("REQUEST_FAILED", response.status));
      }
      return null;
    }
    const session = parseSession(await readJson(response));
    if (!session) {
      notifyFailure(onFailure, new NativeOverlayV2ApiError("INVALID_RESPONSE", response.status));
    }
    return session;
  } catch (error) {
    if (!isAbortError(error)) {
      notifyFailure(onFailure, new NativeOverlayV2ApiError("NETWORK_ERROR", 0));
    }
    return null;
  }
}

export async function beginNativeOverlayV2Claim(
  session: NativeOverlayV2Session,
  overlayKind: NativeOverlayKind,
  options: NativeOverlayV2ClaimOptions = {},
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlayV2Claim> {
  const optionKeys = Object.keys(options);
  const validQuestTitle = overlayKind === "quest-list" &&
    typeof options.windowNonce === "string" &&
    QUEST_WINDOW_NONCE_PATTERN.test(options.windowNonce);
  const validMiniMapOptions = overlayKind === "minimap" &&
    options.windowNonce === undefined;
  if (
    !isOverlayKind(overlayKind) ||
    optionKeys.some((key) => key !== "windowNonce") ||
    (!validQuestTitle && !validMiniMapOptions)
  ) {
    throw new NativeOverlayV2ApiError("INVALID_REQUEST", 0);
  }
  const body: Record<string, unknown> = { overlayKind };
  if (validQuestTitle) body.windowNonce = options.windowNonce;
  const response = await command(CLAIM_PATH, {
    method: "POST",
    cache: "no-store",
    headers: headers(session),
    body: JSON.stringify(body),
  }, request);
  if (response.status !== 201) throw await commandError(response);
  const claim = parseClaim(await readJson(response), overlayKind);
  if (!claim) throw new NativeOverlayV2ApiError("INVALID_RESPONSE", response.status);
  return claim;
}

export async function attachNativeOverlayWindow(
  session: NativeOverlayV2Session,
  overlayKind: NativeOverlayKind,
  claimId: string,
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlayV2Attachment> {
  if (!isOverlayKind(overlayKind) || !isOpaqueId(claimId)) {
    throw new NativeOverlayV2ApiError("INVALID_REQUEST", 0);
  }
  const windowTitle = overlayKind === "minimap"
    ? session.windowTitles.minimap
    : session.windowTitles.questList;
  const requestInit: RequestInit = {
    method: "POST",
    cache: "no-store",
    headers: headers(session),
    body: JSON.stringify({ overlayKind, claimId, windowTitle }),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response: Response;
    try {
      response = await command(WINDOWS_PATH, requestInit, request);
    } catch (error) {
      if (
        attempt === 0 &&
        error instanceof NativeOverlayV2ApiError &&
        error.code === "NETWORK_ERROR"
      ) {
        continue;
      }
      throw error;
    }
    if (response.status !== 201) throw await commandError(response);
    const attachment = parseAttachment(await readJson(response), overlayKind);
    if (attachment?.mode === "UNLOCKED") return attachment;
    if (attempt === 1) {
      throw new NativeOverlayV2ApiError("INVALID_RESPONSE", response.status);
    }
  }
  throw new NativeOverlayV2ApiError("NETWORK_ERROR", 0);
}

export async function updateNativeOverlayWindow(
  session: NativeOverlayV2Session,
  overlayKind: NativeOverlayKind,
  overlayId: string,
  mode: NativeOverlayMode,
  options: NativeOverlayUpdateOptions = {},
  request: FetchRequest = globalThis.fetch,
): Promise<NativeOverlayV2Attachment> {
  const optionKeys = Object.keys(options);
  const hasWidth = options.width !== undefined;
  const hasHeight = options.height !== undefined;
  const hasOpacity = options.opacity !== undefined;
  const invalidSize = hasWidth !== hasHeight || (hasWidth && (
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
    !isOverlayKind(overlayKind) ||
    !isOpaqueId(overlayId) ||
    !isMode(mode) ||
    optionKeys.some((key) => key !== "width" && key !== "height" && key !== "opacity") ||
    invalidSize ||
    invalidOpacity
  ) {
    throw new NativeOverlayV2ApiError("INVALID_REQUEST", 0);
  }
  const body: Record<string, unknown> = { overlayKind, overlayId, mode };
  if (hasWidth && hasHeight) {
    body.width = options.width;
    body.height = options.height;
  }
  if (hasOpacity) body.opacity = options.opacity;
  const response = await command(WINDOWS_PATH, {
    method: "PATCH",
    cache: "no-store",
    headers: headers(session),
    body: JSON.stringify(body),
  }, request);
  if (response.status !== 200) throw await commandError(response);
  const attachment = parseAttachment(await readJson(response), overlayKind);
  if (
    !attachment ||
    attachment.overlayId !== overlayId ||
    attachment.mode !== mode ||
    (hasWidth && hasHeight && (
      attachment.bounds.width !== options.width ||
      attachment.bounds.height !== options.height
    ))
  ) {
    throw new NativeOverlayV2ApiError("INVALID_RESPONSE", response.status);
  }
  return attachment;
}

export async function detachNativeOverlayWindow(
  session: NativeOverlayV2Session,
  overlayKind: NativeOverlayKind,
  overlayId: string,
  options: NativeOverlayDetachOptions = {},
  request: FetchRequest = globalThis.fetch,
): Promise<void> {
  if (!isOverlayKind(overlayKind) || !isOpaqueId(overlayId)) {
    throw new NativeOverlayV2ApiError("INVALID_REQUEST", 0);
  }
  const response = await command(WINDOWS_PATH, {
    method: "DELETE",
    cache: "no-store",
    ...(options.keepalive === undefined ? {} : { keepalive: options.keepalive }),
    headers: headers(session),
    body: JSON.stringify({ overlayKind, overlayId }),
  }, request);
  if (response.status !== 204) throw await commandError(response);
}
