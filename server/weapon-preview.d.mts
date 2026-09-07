import type { IncomingMessage, ServerResponse } from 'node:http';

export interface WeaponPreviewService {
  /** Validates { root: BuildNode, angle: number }; angle is an integer from -180 to 180 in 15-degree steps. */
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
