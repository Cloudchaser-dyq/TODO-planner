'use strict';
// This process is a local companion. It never serves vault files or task backups.
const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const MAX_BODY = 16 * 1024;
const PAIR_PATTERN = /^[a-f0-9]{64}$/;
function createServer(options = {}) {
  const vault = options.vault || require('./pku-vault.cjs').createVault();
  const makeClient = options.createClient || require('./pku-client.cjs').createClient;
  const pairingCode = options.pairingCode || randomBytes(32).toString('hex');
  if (!PAIR_PATTERN.test(pairingCode)) throw new Error('配对码格式无效。');
  let session = null, busy = false, clearing = false, generation = 0, operation = null;
  const clock = options.now || Date.now;
  function closeSession() {
    if (session) session.client.close();
    session = null;
  }
  function currentSession() {
    if (session && clock() - session.touched > 10 * 60 * 1000) closeSession();
    return session;
  }
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowedHosts = ['127.0.0.1:' + port, 'localhost:' + port];
    const origin = req.headers.origin;
    const allowedOrigins = ['null', 'http://127.0.0.1:4173', 'http://localhost:4173', ...allowedHosts.map(host => 'http://' + host)];
    function send(status, value) {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
        ...(origin && allowedOrigins.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {})
      });
      res.end(JSON.stringify(value));
    }
    if (!allowedHosts.includes(req.headers.host) || (origin && !allowedOrigins.includes(origin))) {
      send(403, { error: '仅允许已配对的本地网页访问。' }); return;
    }
    // Exact paths and methods, including the unauthenticated CORS preflight.
    if (!['/api/pku/status', '/api/pku/sync', '/api/pku/sms', '/api/pku/credentials'].includes(req.url)) {
      send(404, { error: '请在有序网页中打开“教学网同步”，填入终端里的配对码。' }); return;
    }
    if (req.method === 'OPTIONS') {
      const method = req.headers['access-control-request-method'];
      const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (!origin || !['GET', 'POST', 'DELETE'].includes(method) || !headers.includes('authorization') || headers.some(h => !['authorization', 'content-type'].includes(h))) {
        send(403, { error: '预检请求无效。' }); return;
      }
      res.writeHead(204, {
        'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, DELETE',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '0',
        ...(req.headers['access-control-request-private-network'] === 'true' ? { 'Access-Control-Allow-Private-Network': 'true' } : {}),
        Vary: 'Origin', 'Cache-Control': 'no-store'
      }); res.end(); return;
    }
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || auth.length !== 71 || !PAIR_PATTERN.test(auth.slice(7)) || !auth.startsWith('Bearer ') || !timingSafeEqual(Buffer.from(auth.slice(7)), Buffer.from(pairingCode))) {
      send(401, { error: '配对码不正确，请从本机连接器终端复制。' }); return;
    }
    const requestGeneration = generation;
    try {
      if (req.url === '/api/pku/status' && req.method === 'GET') {
        send(200, { remembered: await vault.has(), connected: !!currentSession()?.connected }); return;
      }
      if (req.url === '/api/pku/credentials' && req.method === 'DELETE') {
        if (clearing) { send(409, { error: '正在清除登录信息。' }); return; }
        clearing = true;
        ++generation;
        closeSession();
        // A clear takes effect after any in-flight save, so a late login cannot
        // restore credentials after the user has forgotten them.
        try {
          if (operation) await operation.catch(() => {});
          closeSession();
          await vault.clear();
          send(200, { remembered: false, connected: false }); return;
        } finally { clearing = false; }
      }
      if (req.method !== 'POST' || !['/api/pku/sync', '/api/pku/sms'].includes(req.url)) {
        send(405, { error: '请求方式无效。' }); return;
      }
      if (busy) { send(409, { error: '正在同步，请等待当前请求完成。' }); return; }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) {
        send(415, { error: '请使用 JSON 请求。' }); return;
      }
      let input;
      try { input = JSON.parse(await readBody(req)); }
      catch (error) { send(error.status || 400, { error: error.status === 413 ? '请求内容过大。' : '请求内容无效。' }); return; }
      if (!validInput(input, req.url.endsWith('/sms'))) { send(400, { error: '登录参数格式无效。' }); return; }
      if (busy || clearing || requestGeneration !== generation) { send(409, { error: '登录状态已变化，请重新操作。' }); return; }
      busy = true;
      const started = generation;
      let finish;
      operation = new Promise(resolve => { finish = resolve; });
      const disconnected = () => {
        if (!res.writableEnded && started === generation) { ++generation; closeSession(); }
      };
      res.once('close', disconnected);
      try {
        if (req.url.endsWith('/sms')) {
          const active = currentSession();
          if (!active || active.connected) { send(409, { error: '请先填写账号并点击“读取 DDL”。' }); return; }
          if (active.smsAt != null && clock() - active.smsAt < 60000) { send(429, { error: '短信已发送，请稍后再试。' }); return; }
          await active.client.sendSms(active.username);
          active.smsAt = clock(); active.touched = clock();
          send(200, { sent: true }); return;
        }
        let credentials;
        if (input.username !== undefined) credentials = { username: input.username.trim(), password: input.password };
        else if (currentSession()) credentials = { username: session.username, password: session.password };
        else credentials = await vault.load();
        if (started !== generation || clearing) { send(409, { error: '本次同步已取消。' }); return; }
        if (!credentials) { send(400, { error: '请填写账号和密码，或使用已保存的登录信息。' }); return; }
        let active = currentSession();
        if (!active || active.username !== credentials.username || active.password !== credentials.password) {
          closeSession();
          active = { ...credentials, client: makeClient(), connected: false, touched: clock(), prepared: false, remember: false };
          session = active;
        }
        active.touched = clock();
        if (input.remember !== undefined) active.remember = input.remember;
        if (!active.connected) {
          if (!active.prepared) { await active.client.prepare(active.username); active.prepared = true; }
          await active.client.login({ username: active.username, password: active.password, verification: input.verification || {} });
          active.connected = true;
        }
        const result = await active.client.readDeadlines(active.username);
        if (started !== generation || session !== active) { send(409, { error: '本次同步已取消。' }); return; }
        // Strict projection prevents arbitrary upstream metadata (or credentials)
        // from crossing the loopback API boundary.
        const items = projectItems(result.items);
        if (active.remember) await vault.save({ username: active.username, password: active.password });
        else if (input.remember === false) await vault.clear();
        if (started !== generation) { send(409, { error: '本次同步已取消。' }); return; }
        send(200, { items, warnings: Array.isArray(result.warnings) ? result.warnings.filter(w => typeof w === 'string').slice(0, 20) : [] });
      } catch (error) {
        if (error.code === 'CHALLENGE' && started === generation) {
          const challenge = safeChallenge(error.challenge);
          send(409, { error: '请完成教学网身份验证，再次点击“读取 DDL”。', challenge });
        } else {
          if (started === generation) closeSession();
          send(error.code === 'AUTH_FAILED' ? 401 : 502, { error: error.publicMessage || '教学网同步失败，请检查网络和登录信息后重试。' });
        }
      } finally { res.removeListener('close', disconnected); busy = false; finish(); operation = null; }
    } catch {
      send(500, { error: '无法读取本机加密登录信息，请清除后重新登录。' });
    }
  });
  server.requestTimeout = 180000;
  const expiry = setInterval(currentSession, 60000); expiry.unref();
  server.on('close', () => { ++generation; closeSession(); clearInterval(expiry); });
  return { server, pairingCode };
}
function validInput(value, sms = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (sms) return Object.keys(value).length === 0;
  if (Object.keys(value).some(k => !['username', 'password', 'remember', 'verification'].includes(k))) return false;
  if ((value.username !== undefined) !== (value.password !== undefined)) return false;
  if (value.username !== undefined && (typeof value.username !== 'string' || !/^[A-Za-z0-9@._-]{1,100}$/.test(value.username.trim()) || typeof value.password !== 'string' || !value.password || value.password.length > 1024 || /[\r\n\u0000]/.test(value.password))) return false;
  if (value.remember !== undefined && typeof value.remember !== 'boolean') return false;
  if (value.verification !== undefined) {
    if (!value.verification || typeof value.verification !== 'object' || Array.isArray(value.verification)) return false;
    if (Object.keys(value.verification).some(k => !['captcha', 'sms', 'otp'].includes(k) || typeof value.verification[k] !== 'string' || !/^[A-Za-z0-9]{0,12}$/.test(value.verification[k]))) return false;
  }
  return true;
}
function safeChallenge(value) {
  const out = { captchaRequired: !!value?.captchaRequired, mode: ['sms', 'otp'].includes(value?.mode) ? value.mode : 'none' };
  if (typeof value?.captchaImage === 'string' && /^data:image\/(?:png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(value.captchaImage) && value.captchaImage.length <= 512000) out.captchaImage = value.captchaImage;
  return out;
}
function projectItems(items) {
  if (!Array.isArray(items) || items.length > 5000) throw new Error('invalid calendar items');
  return items.map(item => {
    if (!item || !/^[a-f0-9]{64}$/.test(item.sourceId) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 || typeof item.course !== 'string' || item.course.length > 200 || typeof item.due !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2})?$/.test(item.due)) throw new Error('invalid calendar item');
    let url; try { url = new URL(item.sourceUrl); } catch { throw new Error('invalid calendar link'); }
    if (url.origin !== 'https://course.pku.edu.cn' || url.username || url.password || url.hash || Array.from(url.searchParams.keys()).some(key => /token|password|session|ticket/i.test(key))) throw new Error('invalid calendar link');
    return { sourceId: item.sourceId, title: item.title, course: item.course, due: item.due, sourceUrl: url.href };
  });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], failed = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { chunks = []; if (!failed) reject(Object.assign(new Error(), { status: 413 })); failed = true; }
      else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => { if (!failed) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject); req.on('aborted', () => reject(new Error()));
  });
}
function start(options = {}) {
  const result = createServer(options);
  result.server.listen(options.port ?? 4174, '127.0.0.1', () => {
    if (!options.quiet) {
      console.log('有序 · 北京大学教学网本地连接器');
      console.log('地址：http://127.0.0.1:' + result.server.address().port);
      console.log('配对码：' + result.pairingCode);
      console.log('在原来的有序网页 → 任务清单 → 教学网同步中粘贴配对码。');
      console.log('账号密码通过 Windows 系统加密保存在本机用户目录。关闭本窗口可停止连接器。');
    }
  });
  return result;
}
if (require.main === module) {
  try {
    const { server } = start();
    server.on('error', error => {
      console.error(error.code === 'EADDRINUSE' ? '4174 端口已被使用。请关闭已运行的连接器后重试。' : '本地连接器启动失败。');
      process.exitCode = 1;
    });
  } catch { console.error('本地连接器启动失败，请使用 Windows 和 Node.js 22 或更新版本。'); process.exitCode = 1; }
}
module.exports = { createServer, start, validInput, projectItems };
