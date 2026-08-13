import packageManifest from "../../package.json";

const STORAGE_KEY = "tarkov-helper:client-diagnostics:v1";
const EVENT_KEY_PREFIX = `${STORAGE_KEY}:event:`;
const INITIAL_GENERATION = "g-initial";
const SCHEMA_VERSION = 1 as const;
const MAX_ENTRIES = 100;
const MAX_STORAGE_BYTES = 64 * 1024;
const MAX_MESSAGE_LENGTH = 500;
const MAX_STACK_LENGTH = 2_000;
const MAX_DUPLICATE_COUNT = 1_000_000_000;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,63}$/;
const OPAQUE_TOKEN_PATTERN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g;
const HEADER_PATTERN = /\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie|X-Tarkov-[A-Za-z0-9-]+)\s*:[^\r\n]*/gi;
const SENSITIVE_FIELD_PATTERN = /(?<![A-Za-z0-9_])["']?(?:secret|password|token|nonce|api[-_]?key|claimId|overlayId|candidateId|healthNonce|updateNonce|controlToken|leaseToken)["']?\s*[:=][\s\S]*/gi;
const FILE_URL_PATTERN = /file:\/\/\/[^\r\n"<>]+/gi;
const WINDOWS_PATH_PATTERN = /(?:\b[A-Za-z]:[\\/]|\\\\)[^\r\n"<>|]+/g;
const USER_PATH_PATTERN = /\/(?:Users|home)\/[^\r\n"<>]+/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

export type ClientDiagnosticSource =
  | "data"
  | "global"
  | "optional-resource"
  | "react"
  | "storage"
  | "update";

export type ClientDiagnosticLevel = "error" | "warning";

export interface ClientDiagnosticEntry {
  schemaVersion: typeof SCHEMA_VERSION;
  occurredAt: string;
  lastOccurredAt: string;
  level: ClientDiagnosticLevel;
  source: ClientDiagnosticSource;
  code: string;
  message: string;
  stack?: string;
  operation?: string;
  currentVersion?: string;
  targetVersion?: string;
  appVersion: string;
  count: number;
}

export interface ClientDiagnosticSnapshot {
  entries: readonly ClientDiagnosticEntry[];
  persistence: "localStorage" | "memory";
}

export interface ClientDiagnosticInput {
  source: ClientDiagnosticSource;
  code: string;
  error?: unknown;
  message?: string;
  level?: ClientDiagnosticLevel;
  operation?: string;
  currentVersion?: string;
  targetVersion?: string;
}

interface StoredDiagnostics {
  schemaVersion: typeof SCHEMA_VERSION;
  generation: string;
}

interface StoredDiagnosticEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  generation: string;
  entry: ClientDiagnosticEntry;
}

interface InstalledHandlers {
  references: number;
  onError: EventListener;
  onUnhandledRejection: EventListener;
}

const listeners = new Set<() => void>();
const installedHandlers = new WeakMap<EventTarget, InstalledHandlers>();
let entries: ClientDiagnosticEntry[] = [];
let memoryEvents: ClientDiagnosticEntry[] = [];
let initialized = false;
let persistence: ClientDiagnosticSnapshot["persistence"] = "localStorage";
let recording = false;
let storageGeneration = INITIAL_GENERATION;
let identifierSequence = 0;
let storageWriteFailed = false;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "[REDACTED_URL]";
  }
}

function sanitizeText(value: string, maximumLength: number): string {
  const rawLimit = maximumLength >= MAX_STACK_LENGTH ? 32 * 1024 : 16 * 1024;
  const wasRawTruncated = value.length > rawLimit;
  // Collapse line/control boundaries first so a forged continuation cannot
  // escape a fail-closed header or sensitive-field remainder rule.
  const boundedValue = value.slice(0, wasRawTruncated ? rawLimit + 128 : rawLimit)
    // eslint-disable-next-line no-control-regex -- controls are collapsed before privacy patterns are applied
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  const scrubbed = boundedValue
    .replace(HEADER_PATTERN, "[REDACTED_HEADER]")
    .replace(FILE_URL_PATTERN, "[REDACTED_PATH]")
    .replace(WINDOWS_PATH_PATTERN, "[REDACTED_PATH]")
    .replace(USER_PATH_PATTERN, "[REDACTED_PATH]")
    .replace(URL_PATTERN, normalizeUrl)
    .replace(SENSITIVE_FIELD_PATTERN, "[REDACTED]")
    .replace(OPAQUE_TOKEN_PATTERN, "[REDACTED]");
  const sanitized = scrubbed
    .replace(/\s+/g, " ")
    .trim();
  if (wasRawTruncated) {
    const safePrefix = sanitized.slice(0, Math.max(0, sanitized.length - 128)).trimEnd();
    const marker = "[TRUNCATED]";
    if (!safePrefix) return marker;
    return `${safePrefix.slice(0, Math.max(0, maximumLength - marker.length - 1))} ${marker}`;
  }
  if (sanitized.length <= maximumLength) return sanitized;
  return `${sanitized.slice(0, Math.max(0, maximumLength - 1))}…`;
}

function normalizeError(error: unknown, fallbackMessage?: string): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: sanitizeText(error.message || error.name || "알 수 없는 오류", MAX_MESSAGE_LENGTH),
      stack: error.stack ? sanitizeText(error.stack, MAX_STACK_LENGTH) : undefined,
    };
  }
  if (typeof error === "string") {
    return { message: sanitizeText(error, MAX_MESSAGE_LENGTH) };
  }
  return {
    message: sanitizeText(fallbackMessage || "세부 정보를 안전하게 기록할 수 없는 오류", MAX_MESSAGE_LENGTH),
  };
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const ENTRY_KEYS = new Set([
  "schemaVersion", "occurredAt", "lastOccurredAt", "level", "source", "code", "message", "stack",
  "operation", "currentVersion", "targetVersion", "appVersion", "count",
]);
const DIAGNOSTIC_SOURCES = new Set<ClientDiagnosticSource>([
  "data", "global", "optional-resource", "react", "storage", "update",
]);

function optionalStoredText(value: unknown, maximumLength: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maximumLength) return null;
  return sanitizeText(value, maximumLength);
}

function storedTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  try {
    return new Date(value).toISOString() === value ? value : null;
  } catch {
    return null;
  }
}

function parseStoredEntry(value: unknown): ClientDiagnosticEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !ENTRY_KEYS.has(key))) return null;
  const occurredAt = storedTimestamp(record.occurredAt);
  const lastOccurredAt = storedTimestamp(record.lastOccurredAt);
  const stack = optionalStoredText(record.stack, MAX_STACK_LENGTH);
  const operation = optionalStoredText(record.operation, 32);
  const currentVersion = optionalStoredText(record.currentVersion, 64);
  const targetVersion = optionalStoredText(record.targetVersion, 64);
  if (
    record.schemaVersion !== SCHEMA_VERSION ||
    !occurredAt ||
    !lastOccurredAt ||
    (record.level !== "error" && record.level !== "warning") ||
    !DIAGNOSTIC_SOURCES.has(record.source as ClientDiagnosticSource) ||
    typeof record.code !== "string" ||
    !CODE_PATTERN.test(record.code) ||
    typeof record.message !== "string" ||
    record.message.length > MAX_MESSAGE_LENGTH ||
    typeof record.appVersion !== "string" ||
    record.appVersion.length > 64 ||
    typeof record.count !== "number" ||
    !Number.isSafeInteger(record.count) ||
    record.count <= 0 ||
    record.count > MAX_DUPLICATE_COUNT ||
    stack === null || operation === null || currentVersion === null || targetVersion === null
  ) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    occurredAt,
    lastOccurredAt,
    level: record.level,
    source: record.source as ClientDiagnosticSource,
    code: record.code,
    message: sanitizeText(record.message, MAX_MESSAGE_LENGTH),
    ...(stack ? { stack } : {}),
    ...(operation ? { operation } : {}),
    ...(currentVersion ? { currentVersion } : {}),
    ...(targetVersion ? { targetVersion } : {}),
    appVersion: sanitizeText(record.appVersion, 64),
    count: record.count,
  };
}

function parseStoredDiagnostics(raw: string): StoredDiagnostics | null {
  if (utf8Bytes(raw) > MAX_STORAGE_BYTES) return null;
  const parsed = JSON.parse(raw) as Partial<StoredDiagnostics>;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const keys = Object.keys(parsed);
  if (
    keys.length !== 2 ||
    !keys.every((key) => key === "schemaVersion" || key === "generation") ||
    parsed.schemaVersion !== SCHEMA_VERSION ||
    typeof parsed.generation !== "string" ||
    !/^[A-Za-z0-9-]{1,80}$/.test(parsed.generation)
  ) return null;
  return {
    schemaVersion: SCHEMA_VERSION,
    generation: parsed.generation,
  };
}

function parseStoredDiagnosticEvent(raw: string): StoredDiagnosticEvent | null {
  if (utf8Bytes(raw) > 8 * 1024) return null;
  const parsed = JSON.parse(raw) as Partial<StoredDiagnosticEvent>;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  if (
    Object.keys(parsed).length !== 3 ||
    !Object.keys(parsed).every((key) => key === "schemaVersion" || key === "generation" || key === "entry") ||
    parsed.schemaVersion !== SCHEMA_VERSION ||
    typeof parsed.generation !== "string" ||
    !/^[A-Za-z0-9-]{1,80}$/.test(parsed.generation)
  ) return null;
  const entry = parseStoredEntry(parsed.entry);
  return entry ? { schemaVersion: SCHEMA_VERSION, generation: parsed.generation, entry } : null;
}

function readStoredDiagnostics(storage: Storage): StoredDiagnostics | null {
  const raw = storage.getItem(STORAGE_KEY);
  return raw ? parseStoredDiagnostics(raw) : null;
}

function storedEventKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(EVENT_KEY_PREFIX)) keys.push(key);
  }
  return keys;
}

function readStoredEvents(storage: Storage, generation: string): Array<{ key: string; entry: ClientDiagnosticEntry }> {
  const result: Array<{ key: string; entry: ClientDiagnosticEntry }> = [];
  for (const key of storedEventKeys(storage)) {
    try {
      const raw = storage.getItem(key);
      if (!raw) continue;
      const event = parseStoredDiagnosticEvent(raw);
      if (!event || event.generation !== generation) continue;
      result.push({ key, entry: event.entry });
    } catch {
      // Ignore an individually corrupt/unavailable event. The manifest remains authoritative.
    }
  }
  return result;
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  const storage = safeStorage();
  if (!storage) {
    persistence = "memory";
    return;
  }
  try {
    const stored = readStoredDiagnostics(storage);
    if (!stored) {
      if (storage.getItem(STORAGE_KEY) !== null) {
        persistence = "memory";
        return;
      }
      storageGeneration = INITIAL_GENERATION;
      storage.setItem(STORAGE_KEY, serializedManifest(storageGeneration));
      entries = aggregateEntries(readStoredEvents(storage, storageGeneration).map((event) => event.entry));
      return;
    }
    storageGeneration = stored.generation;
    // Diagnostics storage was introduced with this schema. Treat any entries
    // in the manifest as a one-time import, then keep new occurrences in
    // generation-scoped immutable event records.
    entries = aggregateEntries(readStoredEvents(storage, storageGeneration).map((event) => event.entry));
  } catch {
    persistence = "memory";
    entries = [];
  }
}

function serializedManifest(generation = storageGeneration): string {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    generation,
  } satisfies StoredDiagnostics);
}

function boundEntries(candidateEntries: ClientDiagnosticEntry[]): ClientDiagnosticEntry[] {
  const bounded = candidateEntries.slice(-MAX_ENTRIES);
  while (bounded.length > 0 && utf8Bytes(JSON.stringify(bounded)) > MAX_STORAGE_BYTES) {
    bounded.shift();
  }
  return bounded;
}

function diagnosticIdentity(entry: ClientDiagnosticEntry): string {
  return JSON.stringify([
    entry.source,
    entry.code,
    entry.message,
    entry.operation,
    entry.currentVersion,
    entry.targetVersion,
  ]);
}

function mergeEntries(
  storedEntries: readonly ClientDiagnosticEntry[],
  memoryEntries: readonly ClientDiagnosticEntry[],
): ClientDiagnosticEntry[] {
  const merged = new Map<string, ClientDiagnosticEntry>();
  for (const candidate of [...storedEntries, ...memoryEntries]) {
    const identity = diagnosticIdentity(candidate);
    const existing = merged.get(identity);
    if (!existing) {
      merged.set(identity, { ...candidate });
      continue;
    }
    const newer = candidate.lastOccurredAt >= existing.lastOccurredAt ? candidate : existing;
    merged.delete(identity);
    merged.set(identity, {
      ...newer,
      occurredAt: candidate.occurredAt < existing.occurredAt ? candidate.occurredAt : existing.occurredAt,
      lastOccurredAt: candidate.lastOccurredAt > existing.lastOccurredAt
        ? candidate.lastOccurredAt
        : existing.lastOccurredAt,
      count: Math.min(MAX_DUPLICATE_COUNT, candidate.count + existing.count),
    });
  }
  return boundEntries([...merged.values()]);
}

function aggregateEntries(candidateEntries: readonly ClientDiagnosticEntry[]): ClientDiagnosticEntry[] {
  return mergeEntries([], [...candidateEntries].sort((left, right) =>
    left.lastOccurredAt.localeCompare(right.lastOccurredAt)
  ));
}

function refreshFromStorage(): void {
  const storage = safeStorage();
  if (!storage) {
    persistence = "memory";
    return;
  }
  try {
    const stored = readStoredDiagnostics(storage);
    if (!stored) {
      if (storage.getItem(STORAGE_KEY) !== null) {
        persistence = "memory";
        return;
      }
      if (storageGeneration !== INITIAL_GENERATION) {
        storageGeneration = INITIAL_GENERATION;
        memoryEvents = [];
      }
      storage.setItem(STORAGE_KEY, serializedManifest(storageGeneration));
      entries = aggregateEntries([
        ...readStoredEvents(storage, storageGeneration).map((event) => event.entry),
        ...memoryEvents,
      ]);
      const pending = memoryEvents;
      memoryEvents = [];
      for (let index = 0; index < pending.length; index += 1) {
        try {
          storage.setItem(nextEventKey(), serializedEvent(pending[index]));
        } catch (error: unknown) {
          memoryEvents = aggregateEntries(pending.slice(index));
          throw error;
        }
      }
      cleanupStoredEvents(storage);
      storageWriteFailed = false;
      persistence = "localStorage";
      return;
    }
    if (stored.generation !== storageGeneration) {
      storageGeneration = stored.generation;
      memoryEvents = [];
      entries = aggregateEntries(readStoredEvents(storage, storageGeneration).map((event) => event.entry));
      if (!storageWriteFailed) persistence = "localStorage";
      return;
    }
    if (memoryEvents.length > 0) {
      const pending = memoryEvents;
      memoryEvents = [];
      for (let index = 0; index < pending.length; index += 1) {
        try {
          storage.setItem(nextEventKey(), serializedEvent(pending[index]));
        } catch (error: unknown) {
          memoryEvents = aggregateEntries(pending.slice(index));
          throw error;
        }
      }
      cleanupStoredEvents(storage);
    }
    entries = aggregateEntries([
      ...readStoredEvents(storage, storageGeneration).map((event) => event.entry),
      ...memoryEvents,
    ]);
    if (memoryEvents.length === 0) {
      storageWriteFailed = false;
      persistence = "localStorage";
    }
  } catch {
    persistence = "memory";
  }
}

function nextStorageGeneration(): string {
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") {
      return `g-${globalThis.crypto.randomUUID()}`;
    }
    if (typeof globalThis.crypto?.getRandomValues === "function") {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
      return `g-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    }
  } catch {
    // Fall through to a best-effort per-context identifier.
  }
  identifierSequence += 1;
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}-${identifierSequence.toString(36)}`;
}

function nextEventKey(): string {
  identifierSequence += 1;
  let random = "";
  try {
    if (typeof globalThis.crypto?.randomUUID === "function") random = globalThis.crypto.randomUUID();
    else if (typeof globalThis.crypto?.getRandomValues === "function") {
      const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
      random = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // The monotonic suffix still prevents collisions within this context.
  }
  if (!random) random = `${Math.random().toString(36).slice(2, 14)}-${identifierSequence.toString(36)}`;
  return `${EVENT_KEY_PREFIX}${storageGeneration}:${Date.now().toString(36)}:${random}`;
}

function serializedEvent(entry: ClientDiagnosticEntry): string {
  return JSON.stringify({ schemaVersion: SCHEMA_VERSION, generation: storageGeneration, entry } satisfies StoredDiagnosticEvent);
}

function cleanupStoredEvents(storage: Storage): void {
  const cleanupGeneration = storageGeneration;
  const allKeys = storedEventKeys(storage);
  let current = readStoredEvents(storage, cleanupGeneration)
    .sort((left, right) => left.entry.lastOccurredAt.localeCompare(right.entry.lastOccurredAt));
  const retainedIdentities = new Set(
    aggregateEntries(current.map((event) => event.entry)).map(diagnosticIdentity),
  );
  current = current.filter((event) => retainedIdentities.has(diagnosticIdentity(event.entry)));
  const retainedKeys = new Set(current.map((event) => event.key));
  let totalBytes = utf8Bytes(serializedManifest(cleanupGeneration));
  for (const event of current) {
    const raw = storage.getItem(event.key);
    totalBytes += raw ? utf8Bytes(raw) : 0;
  }
  const manifestBeforeMutation = readStoredDiagnostics(storage);
  if (!manifestBeforeMutation || manifestBeforeMutation.generation !== cleanupGeneration) return;
  while (totalBytes > MAX_STORAGE_BYTES) {
    const removed = current.shift();
    if (!removed) break;
    const raw = storage.getItem(removed.key);
    if (raw) totalBytes -= utf8Bytes(raw);
    retainedKeys.delete(removed.key);
    storage.removeItem(removed.key);
  }
  const manifest = readStoredDiagnostics(storage);
  if (!manifest || manifest.generation !== cleanupGeneration) return;
  for (const key of allKeys) {
    const raw = storage.getItem(key);
    if (!raw) continue;
    const event = parseStoredDiagnosticEvent(raw);
    if (!event || event.generation !== cleanupGeneration || !retainedKeys.has(key)) storage.removeItem(key);
  }
}

function persistEvent(entry: ClientDiagnosticEntry): void {
  entries = boundEntries(entries);
  const storage = safeStorage();
  if (!storage) {
    persistence = "memory";
    memoryEvents = aggregateEntries([...memoryEvents, entry]);
    return;
  }
  let failureBuffered = false;
  try {
    const stored = readStoredDiagnostics(storage);
    if (!stored) {
      if (storage.getItem(STORAGE_KEY) !== null) throw new Error("Invalid diagnostics manifest");
      storageGeneration = INITIAL_GENERATION;
      storage.setItem(STORAGE_KEY, serializedManifest(storageGeneration));
    }
    if (stored && stored.generation !== storageGeneration) {
      storageGeneration = stored.generation;
      memoryEvents = [];
    }
    const pending = aggregateEntries([...memoryEvents, entry]);
    memoryEvents = [];
    for (let index = 0; index < pending.length; index += 1) {
      try {
        storage.setItem(nextEventKey(), serializedEvent(pending[index]));
      } catch (error: unknown) {
        memoryEvents = aggregateEntries(pending.slice(index));
        failureBuffered = true;
        throw error;
      }
    }
    try {
      cleanupStoredEvents(storage);
    } catch {
      // The occurrence itself is durable. Cleanup is retried by later writes
      // and must not duplicate the same event in memory.
    }
    storageWriteFailed = false;
    persistence = "localStorage";
  } catch {
    if (!failureBuffered) memoryEvents = aggregateEntries([...memoryEvents, entry]);
    storageWriteFailed = true;
    persistence = "memory";
  }
}

function notify(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Diagnostics must never become a new application failure.
    }
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

function shouldIgnore(input: ClientDiagnosticInput): boolean {
  if (isAbortError(input.error)) return true;
  return input.source === "optional-resource" &&
    input.code === "OPTIONAL_RESOURCE_NOT_FOUND" &&
    /(?:^|\s)404(?:\s|$)|not found/i.test(normalizeError(input.error, input.message).message);
}

function safeDetail(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const sanitized = sanitizeText(value, maxLength);
  return sanitized || undefined;
}

export function recordClientDiagnostic(input: ClientDiagnosticInput): boolean {
  if (recording) return false;
  recording = true;
  try {
    if (shouldIgnore(input) || !CODE_PATTERN.test(input.code)) return false;
    ensureInitialized();
    refreshFromStorage();
    const normalized = normalizeError(input.error, input.message);
    const now = new Date().toISOString();
    const operation = safeDetail(input.operation, 32);
    const currentVersion = safeDetail(input.currentVersion, 64);
    const targetVersion = safeDetail(input.targetVersion, 64);
    const occurrence: ClientDiagnosticEntry = {
      schemaVersion: SCHEMA_VERSION,
      occurredAt: now,
      lastOccurredAt: now,
      level: input.level ?? "error",
      source: input.source,
      code: input.code,
      message: normalized.message || "알 수 없는 오류",
      ...(normalized.stack ? { stack: normalized.stack } : {}),
      ...(operation ? { operation } : {}),
      ...(currentVersion ? { currentVersion } : {}),
      ...(targetVersion ? { targetVersion } : {}),
      appVersion: packageManifest.version,
      count: 1,
    };
    entries = aggregateEntries([...entries, occurrence]);
    persistEvent(occurrence);
    refreshFromStorage();
    notify();
    return true;
  } catch {
    persistence = "memory";
    return false;
  } finally {
    recording = false;
  }
}

export function getClientDiagnosticSnapshot(): ClientDiagnosticSnapshot {
  try {
    ensureInitialized();
    refreshFromStorage();
    return {
      entries: entries.map((entry) => ({ ...entry })),
      persistence,
    };
  } catch {
    return { entries: [], persistence: "memory" };
  }
}

export function clearClientDiagnostics(): boolean {
  ensureInitialized();
  const storage = safeStorage();
  if (!storage) {
    persistence = "memory";
    notify();
    return false;
  } else {
    try {
      const clearedGeneration = nextStorageGeneration();
      storage.setItem(STORAGE_KEY, serializedManifest(clearedGeneration));
      entries = [];
      memoryEvents = [];
      storageGeneration = clearedGeneration;
      storageWriteFailed = false;
      persistence = "localStorage";
      // Old generations are ignored by the new manifest. Their physical
      // cleanup is best-effort and must not turn a completed logical clear
      // into a reported failure.
      let obsoleteKeys: string[] = [];
      try {
        obsoleteKeys = storedEventKeys(storage);
      } catch {
        // Logical clear already committed; later writes retry scavenging.
      }
      for (const key of obsoleteKeys) {
        try {
          const raw = storage.getItem(key);
          let event: StoredDiagnosticEvent | null = null;
          try {
            event = raw ? parseStoredDiagnosticEvent(raw) : null;
          } catch {
            // Malformed diagnostic-owned storage is obsolete by definition.
          }
          if (!event || event.generation !== clearedGeneration) storage.removeItem(key);
        } catch {
          // A later successful write retries obsolete-generation cleanup.
        }
      }
    } catch {
      storageWriteFailed = true;
      persistence = "memory";
      notify();
      return false;
    }
  }
  notify();
  return true;
}

export function subscribeClientDiagnostics(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function exportClientDiagnostics(): string {
  const snapshot = getClientDiagnosticSnapshot();
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: packageManifest.version,
    persistence: snapshot.persistence,
    entries: snapshot.entries,
  }, null, 2);
}

export function installGlobalDiagnosticHandlers(target: Window = window): () => void {
  const existing = installedHandlers.get(target);
  if (existing) {
    existing.references += 1;
    return createHandlerCleanup(target, existing);
  }

  const onError: EventListener = (event) => {
    // Element/resource failures are plain Event objects. Only JavaScript
    // ErrorEvent-shaped values are useful here, including cross-realm events.
    if (event.target instanceof Node || !("message" in event)) return;
    const errorEvent = event as ErrorEvent;
    recordClientDiagnostic({
      source: "global",
      code: "UNCAUGHT_ERROR",
      error: errorEvent.error ?? errorEvent.message,
    });
  };
  const onUnhandledRejection: EventListener = (event) => {
    recordClientDiagnostic({
      source: "global",
      code: "UNHANDLED_REJECTION",
      error: (event as PromiseRejectionEvent).reason,
    });
  };
  const handlers = { references: 1, onError, onUnhandledRejection };
  installedHandlers.set(target, handlers);
  target.addEventListener("error", onError, true);
  target.addEventListener("unhandledrejection", onUnhandledRejection);
  return createHandlerCleanup(target, handlers);
}

function createHandlerCleanup(target: Window, handlers: InstalledHandlers): () => void {
  let cleanedUp = false;
  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    handlers.references -= 1;
    if (handlers.references > 0) return;
    target.removeEventListener("error", handlers.onError, true);
    target.removeEventListener("unhandledrejection", handlers.onUnhandledRejection);
    installedHandlers.delete(target);
  };
}
