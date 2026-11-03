'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createServer } = require('../preview.cjs');
async function serverFor(t, fetchImpl) {
  const server = createServer({ fetchImpl }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}
function request(server, route, options = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const req = http.request({ host: '127.0.0.1', port, path: route, method: options.method || 'GET', headers: { Host: '127.0.0.1:' + port, ...options.headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(options.body);
  });
}
function payload(extra = {}) { return JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash', apiKey: 'private-test-key', messages: [{ role: 'system', content: 'JSON only' }, { role: 'user', content: '修改任务' }], ...extra }); }
function post(server, body = payload(), headers = {}) { return request(server, '/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body }); }
function response(extra = {}) { return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"summary":"完成","actions":[]}' } }] }), ...extra }; }

test('local server serves only exact public assets and blocks raw or encoded traversals and private files', async t => {
  const server = await serverFor(t, () => { throw new Error('unexpected outbound request'); });
  assert.equal((await request(server, '/')).status, 200); assert.equal((await request(server, '/ai.js')).status, 200);
  assert.equal((await request(server, '/%E6%9C%89%E5%BA%8F.html')).status, 200);
  for (const route of ['/../package.json', '/%2e%2e/package.json', '/%252e%252e/package.json', '/%2eenv', '/.git/config', '/.openai/key', '/.task-tmp/output', '/package.json', '/preview.cjs', '/dist/app.js', '/..%5cpackage.json', '//index.html', '/%00']) assert.ok([400, 403, 404].includes((await request(server, route)).status), route);
  assert.equal((await request(server, '/app.js', { method: 'HEAD' })).text, '');
});

test('proxy rejects cross-origin, hostile Host, CORS preflight, invalid content type and unsupported endpoints', async t => {
  let calls = 0; const server = await serverFor(t, async () => { calls++; return response(); });
  assert.equal((await post(server, payload(), { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(server, payload(), { Host: 'evil.example' })).status, 403);
  assert.equal((await post(server, payload(), { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await request(server, '/api/ai', { method: 'OPTIONS' })).status, 405);
  assert.equal((await post(server, payload(), { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post(server, payload({ provider: 'http://127.0.0.1:9999' }))).status, 400);
  assert.equal((await post(server, payload({ url: 'https://evil.example' }))).status, 400);
  assert.equal((await post(server, payload({ messages: [{ role: 'tool', content: 'bad' }] }))).status, 400);
  assert.equal((await post(server, payload({ apiKey: 'key\r\nX-Leak: yes' }))).status, 400);
  assert.equal(calls, 0);
});

test('proxy forwards both official providers with bearer authentication and no arbitrary destinations', async t => {
  const requests = [], server = await serverFor(t, async (url, init) => { requests.push({ url, init }); return response(); });
  for (const provider of ['deepseek', 'openai']) {
    const result = await post(server, payload({ provider }), { Origin: 'http://127.0.0.1:' + server.address().port });
    assert.equal(result.status, 200); assert.equal(result.headers['access-control-allow-origin'], undefined);
    assert.equal(JSON.parse(JSON.parse(result.text).choices[0].message.content).summary, '完成');
  }
  assert.deepEqual(requests.map(item => item.url), ['https://api.deepseek.com/chat/completions', 'https://api.openai.com/v1/chat/completions']);
  for (const item of requests) {
    assert.equal(item.init.headers.Authorization, 'Bearer private-test-key'); assert.equal(item.init.redirect, 'error');
    const body = JSON.parse(item.init.body); assert.equal(body.stream, false); assert.equal(body.apiKey, undefined); assert.equal(body.provider, undefined);
  }
});

test('proxy limits request bodies and sanitizes provider and transport errors', async t => {
  let status = 401, calls = 0;
  const server = await serverFor(t, async () => { calls++; if (status === -1) throw new Error('private-test-key'); return response({ ok: false, status, text: async () => 'private-test-key' }); });
  assert.equal((await post(server, 'x'.repeat(1024 * 1024 + 1))).status, 413); assert.equal(calls, 0);
  assert.equal((await post(server, '{broken')).status, 400);
  for (const next of [401, 429, 500, -1]) {
    status = next; const result = await post(server);
    assert.equal(result.status, next === 401 || next === 429 ? next : 502); assert.doesNotMatch(result.text, /private-test-key/);
  }
});

test('proxy removes unrelated metadata and leaked keys from successful upstream messages', async t => {
  const server = await serverFor(t, async () => response({ text: async () => JSON.stringify({ secret: 'private-test-key', choices: [{ finish_reason: 'stop', message: { content: '{"summary":"private-test-key","actions":[]}' } }] }) }));
  const result = await post(server); assert.equal(result.status, 200); assert.doesNotMatch(result.text, /private-test-key/); assert.match(result.text, /已隐藏密钥/);
});
