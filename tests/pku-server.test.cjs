'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../pku-server.cjs');
const PAIR = 'a'.repeat(64);
const ITEM = { sourceId: 'b'.repeat(64), title: '示例作业', course: '示例课程', due: '2026-11-18T23:59', sourceUrl: 'https://course.pku.edu.cn/webapps/calendar/viewPersonal' };
function memoryVault() {
  let stored = null;
  return { has: async () => !!stored, load: async () => stored && { ...stored }, save: async input => { stored = { ...input }; }, clear: async () => { stored = null; } };
}
function mockClient(extra = {}) {
  return { prepare: async () => ({}), login: async () => ({ ok: true }), readDeadlines: async () => ({ items: [ITEM], warnings: [] }), sendSms: async () => {}, close() {}, ...extra };
}
async function setup(t, options = {}) {
  const vault = options.vault || memoryVault();
  const result = createServer({ pairingCode: PAIR, vault, createClient: () => mockClient(), ...options });
  const server = result.server; server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, vault };
}
function request(server, route = '/api/pku/status', options = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: options.method || 'GET', headers: { Authorization: 'Bearer ' + PAIR, Host: '127.0.0.1:' + port, Origin: 'null', ...options.headers } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: text ? JSON.parse(text) : null }));
    }); req.on('error', reject); req.end(options.body);
  });
}
const post = (server, data = {}, route = '/api/pku/sync', headers = {}) => request(server, route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });

test('PKU connector requires pairing and exact local Host/Origin on every private endpoint', async t => {
  const { server } = await setup(t);
  for (const route of ['/api/pku/status', '/api/pku/sync', '/api/pku/sms', '/api/pku/credentials']) {
    assert.equal((await request(server, route, { headers: { Authorization: '' } })).status, 401);
    assert.equal((await request(server, route, { headers: { Authorization: 'Bearer ' + 'c'.repeat(64) } })).status, 401);
    assert.equal((await request(server, route, { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(server, route, { headers: { Host: 'evil.example' } })).status, 403);
  }
  const result = await request(server);
  assert.deepEqual(result.json, { remembered: false, connected: false });
  assert.equal(result.headers['access-control-allow-origin'], 'null');
  assert.equal(result.headers['access-control-allow-credentials'], undefined);
  assert.doesNotMatch(result.text, new RegExp(PAIR));
  assert.equal((await request(server, '/pku-vault.cjs')).status, 404);
  assert.equal((await request(server, '/api/pku/status?token=' + PAIR)).status, 404);
});

test('preflight enables only authenticated JSON loopback requests and private-network permission', async t => {
  const { server } = await setup(t);
  const headers = { Authorization: '', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Private-Network': 'true' };
  const result = await request(server, '/api/pku/sync', { method: 'OPTIONS', headers });
  assert.equal(result.status, 204);
  assert.equal(result.headers['access-control-allow-private-network'], 'true');
  assert.equal((await request(server, '/api/pku/sync', { method: 'OPTIONS', headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(server, '/api/pku/sync', { method: 'OPTIONS', headers: { ...headers, 'Access-Control-Request-Headers': 'content-type' } })).status, 403);
});

test('sync stores only explicit remembered credentials, projects results and supports saved-login reuse', async t => {
  let logins = 0;
  const { server, vault } = await setup(t, { createClient: () => mockClient({ login: async () => { logins++; }, readDeadlines: async () => ({ items: [{ ...ITEM, cookie: 'secret-cookie' }], warnings: [] }) }) });
  const result = await post(server, { username: 'sample-user', password: 'sample-private-password', remember: true });
  assert.equal(result.status, 200); assert.deepEqual(result.json.items, [ITEM]);
  assert.doesNotMatch(result.text, /sample-user|sample-private-password|secret-cookie/);
  assert.deepEqual(await vault.load(), { username: 'sample-user', password: 'sample-private-password' });
  assert.equal((await post(server)).status, 200); assert.equal(logins, 1);
  assert.deepEqual((await request(server)).json, { remembered: true, connected: true });
  assert.equal((await request(server, '/api/pku/credentials', { method: 'DELETE' })).status, 200);
  assert.equal(await vault.has(), false);
  assert.equal((await post(server)).status, 400);
});

test('invalid JSON, oversized requests and unsupported credential fields never reach PKU', async t => {
  let calls = 0;
  const { server } = await setup(t, { createClient: () => { calls++; return mockClient(); } });
  for (const data of [{ username: 'user' }, { username: 'user', password: 'p', url: 'https://evil.example' }, { username: 'user', password: 'p', remember: 'yes' }, { username: 'user', password: 'p', verification: { otp: '1\n2' } }, { username: 'user', password: 'p', verification: { cookie: 'secret' } }]) assert.equal((await post(server, data)).status, 400);
  assert.equal((await post(server, {}, '/api/pku/sync', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await request(server, '/api/pku/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' })).status, 400);
  assert.equal((await post(server, { username: 'u', password: 'x'.repeat(17000) })).status, 413);
  assert.equal(calls, 0);
});

test('two-factor challenge keeps pending session in memory and sends SMS only on explicit request', async t => {
  let sms = 0, loginCalls = 0;
  const { server, vault } = await setup(t, { createClient: () => mockClient({
    login: async ({ verification }) => {
      loginCalls++;
      if (!verification.sms) throw Object.assign(new Error('do-not-echo-user-password'), { code: 'CHALLENGE', challenge: { captchaRequired: true, captchaImage: 'data:image/png;base64,YQ==', mode: 'sms', secret: 'private' } });
    }, sendSms: async () => { sms++; }
  }) });
  const first = await post(server, { username: 'sample-user', password: 'sample-password', remember: true });
  assert.equal(first.status, 409); assert.equal(first.json.challenge.mode, 'sms'); assert.equal(first.json.challenge.secret, undefined);
  assert.equal(await vault.has(), false); assert.equal(sms, 0);
  assert.equal((await post(server, {}, '/api/pku/sms')).status, 200); assert.equal(sms, 1);
  assert.equal((await post(server, {}, '/api/pku/sms')).status, 429);
  assert.equal((await post(server, { verification: { sms: '123456', captcha: 'abcd' } })).status, 200);
  assert.equal(loginCalls, 2); assert.equal(await vault.has(), true);
});

test('unknown failures never forward upstream messages and unsuccessful login never changes vault', async t => {
  const vault = memoryVault(); await vault.save({ username: 'old', password: 'old-private' });
  const { server } = await setup(t, { vault, createClient: () => mockClient({ login: async () => { throw new Error('new-private-password and token'); } }) });
  const result = await post(server, { username: 'new', password: 'new-private-password', remember: true });
  assert.equal(result.status, 502); assert.doesNotMatch(result.text, /new-private|token|old-private/);
  assert.deepEqual(await vault.load(), { username: 'old', password: 'old-private' });
});

test('forget during an in-flight sync cancels its result and cannot be undone by late vault save', async t => {
  let release, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const { server, vault } = await setup(t, { createClient: () => mockClient({ readDeadlines: () => { reached(); return new Promise(resolve => { release = () => resolve({ items: [ITEM], warnings: [] }); }); } }) });
  const sync = post(server, { username: 'sample-user', password: 'sample-private', remember: true });
  await waiting;
  const forget = request(server, '/api/pku/credentials', { method: 'DELETE' });
  // The second HTTP request must have reached the server before releasing fetch.
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  assert.equal((await sync).status, 409); assert.equal((await forget).status, 200);
  assert.equal(await vault.has(), false);
});

test('idle sessions expire and memory-only passwords are discarded', async t => {
  let now = 0, closed = 0;
  const { server } = await setup(t, { now: () => now, createClient: () => mockClient({ close: () => { closed++; } }) });
  assert.equal((await post(server, { username: 'sample-user', password: 'sample-password' })).status, 200);
  now = 600001;
  assert.deepEqual((await request(server)).json, { remembered: false, connected: false });
  assert.equal(closed, 1); assert.equal((await post(server)).status, 400);
});

test('forget while decrypting saved credentials prevents a late session from being recreated', async t => {
  let release, reached, created = 0;
  const waiting = new Promise(resolve => { reached = resolve; });
  const vault = memoryVault();
  vault.load = () => { reached(); return new Promise(resolve => { release = () => resolve({ username: 'sample-user', password: 'sample-private' }); }); };
  const { server } = await setup(t, { vault, createClient: () => { created++; return mockClient(); } });
  const sync = post(server);
  await waiting;
  const forget = request(server, '/api/pku/credentials', { method: 'DELETE' });
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  assert.equal((await sync).status, 409); assert.equal((await forget).status, 200);
  assert.equal(created, 0);
  assert.deepEqual((await request(server)).json, { remembered: false, connected: false });
});

test('disconnecting a sync request discards its session and ignores a late calendar response', async t => {
  let release, reached, closed = 0;
  const waiting = new Promise(resolve => { reached = resolve; });
  const { server, vault } = await setup(t, { createClient: () => mockClient({ close: () => { closed++; }, readDeadlines: () => { reached(); return new Promise(resolve => { release = () => resolve({ items: [ITEM], warnings: [] }); }); } }) });
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/pku/sync', method: 'POST', headers: { Authorization: 'Bearer ' + PAIR, Origin: 'null', 'Content-Type': 'application/json' } });
  req.on('error', () => {});
  req.end(JSON.stringify({ username: 'sample-user', password: 'sample-password', remember: true }));
  await waiting; req.destroy();
  await new Promise(resolve => setTimeout(resolve, 25));
  release();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await vault.has(), false); assert.equal(closed, 1);
  assert.deepEqual((await request(server)).json, { remembered: false, connected: false });
});

test('browser sync client and loopback API produce a validated merge without persisting credentials', async t => {
  const K = require('../dist/pku.js'), D = require('../dist/data.js');
  const { server, vault } = await setup(t);
  const port = server.address().port;
  const viaServer = (url, init) => fetch(url.replace('http://127.0.0.1:4174', 'http://127.0.0.1:' + port), { ...init, headers: { ...init.headers, Origin: 'null' } });
  const result = await K.request({ key: PAIR, path: '/api/pku/sync', method: 'POST', body: { username: 'sample-user', password: 'sample-private-password', remember: true }, fetchImpl: viaServer });
  const state = D.emptyState('2026-11-09'), plan = K.createPlan(state, result.items);
  const merged = K.applyPlan(state, plan, [{ sourceId: ITEM.sourceId, targetId: null }]);
  assert.equal(merged.ok, true); assert.equal(merged.value.tasks[0].due, ITEM.due);
  assert.equal(merged.value.tasks[0].progress, 0); assert.equal(merged.value.tasks[0].target, 100);
  assert.doesNotMatch(JSON.stringify(merged.value), /sample-user|sample-private-password|aaaaaaaaaaaaaaaa/);
  assert.equal(await vault.has(), true);
});
