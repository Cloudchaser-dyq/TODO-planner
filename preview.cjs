'use strict';
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const AI = require('./dist/ai.js');
const DIST = path.join(__dirname, 'dist');
const MAX_BODY = 1024 * 1024;
const STATIC = new Set(['index.html', 'styles.css', 'planner.js', 'data.js', 'imports.js', 'app.js', 'ai.js']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
function send(res, status, text, type = 'application/json; charset=utf-8') {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(type.startsWith('application/json') ? JSON.stringify({ error: text }) : text);
}
function trustedRequest(req, server) {
  const port = server.address() && server.address().port;
  if (!['127.0.0.1:' + port, 'localhost:' + port].includes(req.headers.host)) return false;
  if (req.headers.origin && req.headers.origin !== 'http://' + req.headers.host) return false;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return false;
  return true;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY) { req.resume(); reject(Object.assign(new Error('请求内容过大。'), { status: 413 })); return; }
    let size = 0, parts = [], failed = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { if (!failed) reject(Object.assign(new Error('请求内容过大。'), { status: 413 })); failed = true; parts = []; }
      else if (!failed) parts.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(parts).toString('utf8')); });
    req.on('error', () => reject(Object.assign(new Error('无法读取请求。'), { status: 400 })));
    req.on('aborted', () => reject(Object.assign(new Error('请求已取消。'), { status: 400 })));
  });
}
function validateProxy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['provider', 'model', 'apiKey', 'messages'].includes(key))) return false;
  if (!Object.hasOwn(AI.PROVIDERS, value.provider)) return false;
  if (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /[\r\n]/.test(value.model)) return false;
  if (typeof value.apiKey !== 'string' || !value.apiKey.trim() || value.apiKey.length > 4096 || /[\r\n]/.test(value.apiKey)) return false;
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 10) return false;
  return value.messages.every(message => message && typeof message === 'object' && !Array.isArray(message) && Object.keys(message).every(key => ['role', 'content'].includes(key)) && ['system', 'user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content.length <= 800000);
}
function createServer(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const server = http.createServer(async (req, res) => {
    if (!trustedRequest(req, server)) { send(res, 403, '仅允许本机同源请求。'); return; }
    let pathname;
    try {
      // Inspect raw segments before URL normalization can erase a traversal.
      pathname = decodeURIComponent(String(req.url || '').split('?')[0]);
      if (!pathname.startsWith('/') || /[\\\u0000]/.test(pathname) || pathname.split('/').some(segment => segment === '.' || segment === '..' || segment.startsWith('.'))) throw new Error();
    } catch { send(res, 400, '无效路径。'); return; }
    if (pathname === '/api/ai') {
      if (req.method !== 'POST') { send(res, 405, '仅支持 POST 请求。'); return; }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) { send(res, 415, '请使用 JSON 请求。'); return; }
      let input;
      try { input = JSON.parse(await readBody(req)); } catch (error) { send(res, error.status || 400, error.status ? error.message : '请求 JSON 无效。'); return; }
      if (!validateProxy(input)) { send(res, 400, 'AI 请求参数无效，仅支持指定的官方服务。'); return; }
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60000);
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.once('close', disconnected);
      try {
        const upstream = await fetchImpl(AI.PROVIDERS[input.provider].url, { method: 'POST', credentials: 'omit', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + input.apiKey.trim() }, body: JSON.stringify({ model: input.model.trim(), messages: input.messages, stream: false }) });
        if (!upstream.ok) { send(res, [400, 401, 403, 404, 429].includes(upstream.status) ? upstream.status : 502, AI.httpError(upstream.status)); return; }
        const raw = await AI.readResponseText(upstream);
        let json; try { json = JSON.parse(raw); } catch { send(res, 502, 'AI 服务返回了无效响应。'); return; }
        const choice = json && json.choices && json.choices[0];
        if (!choice || !choice.message || typeof choice.message.content !== 'string') { send(res, 502, 'AI 未返回可读取的修改方案。'); return; }
        // Do not forward raw provider errors or unrelated response metadata.
        const content = choice.message.content.split(input.apiKey.trim()).join('[已隐藏密钥]');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        res.end(JSON.stringify({ choices: [{ finish_reason: choice.finish_reason, message: { content, ...(choice.message.refusal ? { refusal: true } : {}) } }] }));
      } catch { send(res, controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'AI 请求超时或已取消。' : '无法连接 AI 服务，请检查网络后重试。'); }
      finally { clearTimeout(timer); res.removeListener('close', disconnected); }
      return;
    }
    if (!['GET', 'HEAD'].includes(req.method)) { send(res, 405, '仅支持 GET 或 HEAD。'); return; }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!STATIC.has(name) && name !== '有序.html') { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); return; }
    const filename = name === '有序.html' ? path.join(__dirname, name) : path.join(DIST, name);
    try {
      const resolved = await fs.realpath(filename), permittedRoot = name === '有序.html' ? __dirname : DIST;
      if (path.dirname(resolved) !== permittedRoot) { send(res, 403, '不允许访问该文件。'); return; }
      const data = await fs.readFile(resolved);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(name)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { send(res, 404, 'Not found', 'text/plain; charset=utf-8'); }
  });
  server.requestTimeout = 65000;
  return server;
}
function start(options = {}) {
  const server = createServer(options);
  server.listen(options.port == null ? 4173 : options.port, '127.0.0.1', () => {
    if (!options.quiet) console.log('Local: http://127.0.0.1:' + server.address().port);
  });
  return server;
}
if (require.main === module) start();
module.exports = { createServer, start };
