import type { IncomingMessage, ServerResponse } from 'node:http';

export interface WeaponPreviewService {
  render(input: unknown): Promise<{ imageUrl: string }>;
}

export function createWeaponPreviewService(options?: {
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  totalTimeoutMs?: number;
  minIntervalMs?: number;
  imageCacheTtlMs?: number;
  imageCacheBytes?: number;
}): WeaponPreviewService;

export function createWeaponPreviewMiddleware(service?: WeaponPreviewService):
  (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
