import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { setTimeout, clearTimeout } from 'node:timers';
import { URL } from 'node:url';

const PROVIDER = 'https://image-gen.tarkov-changes.com';
const HEX_ID = /^[0-9a-f]{24}$/;
const MAX_BODY = 64 * 1024;
const MAX_JSON = 1024 * 1024;
const MAX_IMAGE = 5 * 1024 * 1024;
const MESSAGES = {
  INVALID_BUILD: '미리보기에 사용할 총기 구성이 올바르지 않습니다.',
  SLOT_UNAVAILABLE: '외형 서비스에서 이 부품의 장착 위치를 확인하지 못했습니다.',
  PREVIEW_BUSY: '이전 외형을 생성 중입니다. 잠시 후 다시 시도해 주세요.',
  RATE_LIMITED: '외형 요청이 잠시 제한되었습니다. 안내된 시간 후 다시 시도해 주세요.',
  PROVIDER_RESPONSE: '외형 서비스가 올바른 이미지 또는 부품 정보를 반환하지 않았습니다.',
  PROVIDER_TIMEOUT: '외형 생성 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
  PROVIDER_UNAVAILABLE: '외형 서비스에 연결하지 못했습니다.',
  FORBIDDEN: '이 프로그램의 화면에서만 외형을 요청할 수 있습니다.',
  METHOD_NOT_ALLOWED: '지원하지 않는 요청 방식입니다.',
  UNSUPPORTED_MEDIA: 'JSON 형식으로 요청해야 합니다.',
  BODY_TOO_LARGE: '미리보기 요청이 너무 큽니다.',
};

class PreviewError extends Error {
  constructor(code, status = 502, retryAfterSeconds) {
    super(MESSAGES[code]);
    this.code = code;
    this.status = status;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && HEX_ID.test(value);
const hash = value => createHash('sha256').update(value).digest('hex');

function normalizeInput(value) {
  if (!record(value) || !Number.isInteger(value.angle) || value.angle < -180 || value.angle > 180 || value.angle % 15 !== 0) {
    throw new PreviewError('INVALID_BUILD', 400);
  }
  const seen = new Set();
  function visit(node, depth) {
    if (!record(node) || depth > 12 || seen.size >= 96 || !id(node.itemId) ||
      typeof node.instanceId !== 'string' || !/^[A-Za-z0-9:_/-]{1,2048}$/.test(node.instanceId) ||
      seen.has(node.instanceId) || !Array.isArray(node.children) || node.children.length > 95 ||
      (depth > 0 && !id(node.slotId)) || (depth === 0 && node.slotId !== undefined && !id(node.slotId))) {
      throw new PreviewError('INVALID_BUILD', 400);
    }
    seen.add(node.instanceId);
    const children = node.children.map(child => visit(child, depth + 1)).sort((a, b) => a.slotId.localeCompare(b.slotId));
    if (new Set(children.map(child => child.slotId)).size !== children.length) throw new PreviewError('INVALID_BUILD', 400);
    return { itemId: node.itemId, ...(depth ? { slotId: node.slotId } : {}), children };
  }
  return { root: visit(value.root, 0), angle: value.angle };
}

function validImage(bytes, contentType) {
  const mime = contentType?.split(';', 1)[0].trim().toLowerCase();
  if (mime === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (width > 0 && height > 0 && width <= 8192 && height <= 8192 && width * height <= 16777216) return mime;
  }
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return mime;
  if (mime === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return mime;
  throw new PreviewError('PROVIDER_RESPONSE');
}

/** Fixed-provider, opt-in image rendering. Does not read game files, send credentials, or retry blocked requests. */
export function createWeaponPreviewService({
  fetchImpl = globalThis.fetch, now = Date.now, requestTimeoutMs = 10000, totalTimeoutMs = 28000,
  minIntervalMs = 2000, imageCacheTtlMs = 3600000, imageCacheBytes = 12 * 1024 * 1024,
} = {}) {
  const slotCache = new Map();
  const imageCache = new Map();
  let cacheBytes = 0, slotCacheBytes = 0, active = null, cooldownUntil = 0, nextRequestAt = 0;

  async function remote(path, init, maximumBytes, jobSignal) {
    const controller = new globalThis.AbortController();
    const signal = globalThis.AbortSignal.any([jobSignal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    let onAbort, reader;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new PreviewError('PROVIDER_TIMEOUT', 504));
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      return await Promise.race([aborted, (async () => {
        const response = await fetchImpl(PROVIDER + path, { ...init, redirect: 'error', signal });
        if (response.status === 429) {
          const retry = response.headers.get('retry-after');
          const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : Math.ceil((Date.parse(retry ?? '') - now()) / 1000);
          const delay = Number.isFinite(seconds) && seconds > 0 ? seconds : 60;
          cooldownUntil = Math.max(cooldownUntil, now() + delay * 1000);
          void response.body?.cancel().catch(() => {});
          throw new PreviewError('RATE_LIMITED', 429, Math.ceil((cooldownUntil - now()) / 1000));
        }
        if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > maximumBytes || !response.body) {
          void response.body?.cancel().catch(() => {});
          throw new PreviewError('PROVIDER_RESPONSE');
        }
        reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maximumBytes) throw new PreviewError('PROVIDER_RESPONSE');
          chunks.push(Buffer.from(value));
        }
        return { bytes: Buffer.concat(chunks, length), contentType: response.headers.get('content-type') };
      })()]);
    } catch (error) {
      if (error instanceof PreviewError) throw error;
      throw new PreviewError(signal.aborted ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE', signal.aborted ? 504 : 502);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      controller.abort();
      void reader?.cancel().catch(() => {});
    }
  }

  async function remoteJson(path, body, signal) {
    const { bytes, contentType } = await remote(path, body ? {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    } : { method: 'GET' }, MAX_JSON, signal);
    if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new PreviewError('PROVIDER_RESPONSE');
    try { return JSON.parse(bytes.toString('utf8')); } catch { throw new PreviewError('PROVIDER_RESPONSE'); }
  }

  async function getSlots(parentId, signal) {
    const cached = slotCache.get(parentId);
    if (cached && cached.expires > now()) return cached.slots;
    const data = await remoteJson(`/api/item-slots/${parentId}`, null, signal);
    if (!record(data) || !Array.isArray(data.slots) || data.slots.length > 96) throw new PreviewError('PROVIDER_RESPONSE');
    const slots = new Map();
    for (const slot of data.slots) {
      if (!record(slot) || slot.parentTplId !== parentId || !id(slot.slotId) || slots.has(slot.slotId) ||
        typeof slot.slotName !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,95}$/.test(slot.slotName) ||
        !Array.isArray(slot.resolvedItemTplIds) || slot.resolvedItemTplIds.length > 8192 || !slot.resolvedItemTplIds.every(id)) {
        throw new PreviewError('PROVIDER_RESPONSE');
      }
      slots.set(slot.slotId, { name: slot.slotName, allowed: new Set(slot.resolvedItemTplIds) });
    }
    const bytes = Buffer.byteLength(JSON.stringify(data.slots));
    if (cached) { slotCacheBytes -= cached.bytes; slotCache.delete(parentId); }
    while (slotCache.size && (slotCache.size >= 256 || slotCacheBytes + bytes > 4 * MAX_JSON)) {
      const oldest = slotCache.keys().next().value;
      slotCacheBytes -= slotCache.get(oldest).bytes; slotCache.delete(oldest);
    }
    slotCache.set(parentId, { slots, bytes, expires: now() + 86400000 }); slotCacheBytes += bytes;
    return slots;
  }

  async function generate(input, signal) {
    const items = [];
    async function visit(node, instanceId, parentId, slotId) {
      items.push({ _id: instanceId, _tpl: node.itemId, ...(parentId ? { parentId } : {}), slotId });
      if (!node.children.length) return;
      const slots = await getSlots(node.itemId, signal);
      for (const child of node.children) {
        const slot = slots.get(child.slotId);
        if (!slot || !slot.allowed.has(child.itemId)) throw new PreviewError('SLOT_UNAVAILABLE', 422);
        await visit(child, hash(`${instanceId}/${child.slotId}`).slice(0, 24), instanceId, slot.name);
      }
    }
    const rootId = hash(`root:${input.root.itemId}`).slice(0, 24);
    await visit(input.root, rootId, null, 'FirstPrimaryWeapon');
    const data = { id: rootId, items, ...(input.angle ? { rotationX: 0, rotationY: input.angle } : {}) };
    const generated = await remoteJson(`/api/generate-build${input.angle ? '-rotated' : ''}`, { data }, signal);
    if (!record(generated) || generated.ok !== true || typeof generated.imageUrl !== 'string') throw new PreviewError('PROVIDER_RESPONSE');
    const imagePath = generated.imageUrl.startsWith(PROVIDER + '/') ? generated.imageUrl.slice(PROVIDER.length) : generated.imageUrl;
    if (!/^\/api\/images\/[A-Za-z0-9_-]{1,160}$/.test(imagePath)) throw new PreviewError('PROVIDER_RESPONSE');
    const image = await remote(imagePath, { method: 'GET' }, MAX_IMAGE, signal);
    const mime = validImage(image.bytes, image.contentType);
    return { imageUrl: `data:${mime};base64,${image.bytes.toString('base64')}`, bytes: image.bytes.length };
  }

  return {
    async render(value) {
      const input = normalizeInput(value);
      const key = hash(JSON.stringify(input));
      const cached = imageCache.get(key);
      if (cached && cached.expires > now()) return cached.result;
      if (cached) { cacheBytes -= cached.bytes; imageCache.delete(key); }
      if (active?.key === key) return active.promise;
      if (active) throw new PreviewError('PREVIEW_BUSY', 503, 2);
      if (cooldownUntil > now()) throw new PreviewError('RATE_LIMITED', 429, Math.ceil((cooldownUntil - now()) / 1000));
      if (nextRequestAt > now()) throw new PreviewError('PREVIEW_BUSY', 503, Math.ceil((nextRequestAt - now()) / 1000));
      nextRequestAt = now() + minIntervalMs;
      const controller = new globalThis.AbortController();
      const timer = setTimeout(() => controller.abort(), totalTimeoutMs);
      const promise = generate(input, controller.signal).then(({ imageUrl, bytes }) => {
        const result = { imageUrl };
        if (bytes <= imageCacheBytes) {
          while (imageCache.size && (imageCache.size >= 24 || cacheBytes + bytes > imageCacheBytes)) {
            const first = imageCache.keys().next().value;
            cacheBytes -= imageCache.get(first).bytes;
            imageCache.delete(first);
          }
          imageCache.set(key, { result, bytes, expires: now() + imageCacheTtlMs }); cacheBytes += bytes;
        }
        return result;
      }).finally(() => { clearTimeout(timer); active = null; });
      active = { key, promise };
      return promise;
    },
  };
}

function checkRequest(request) {
  if (request.method !== 'POST') throw new PreviewError('METHOD_NOT_ALLOWED', 405);
  const host = request.headers.host;
  let address;
  try { address = new URL(`http://${host}`); } catch { throw new PreviewError('FORBIDDEN', 403); }
  if (typeof host !== 'string' || address.host !== host || !['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname) ||
    (request.socket.localPort && Number(address.port || 80) !== request.socket.localPort)) throw new PreviewError('FORBIDDEN', 403);
  const origin = request.headers.origin;
  const protocol = request.socket.encrypted ? 'https:' : 'http:';
  if ((origin !== undefined && origin !== `${protocol}//${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new PreviewError('FORBIDDEN', 403);
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') throw new PreviewError('UNSUPPORTED_MEDIA', 415);
  if (Number(request.headers['content-length']) > MAX_BODY) throw new PreviewError('BODY_TOO_LARGE', 413);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let length = 0, done = false;
    const chunks = [];
    function finish(error, result) {
      if (done) return;
      done = true; clearTimeout(timer);
      request.removeListener('data', onData); request.removeListener('end', onEnd);
      request.removeListener('error', onError); request.removeListener('aborted', onError);
      if (error) { request.resume(); reject(error); } else resolve(result);
    }
    function onData(chunk) {
      length += chunk.length;
      if (length > MAX_BODY) finish(new PreviewError('BODY_TOO_LARGE', 413));
      else chunks.push(chunk);
    }
    function onEnd() {
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { finish(new PreviewError('INVALID_BUILD', 400)); }
    }
    function onError() { finish(new PreviewError('INVALID_BUILD', 400)); }
    const timer = setTimeout(onError, 5000);
    request.on('data', onData); request.on('end', onEnd);
    request.on('error', onError); request.on('aborted', onError);
  });
}

export function createWeaponPreviewMiddleware(service = createWeaponPreviewService()) {
  return (request, response, next) => {
    if (request.url?.split('?', 1)[0] !== '/api/modding/preview') return next();
    (async () => {
      let status = 200, body;
      try { checkRequest(request); body = await service.render(await readBody(request)); }
      catch (error) {
        const safe = error instanceof PreviewError ? error : new PreviewError('PROVIDER_UNAVAILABLE');
        status = safe.status;
        body = { error: { code: safe.code, message: safe.message, ...(safe.retryAfterSeconds ? { retryAfterSeconds: safe.retryAfterSeconds } : {}) } };
        if (safe.retryAfterSeconds) response.setHeader('Retry-After', String(safe.retryAfterSeconds));
        request.resume();
      }
      if (response.destroyed || response.writableEnded) return;
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.end(JSON.stringify(body));
    })();
  };
}
