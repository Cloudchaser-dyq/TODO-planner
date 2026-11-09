'use strict';

const crypto = require('node:crypto');

const COURSE = 'https://course.pku.edu.cn';
const IAAA = 'https://iaaa.pku.edu.cn';
const CALLBACK = COURSE + '/webapps/bb-sso-BBLEARN/execute/authValidate/campusLogin';
const CALENDAR = COURSE + '/webapps/calendar/viewPersonal';
const DAY = 86400000;
const ALLOWED_HOSTS = new Set(['course.pku.edu.cn', 'iaaa.pku.edu.cn']);
const LIMIT = 4 * 1024 * 1024;

// Authentication fields and RSA key retrieval follow PKU's public OAuthLogin.js:
// https://iaaa.pku.edu.cn/iaaa/resources/javascript/OAuthLogin.js?_v=20251215
// Calendar requests use Blackboard's explicit-calendar profile, so a user's
// hidden/unchecked calendars do not silently disappear from synchronization.
// The authenticated PKU calendar response must still be checked with a real
// account; unsupported response shapes are errors, never an empty success.
function publicError(code, message, challenge) {
  const error = new Error(message);
  error.code = code;
  error.publicMessage = message;
  if (challenge) error.challenge = challenge;
  return error;
}

function safeUrl(value, base) {
  let url;
  try { url = new URL(value, base); } catch { throw publicError('UPSTREAM', '教学网返回了无法识别的地址。'); }
  // PKU's published SSO callback still uses http://course.pku.edu.cn. Upgrade
  // this exact official host before sending anything; no HTTP request is made.
  if (url.protocol === 'http:' && ALLOWED_HOSTS.has(url.hostname) && !url.port && !url.username && !url.password) url.protocol = 'https:';
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) ||
      (url.port && url.port !== '443') || url.username || url.password) {
    throw publicError('UPSTREAM', '教学网跳转地址未通过安全校验。');
  }
  url.hash = '';
  return url;
}

function cookiePath(pathname) {
  const at = pathname.lastIndexOf('/');
  return at <= 0 ? '/' : pathname.slice(0, at);
}

function matchesPath(pathname, path) {
  return pathname === path || (pathname.startsWith(path) && (path.endsWith('/') || pathname[path.length] === '/'));
}

function parseRedirect(html) {
  const match = html.match(/(?:document|window)\.location(?:\.href)?\s*=\s*(['"])([^'"\r\n]{1,8192})\1/i) ||
    html.match(/(?:document|window)\.location\.replace\(\s*(['"])([^'"\r\n]{1,8192})\1\s*\)/i);
  if (!match) return null;
  const decoded = match[2].replace(/\\x([\da-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\u([\da-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, '/').replace(/&amp;/g, '&');
  if (decoded.includes('\\')) throw publicError('UPSTREAM', '教学网返回了无法识别的跳转。');
  return decoded;
}

function isLoginPage(result) {
  return result.url.pathname.startsWith('/webapps/login') || result.url.hostname === 'iaaa.pku.edu.cn' ||
    /(?:name=["']login["'][^>]*|id=["']user_id["']|id=["']user_name["']|正在转向北京大学身份认证系统)/i.test(result.text);
}

function cleanText(value, max) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
}

function parseDate(value) {
  // Accept millisecond epoch values only; ten-digit seconds are not guessed.
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < Date.UTC(2000, 0, 1) || value > Date.UTC(2100, 0, 1)) return null;
    return { due: new Date(value + 8 * 3600000).toISOString().slice(0, 16), epoch: value };
  }
  if (typeof value !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const epoch = Date.parse(value + 'T00:00:00+08:00');
    if (!Number.isFinite(epoch) || new Date(epoch + 8 * 3600000).toISOString().slice(0, 10) !== value) return null;
    return { due: value, epoch };
  }
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i);
  if (!m || +m[4] > 23 || +m[5] > 59 || +(m[6] || 0) > 59 || +m[2] < 1 || +m[2] > 12 || +m[3] < 1) return null;
  const calendarDate = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (calendarDate.getUTCMonth() + 1 !== +m[2] || calendarDate.getUTCDate() !== +m[3]) return null;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  return { due: new Date(epoch + 8 * 3600000).toISOString().slice(0, 16), epoch };
}

function createClient({ fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 15000 } = {}) {
  if (typeof fetchImpl !== 'function') throw publicError('UNSUPPORTED', '请使用 Node.js 22 或更新版本启动同步服务。');
  let closed = false;
  let preparedFor = null;
  let authenticatedFor = null;
  let publicKey = null;
  let challenge = { mode: 'none', captchaRequired: false };
  const cookies = [];
  const requests = new Set();

  function checkOpen() {
    if (closed) throw publicError('UPSTREAM', '教学网连接已关闭，请重新连接。');
  }

  function usernameChecked(username) {
    if (typeof username !== 'string' || !username.trim() || username.length > 128 || /[\u0000-\u001f\u007f]/.test(username)) {
      throw publicError('AUTH_FAILED', '请填写有效的教学网账号。');
    }
    return username.trim();
  }

  function absorbCookies(headers, url) {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() :
      (headers.get('set-cookie') || '').split(/,(?=\s*[^\s;,=]+\s*=)/).filter(Boolean);
    for (const line of list) {
      if (line.length > 8192) throw publicError('UPSTREAM', '教学网会话数据过大，请重新登录。');
      const parts = line.split(';');
      const pair = parts.shift();
      const split = pair.indexOf('=');
      if (split <= 0) continue;
      const cookie = { name: pair.slice(0, split).trim(), value: pair.slice(split + 1).trim(), domain: url.hostname,
        hostOnly: true, path: cookiePath(url.pathname), secure: false, expires: Infinity };
      if (!/^[!#$%&'*+.^_`|~\w-]+$/.test(cookie.name) || /[\r\n\u0000]/.test(cookie.value)) continue;
      let invalid = false;
      let maxAge;
      for (const attr of parts) {
        const i = attr.indexOf('=');
        const name = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const value = (i < 0 ? '' : attr.slice(i + 1)).trim();
        if (name === 'domain') {
          const domain = value.toLowerCase().replace(/^\./, '');
          // PKU's own parent domain is allowed; arbitrary public suffixes are not.
          if (!(domain === url.hostname || domain === 'pku.edu.cn')) { invalid = true; break; }
          cookie.domain = domain;
          cookie.hostOnly = false;
        } else if (name === 'path' && value.startsWith('/')) cookie.path = value;
        else if (name === 'secure') cookie.secure = true;
        else if (name === 'max-age' && /^-?\d+$/.test(value)) maxAge = +value;
        else if (name === 'expires' && Number.isFinite(Date.parse(value))) cookie.expires = Date.parse(value);
      }
      if (invalid) continue;
      if (maxAge !== undefined) cookie.expires = now() + maxAge * 1000;
      const index = cookies.findIndex(c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path);
      if (index >= 0) cookies.splice(index, 1);
      if (cookie.expires > now()) cookies.push(cookie);
      if (cookies.length > 200) throw publicError('UPSTREAM', '教学网会话数据过多，请重新登录。');
    }
  }

  function cookieHeader(url) {
    for (let i = cookies.length - 1; i >= 0; i--) if (cookies[i].expires <= now()) cookies.splice(i, 1);
    const header = cookies.filter(c => (c.hostOnly ? url.hostname === c.domain :
      url.hostname === c.domain || url.hostname.endsWith('.' + c.domain)) &&
      matchesPath(url.pathname, c.path) && (!c.secure || url.protocol === 'https:'))
      .sort((a, b) => b.path.length - a.path.length).map(c => c.name + '=' + c.value).join('; ');
    if (header.length > 16384) throw publicError('UPSTREAM', '教学网会话数据过大，请重新登录。');
    return header;
  }

  async function request(value, { method = 'GET', body, maxBytes = LIMIT, accept = 'application/json,text/html;q=0.9' } = {}) {
    checkOpen();
    let url = safeUrl(value);
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for (let redirects = 0; redirects <= 5; redirects++) {
        checkOpen();
        const headers = { Accept: accept, 'User-Agent': 'YouXu-Local-PKU-Sync/1.0' };
        const cookie = cookieHeader(url);
        if (cookie) headers.Cookie = cookie;
        if (body !== undefined) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
          headers.Origin = url.origin;
          headers.Referer = IAAA + '/iaaa/oauth.jsp';
        }
        const response = await fetchImpl(url.href, { method, headers, body, redirect: 'manual', signal: controller.signal });
        checkOpen();
        // A fetch replacement must preserve the same manual redirect semantics.
        if (response.redirected || (response.url && new URL(response.url).href !== url.href)) {
          throw publicError('UPSTREAM', '教学网返回了未经校验的跳转。');
        }
        absorbCookies(response.headers, url);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (response.body) await response.body.cancel();
          if (!location || redirects === 5) throw publicError('UPSTREAM', '教学网跳转次数过多，请稍后重试。');
          const next = safeUrl(location, url);
          if (method !== 'GET' && method !== 'HEAD') {
            if (response.status === 303 || response.status === 301 || response.status === 302) { method = 'GET'; body = undefined; }
            else if (next.origin !== url.origin) throw publicError('UPSTREAM', '教学网登录请求发生了不安全的跨站跳转。');
          }
          url = next;
          continue;
        }
        if (response.status === 401 || response.status === 403) {
          if (response.body) await response.body.cancel();
          throw publicError('AUTH_FAILED', '教学网登录已失效，请重新登录。');
        }
        if (response.status < 200 || response.status >= 300) {
          if (response.body) await response.body.cancel();
          throw publicError('UPSTREAM', '教学网暂时无法响应，请稍后重试。');
        }
        const length = Number(response.headers.get('content-length'));
        if (Number.isFinite(length) && length > maxBytes) {
          if (response.body) await response.body.cancel();
          throw publicError('UPSTREAM', '教学网返回的数据过大，请缩小同步范围。');
        }
        const chunks = [];
        let total = 0;
        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader();
          try {
            while (true) {
              const part = await reader.read();
              if (part.done) break;
              total += part.value.byteLength;
              if (total > maxBytes) { await reader.cancel(); throw publicError('UPSTREAM', '教学网返回的数据过大，请缩小同步范围。'); }
              chunks.push(Buffer.from(part.value));
            }
          } finally { reader.releaseLock(); }
        } else {
          const buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.length > maxBytes) throw publicError('UPSTREAM', '教学网返回的数据过大，请缩小同步范围。');
          chunks.push(buffer);
        }
        const buffer = Buffer.concat(chunks);
        return { url, buffer, text: buffer.toString('utf8'), type: (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
      }
    } catch (error) {
      if (error && error.publicMessage) throw error;
      throw publicError('UPSTREAM', closed ? '教学网连接已关闭，请重新连接。' : '教学网连接失败或超时，请稍后重试。');
    } finally { clearTimeout(timeout); requests.delete(controller); }
  }

  async function json(url, options) {
    const response = await request(url, options);
    if (isLoginPage(response)) throw publicError('AUTH_FAILED', '教学网登录已失效，请重新登录。');
    try { return JSON.parse(response.text); }
    catch { throw publicError('UNSUPPORTED', '教学网数据格式发生变化，请保留现有任务并稍后重试。'); }
  }

  // IAAA is also a JSON API, so it deliberately bypasses the page host test.
  async function iaaaJson(path, options) {
    const response = await request(IAAA + path, options);
    try { return JSON.parse(response.text); }
    catch { throw publicError('UPSTREAM', '北大身份认证暂时无法响应，请稍后重试。'); }
  }

  async function withCaptcha(value) {
    const next = { mode: value.mode, captchaRequired: !!value.captchaRequired };
    if (next.captchaRequired) {
      const image = await request(IAAA + '/iaaa/servlet/DrawServlet?Rand=' + now(), { maxBytes: 256 * 1024, accept: 'image/png,image/jpeg,image/gif' });
      if (!['image/png', 'image/jpeg', 'image/gif'].includes(image.type) || image.buffer.length === 0) {
        throw publicError('UPSTREAM', '验证码图片暂时无法加载，请重新连接。');
      }
      next.captchaImage = 'data:' + image.type + ';base64,' + image.buffer.toString('base64');
    }
    return next;
  }

  async function prepare(username) {
    checkOpen();
    username = usernameChecked(username);
    if (preparedFor !== username) {
      cookies.length = 0;
      authenticatedFor = null;
    }
    preparedFor = null;
    publicKey = null;
    await request(COURSE + '/webapps/login/', { maxBytes: 1024 * 1024 });
    const entry = new URL(IAAA + '/iaaa/oauth.jsp');
    entry.search = new URLSearchParams({ appID: 'blackboard', appName: '1', redirectUrl: CALLBACK }).toString();
    await request(entry, { maxBytes: 1024 * 1024 });
    const keyData = await iaaaJson('/iaaa/getPublicKey.do', { maxBytes: 16384 });
    if (!keyData || keyData.success !== true || typeof keyData.key !== 'string' || keyData.key.length > 8192) {
      throw publicError('UNSUPPORTED', '北大身份认证加密信息暂不可用，请稍后重试。');
    }
    try {
      const key = keyData.key.includes('-----BEGIN') ? keyData.key :
        '-----BEGIN PUBLIC KEY-----\n' + keyData.key + '\n-----END PUBLIC KEY-----';
      publicKey = crypto.createPublicKey(key);
      if (publicKey.asymmetricKeyType !== 'rsa') throw new Error();
    } catch { throw publicError('UNSUPPORTED', '北大身份认证加密信息格式发生变化，请稍后重试。'); }
    const codeData = await iaaaJson('/iaaa/isShowCode.do', { maxBytes: 16384 });
    if (!codeData || typeof codeData.success !== 'boolean') throw publicError('UNSUPPORTED', '北大身份认证验证信息格式发生变化。');
    const modeData = await iaaaJson('/iaaa/isMobileAuthen.do?' + new URLSearchParams({ userName: username, appId: 'blackboard', _rand: String(now()) }), { maxBytes: 16384 });
    if (!modeData || modeData.success !== true || typeof modeData.isMobileAuthen !== 'boolean') {
      throw publicError('AUTH_FAILED', '无法确认教学网账号的验证方式，请检查账号后重试。');
    }
    let mode = 'none';
    if (modeData.isMobileAuthen) {
      if (!['SMS', 'OTP'].includes(modeData.authenMode)) throw publicError('UNSUPPORTED', '教学网要求的验证方式暂不受支持，请先在官网登录。');
      if (modeData.authenMode === 'OTP' && modeData.isBind === false) throw publicError('AUTH_FAILED', '请先在北大身份认证页面绑定手机令牌。');
      mode = modeData.authenMode.toLowerCase();
    }
    challenge = await withCaptcha({ mode, captchaRequired: codeData.success });
    preparedFor = username;
    return { ...challenge };
  }

  async function sendSms(username) {
    username = usernameChecked(username);
    if (preparedFor !== username) await prepare(username);
    if (challenge.mode !== 'sms') throw publicError('AUTH_FAILED', '当前账号无需短信验证。');
    const result = await iaaaJson('/iaaa/sendSMSCode.do?' + new URLSearchParams({ userName: username, appId: 'blackboard', _rand: String(now()) }), { maxBytes: 16384 });
    if (!result || result.success !== true) throw publicError('AUTH_FAILED', '验证码发送失败，请稍后重试或在官网查看账号状态。');
    return { ok: true };
  }

  async function login({ username, password, verification = {} } = {}) {
    username = usernameChecked(username);
    authenticatedFor = null;
    if (typeof password !== 'string' || !password || password.length > 512) throw publicError('AUTH_FAILED', '请填写有效的教学网密码。');
    if (preparedFor !== username || !publicKey) await prepare(username);
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)) throw publicError('AUTH_FAILED', '请填写有效的验证信息。');
    for (const field of ['captcha', 'sms', 'otp']) {
      if (verification[field] != null && (typeof verification[field] !== 'string' || verification[field].length > 128 || /[\r\n\u0000]/.test(verification[field]))) {
        throw publicError('AUTH_FAILED', '请填写有效的验证信息。');
      }
    }
    if ((challenge.captchaRequired && !verification.captcha) || (challenge.mode === 'sms' && !verification.sms) || (challenge.mode === 'otp' && !verification.otp)) {
      throw publicError('CHALLENGE', '请补充教学网要求的验证信息。', { ...challenge });
    }
    let encrypted;
    try { encrypted = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(password, 'utf8')).toString('base64'); }
    catch { throw publicError('AUTH_FAILED', '密码无法按北大认证方式加密，请检查后重试。'); }
    const result = await iaaaJson('/iaaa/oauthlogin.do', {
      method: 'POST', maxBytes: 32768,
      body: new URLSearchParams({ appid: 'blackboard', userName: username, password: encrypted,
        randCode: verification.captcha || '', smsCode: verification.sms || '', otpCode: verification.otp || '', remTrustChk: 'false', redirUrl: CALLBACK }).toString()
    });
    if (!result || result.success !== true) {
      const errorCode = result && result.errors && result.errors.code;
      if (['E03', 'E04', 'E05'].includes(errorCode) || (result && result.showCode === true)) {
        if (errorCode === 'E04') challenge.mode = 'sms';
        if (errorCode === 'E05') challenge.mode = 'otp';
        challenge = await withCaptcha({ mode: challenge.mode, captchaRequired: challenge.captchaRequired || errorCode === 'E03' || result.showCode === true });
        throw publicError('CHALLENGE', '验证未通过，请重新填写验证码或手机令牌。', { ...challenge });
      }
      if (errorCode === 'E02') throw publicError('AUTH_FAILED', '请先在北大身份认证页面激活账号。');
      throw publicError('AUTH_FAILED', '教学网登录失败，请检查账号、密码和验证信息。');
    }
    if (typeof result.token !== 'string' || !result.token || result.token.length > 8192 || /[\r\n\u0000]/.test(result.token)) {
      throw publicError('UPSTREAM', '北大身份认证未返回有效的登录凭据。');
    }
    const callback = new URL(CALLBACK);
    callback.search = new URLSearchParams({ _rand: String(now()), token: result.token }).toString();
    let page = await request(callback, { maxBytes: 2 * 1024 * 1024 });
    for (let i = 0; i <= 5; i++) {
      const redirect = parseRedirect(page.text);
      if (!redirect) break;
      if (i === 5) throw publicError('UPSTREAM', '教学网登录跳转次数过多，请稍后重试。');
      page = await request(safeUrl(redirect, page.url), { maxBytes: 2 * 1024 * 1024 });
    }
    if (isLoginPage(page)) throw publicError('AUTH_FAILED', '教学网未接受本次登录，请重新验证。');
    const calendarPage = await request(CALENDAR, { maxBytes: 2 * 1024 * 1024 });
    if (isLoginPage(calendarPage) || parseRedirect(calendarPage.text)) throw publicError('AUTH_FAILED', '教学网登录已失效，请重新登录。');
    authenticatedFor = username;
    return { ok: true };
  }

  async function readDeadlines(username) {
    checkOpen();
    username = usernameChecked(username);
    if (authenticatedFor !== username) throw publicError('AUTH_FAILED', '请先登录教学网，再同步截止时间。');
    const payload = await json(COURSE + '/webapps/calendar/calendarData/calendars?mode=personal&course_id=');
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.calendars) || payload.calendars.length > 500) {
      throw publicError('UNSUPPORTED', '教学网日历目录格式发生变化，尚未读取到完整课程列表。');
    }
    const byId = new Map();
    const excludedIds = new Set();
    let unknownCalendars = 0;
    for (const calendar of payload.calendars) {
      if (!calendar || typeof calendar.id !== 'string' || !calendar.id.trim() || calendar.id.length > 256 || /[\u0000-\u001f\u007f,]/.test(calendar.id)) {
        throw publicError('UNSUPPORTED', '教学网日历目录存在无法识别的记录，尚未读取到完整课程列表。');
      }
      const id = calendar.id.trim();
      if (['PERSONAL', 'INSTITUTION', 'ORGANIZATION'].includes(id.toUpperCase())) { excludedIds.add(id); continue; }
      if (calendar.calendarType && !/^course$/i.test(calendar.calendarType)) {
        if (/^(personal|institution|organization)$/i.test(calendar.calendarType)) excludedIds.add(id);
        else unknownCalendars++;
        continue;
      }
      byId.set(id, calendar);
    }
    const start = now() - 30 * DAY;
    const end = now() + 180 * DAY;
    const batches = [];
    let batch = [];
    let length = 0;
    for (const id of byId.keys()) {
      const size = encodeURIComponent(id).length + 3;
      if (batch.length && length + size > 1600) { batches.push(batch); batch = []; length = 0; }
      batch.push(id); length += size;
    }
    if (batch.length) batches.push(batch);
    const items = new Map();
    let unknownDates = 0;
    let unknownItems = 0;
    let unknownTypes = 0;
    let seenRows = 0;
    for (let from = start; from < end;) {
      const month = new Date(from + 8 * 3600000);
      const nextMonth = Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1) - 8 * 3600000;
      const to = Math.min(end, nextMonth);
      for (const ids of batches) {
        const url = new URL(COURSE + '/webapps/calendar/calendarData/events');
        url.search = new URLSearchParams({ start: String(from), end: String(to), course_id: '', calendarIds: ids.join(',') }).toString();
        const events = await json(url);
        if (!Array.isArray(events) || events.length > 10000 || (seenRows += events.length) > 50000) {
          throw publicError('UNSUPPORTED', '教学网日历事件格式或数量超出当前适配范围，请保留现有任务。');
        }
        for (const event of events) {
          if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.eventType !== 'string' || typeof event.calendarId !== 'string') {
            throw publicError('UNSUPPORTED', '教学网日历事件缺少可识别的类型或课程信息，请保留现有任务。');
          }
          if (excludedIds.has(event.calendarId) || ['PERSONAL', 'INSTITUTION', 'ORGANIZATION'].includes(event.calendarId.toUpperCase())) continue;
          if (!byId.has(event.calendarId)) { unknownItems++; continue; }
          // Blackboard Assignment events represent assignment due dates. A
          // meeting/test/course event is never guessed to be a movable task.
          if (event.eventType.toLowerCase() !== 'assignment') {
            if (!/^(personal|institution|organization|course|event|calendarevent|test|survey|meeting|officehours)$/i.test(event.eventType)) unknownTypes++;
            continue;
          }
          const rawStable = event.itemSourceId || event.id;
          const stable = typeof rawStable === 'string' && rawStable.length <= 256 ? cleanText(rawStable, 256) : '';
          const title = cleanText(event.title, 200);
          if (!stable || !title) { unknownItems++; continue; }
          const rawDue = event.dueDate == null ? (event.end == null ? event.endDate : event.end) : event.dueDate;
          const date = parseDate(rawDue);
          if (!date || (event.allDay === true && !/^\d{4}-\d{2}-\d{2}$/.test(rawDue))) { unknownDates++; continue; }
          if (date.epoch < start || date.epoch > end) continue;
          const calendar = byId.get(event.calendarId);
          const course = cleanText(event.calendarName, 200) ||
            cleanText(event.calendarNameLocalizable && event.calendarNameLocalizable.rawValue, 200) ||
            cleanText(calendar.name || calendar.title, 200) || '教学网课程';
          const sourceId = crypto.createHash('sha256').update(username + '\0' + event.calendarId + '\0' + stable).digest('hex');
          items.set(sourceId, { sourceId, title, course, due: date.due, sourceUrl: CALENDAR });
          if (items.size > 5000) throw publicError('UPSTREAM', '教学网作业数量超出单次同步范围。');
        }
      }
      from = to;
    }
    const warnings = [];
    if (unknownDates) warnings.push('有作业的截止时间或时区不明确，已跳过；请在教学网核对。');
    if (unknownItems) warnings.push('有作业的课程、稳定编号或标题无法识别，已跳过；请在教学网核对。');
    if (unknownCalendars || unknownTypes) warnings.push('教学网返回了尚未适配的日历类型，部分截止时间需在教学网核对。');
    if ((unknownDates || unknownItems || unknownCalendars || unknownTypes) && !items.size) throw publicError('UNSUPPORTED', '教学网作业数据尚无法准确解析，现有任务保持不变。');
    if (!byId.size) warnings.push('教学网未返回可读取的课程日历。');
    return { items: [...items.values()].sort((a, b) => a.due.localeCompare(b.due) || a.sourceId.localeCompare(b.sourceId)), warnings };
  }

  function close() {
    closed = true;
    for (const controller of requests) controller.abort();
    requests.clear();
    cookies.length = 0;
    preparedFor = authenticatedFor = publicKey = null;
    challenge = { mode: 'none', captchaRequired: false };
  }

  return { prepare, sendSms, login, readDeadlines, close };
}

module.exports = { createClient };
