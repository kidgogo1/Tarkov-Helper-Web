import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { createWeaponPreviewService, createWeaponPreviewMiddleware } from '../../server/weapon-preview.mjs';

const GUN = '5447a9cd4bdc2dbd208b4567';
const GRIP = '55802f5d4bdc2dac148b458f';
const SLOT = '55d354084bdc2d8c2f8b4568';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const input = (angle = 0) => ({ root: {
  instanceId: `root:${GUN}`, itemId: GUN, children: [
    { instanceId: `root:${GUN}/${SLOT}`, itemId: GRIP, slotId: SLOT, children: [] },
  ],
}, angle });
const slots = () => ({ slots: [{ parentTplId: GUN, slotId: SLOT, slotName: 'mod_pistol_grip', resolvedItemTplIds: [GRIP] }] });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
function fixture(overrides = {}, options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, ...init });
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path](init);
    if (path.startsWith('/api/item-slots/')) return json(slots());
    if (path.startsWith('/api/generate-build')) return json({ ok: true, imageUrl: '/api/images/build_test' });
    if (path === '/api/images/build_test') return new Response(PNG, { headers: { 'content-type': 'image/png' } });
    throw new Error(`Unexpected route ${path}`);
  };
  return { calls, service: createWeaponPreviewService({ fetchImpl, minIntervalMs: 0, ...options }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, (error) => error.code === code);

test('maps exact parent slot IDs, generates current assembly, and returns validated inline image', async () => {
  const { service, calls } = fixture();
  assert.deepEqual(await service.render(input()), { imageUrl: `data:image/png;base64,${PNG.toString('base64')}` });
  const body = JSON.parse(calls[1].body).data;
  assert.match(body.id, /^[0-9a-f]{24}$/);
  assert.equal(body.items[0]._tpl, GUN);
  assert.equal(body.items[1]._tpl, GRIP);
  assert.equal(body.items[1].slotId, 'mod_pistol_grip');
  assert.equal(body.items[1].parentId, body.items[0]._id);
  assert.notEqual(body.items[1]._id, body.items[0]._id);
  assert.equal(body.rotationX, undefined);
  assert.ok(calls.every(call => call.redirect === 'error' && new URL(call.url).origin === 'https://image-gen.tarkov-changes.com'));
  assert.ok(calls.every(call => !call.headers?.Authorization && !call.headers?.Cookie));
});

test('uses the rotated endpoint only for supported nonzero viewing angles', async () => {
  const { service, calls } = fixture();
  for (let angle = -180; angle <= 180; angle += 15) {
    await service.render(input(angle));
    const generated = calls.at(-2);
    const data = JSON.parse(generated.body).data;
    assert.ok(generated.url.endsWith(angle === 0 ? '/api/generate-build' : '/api/generate-build-rotated'));
    assert.equal(data.rotationY, angle === 0 ? undefined : angle);
    assert.equal(data.rotationX, angle === 0 ? undefined : 0);
  }
});

test('rejects invalid viewing angles without clamping, coercion, or network traffic', async () => {
  const { service, calls } = fixture();
  for (const angle of [-195, 195, -181, 181, -1, 1, 5, 14, 16, 30.5, NaN, Infinity, -Infinity, '90', null, undefined, true, [], {}]) {
    await rejectsCode(service.render({ ...input(), angle }), 'INVALID_BUILD');
  }
  assert.equal(calls.length, 0);
});

test('rejects malformed identifiers, duplicate instances, duplicate slots, depth and node excess before network', async () => {
  const { service, calls } = fixture();
  const bad = [];
  bad.push({ ...input(), root: { ...input().root, itemId: '../../etc/passwd' } });
  bad.push({ ...input(), root: { ...input().root, instanceId: '<script>' } });
  const duplicate = input(); duplicate.root.children[0].instanceId = duplicate.root.instanceId; bad.push(duplicate);
  const repeatedSlot = input(); repeatedSlot.root.children.push({ ...repeatedSlot.root.children[0], instanceId: 'other' }); bad.push(repeatedSlot);
  const missing = input(); delete missing.root.children[0].slotId; bad.push(missing);
  const excess = input(); excess.root.children = Array.from({ length: 96 }, (_, i) => ({ instanceId: `part:${i}`, itemId: GRIP, slotId: i.toString(16).padStart(24, '0'), children: [] })); bad.push(excess);
  const deep = input(); let node = deep.root; for (let i = 0; i < 13; i++) { node.children = [{ instanceId: `depth:${i}`, itemId: GRIP, slotId: SLOT, children: [] }]; node = node.children[0]; } bad.push(deep);
  for (const value of bad) await rejectsCode(service.render(value), 'INVALID_BUILD');
  assert.equal(calls.length, 0);
});

test('uses semantic tree and viewing angle cache, not caller instance names', async () => {
  const { service, calls } = fixture();
  await service.render(input());
  const renamed = input(); renamed.root.instanceId = 'different'; renamed.root.children[0].instanceId = 'new-child';
  await service.render(renamed);
  assert.equal(calls.length, 3);
  await service.render(input(30));
  assert.equal(calls.length, 5, 'slot lookup is cached; another angle renders a new image');
  await service.render(input(90));
  await service.render(input(180));
  assert.equal(calls.length, 9);
  await service.render(input(90));
  await service.render(input(180));
  assert.equal(calls.length, 9, 'extended viewing angles use separate cached images');
});

test('coalesces identical requests and rejects other requests while one render is running', async () => {
  let release;
  const { service, calls } = fixture({ [`/api/item-slots/${GUN}`]: () => new Promise(resolve => { release = () => resolve(json(slots())); }) });
  const first = service.render(input());
  const same = service.render(input());
  await rejectsCode(service.render(input(30)), 'PREVIEW_BUSY');
  release();
  assert.deepEqual(await first, await same);
  assert.equal(calls.length, 3);
});

test('unknown or malformed provider slot mapping never guesses an attachment location', async () => {
  for (const response of [
    { slots: [] },
    { slots: [{ ...slots().slots[0], parentTplId: GRIP }] },
    { slots: [{ ...slots().slots[0], slotName: '../../file' }] },
    { slots: [{ ...slots().slots[0], resolvedItemTplIds: [] }] },
  ]) {
    const { service, calls } = fixture({ [`/api/item-slots/${GUN}`]: () => json(response) });
    await assert.rejects(service.render(input()), error => ['SLOT_UNAVAILABLE', 'PROVIDER_RESPONSE'].includes(error.code));
    assert.equal(calls.length, 1);
  }
});

test('provider 429 establishes shared cooldown, honors Retry-After and never retries automatically', async () => {
  let time = 1000;
  const { service, calls } = fixture({ [`/api/item-slots/${GUN}`]: () => json({}, 429, { 'retry-after': '90' }) }, { now: () => time });
  await assert.rejects(service.render(input()), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 90);
  time += 15000;
  await assert.rejects(service.render(input(30)), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 75);
  assert.equal(calls.length, 1);
});

test('declared or streamed oversized provider responses are stopped', async () => {
  for (const response of [
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '99999999' } }),
    new Response(' '.repeat(1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
  ]) {
    const { service } = fixture({ [`/api/item-slots/${GUN}`]: () => response });
    await rejectsCode(service.render(input()), 'PROVIDER_RESPONSE');
  }
});

test('rejects unexpected image hosts, traversal, SVG and untrusted bytes', async () => {
  for (const imageUrl of ['https://example.com/a.png', '//localhost/a', '/api/images/../admin', '/api/images/a?other=true']) {
    const { service, calls } = fixture({ '/api/generate-build': () => json({ ok: true, imageUrl }) });
    await rejectsCode(service.render(input()), 'PROVIDER_RESPONSE');
    assert.equal(calls.length, 2);
  }
  for (const response of [new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } }), new Response('<html/>', { headers: { 'content-type': 'image/png' } })]) {
    const { service } = fixture({ '/api/images/build_test': () => response });
    await rejectsCode(service.render(input()), 'PROVIDER_RESPONSE');
  }
});

test('slow provider requests time out and the lock is released', async () => {
  const { service } = fixture({ [`/api/item-slots/${GUN}`]: init => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })) }, { requestTimeoutMs: 15 });
  await rejectsCode(service.render(input()), 'PROVIDER_TIMEOUT');
  await rejectsCode(service.render(input(30)), 'PROVIDER_TIMEOUT');
});

test('image cache has TTL and byte bounds', async () => {
  let time = 0;
  const { service, calls } = fixture({}, { now: () => time, imageCacheTtlMs: 100, imageCacheBytes: PNG.length * 2 });
  await service.render(input());
  await service.render(input());
  assert.equal(calls.length, 3);
  time = 101;
  await service.render(input());
  assert.equal(calls.length, 5);
  await service.render(input(30));
  await service.render(input(-30));
  const after = calls.length;
  await service.render(input());
  assert.equal(calls.length, after + 2, 'oldest image was evicted when the byte budget was exceeded');
});

test('streams cannot keep a timed-out operation locked and 503 is not automatically retried', async () => {
  let calls = 0;
  const service = createWeaponPreviewService({ minIntervalMs: 0, requestTimeoutMs: 15, fetchImpl: async () => {
    calls++;
    return calls === 1 ? new Response(new ReadableStream({ pull: () => new Promise(() => {}) }), { headers: { 'content-type': 'application/json' } }) : json({}, 503);
  } });
  await rejectsCode(service.render(input()), 'PROVIDER_TIMEOUT');
  await rejectsCode(service.render(input(30)), 'PROVIDER_RESPONSE');
  assert.equal(calls, 2);
});

test('accepts bounded domain path instance IDs and preserves semantically distinct parent structures in the cache', async () => {
  const { service, calls } = fixture();
  const first = input(); first.root.children[0].instanceId = `root:${GUN}/${'a'.repeat(600)}`;
  await service.render(first);
  const bare = input(); bare.root.children = [];
  await service.render(bare);
  assert.equal(calls.length, 5, 'removing a part produces a different render');
  const data = JSON.parse(calls[3].body).data;
  assert.equal(data.items.length, 1);
});

test('supports exact non-mod slot identifiers and rejects duplicate mapping definitions', async () => {
  const { service, calls } = fixture({ [`/api/item-slots/${GUN}`]: () => json({ slots: [{ ...slots().slots[0], slotName: 'patron_in_weapon' }] }) });
  await service.render(input());
  assert.equal(JSON.parse(calls[1].body).data.items[1].slotId, 'patron_in_weapon');
  const duplicate = fixture({ [`/api/item-slots/${GUN}`]: () => json({ slots: [...slots().slots, ...slots().slots] }) });
  await rejectsCode(duplicate.service.render(input()), 'PROVIDER_RESPONSE');
});

test('rejects redirects, misleading MIME and images exceeding the size cap', async () => {
  for (const response of [
    new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }),
    new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
  ]) {
    const { service } = fixture({ '/api/generate-build': () => response });
    await rejectsCode(service.render(input()), 'PROVIDER_RESPONSE');
  }
  const { service } = fixture({ '/api/images/build_test': () => new Response(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(5 * 1024 * 1024 + 1) } }) });
  await rejectsCode(service.render(input()), 'PROVIDER_RESPONSE');
});

test('cached previews remain available during throttling and long Retry-After is not shortened', async () => {
  let rateLimited = false;
  const { service, calls } = fixture({ '/api/generate-build-rotated': () => { rateLimited = true; return json({}, 429, { 'retry-after': '864000' }); } });
  const existing = await service.render(input());
  await assert.rejects(service.render(input(30)), error => error.code === 'RATE_LIMITED' && error.retryAfterSeconds === 864000);
  assert.ok(rateLimited);
  const count = calls.length;
  assert.deepEqual(await service.render(input()), existing);
  assert.equal(calls.length, count);
});

test('HTTP boundary rejects cross-origin, wrong host, wrong method and bad content type before rendering', async t => {
  let renders = 0;
  const handler = createWeaponPreviewMiddleware({ render: async () => { renders++; return { imageUrl: 'data:image/png;base64,test' }; } });
  const server = createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = `${origin}/api/modding/preview`;
  const request = (headers = {}, method = 'POST', body = '{}') => new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { 'content-type': 'application/json', origin, ...headers } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: new Headers(res.headers) }));
    });
    req.on('error', reject); req.end(method === 'GET' ? undefined : body);
  });
  assert.equal((await request({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await request({ host: 'evil.example' })).status, 403);
  assert.equal((await request({ origin: 'null' })).status, 403);
  assert.equal((await request({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request({}, 'GET')).status, 405);
  assert.equal((await request({ 'content-type': 'text/plain' })).status, 415);
  assert.equal((await request({}, 'POST', '{')).status, 400);
  assert.equal((await request({}, 'POST', ' '.repeat(65537))).status, 413);
  assert.equal(renders, 0);
  const good = await request({}, 'POST', JSON.stringify(input()));
  assert.equal(good.status, 200);
  assert.equal(good.headers.get('cache-control'), 'no-store');
  assert.equal(good.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(renders, 1);
});
