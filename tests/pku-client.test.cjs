'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createClient } = require('../pku-client.cjs');

const NOW = Date.parse('2026-11-09T04:00:00Z');
const USER = 'demo-student';
const PASSWORD = 'test-password-only';
const COURSE = 'https://course.pku.edu.cn';
const IAAA = 'https://iaaa.pku.edu.cn';
const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const assignment = {
  id: 'fake-calendar-event-1', itemSourceId: '_100_1', calendarId: 'DEMO.COURSE',
  eventType: 'Assignment', title: '演示作业', calendarName: '演示课程',
  start: '2026-11-09T00:00:00Z', end: '2026-11-10T15:59:00Z', allDay: false
};

function json(data, headers = {}) {
  return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', ...headers } });
}
function html(text = '<html><h1>日历</h1></html>', headers = {}) {
  return new Response(text, { headers: { 'Content-Type': 'text/html', ...headers } });
}
function fixture(options = {}) {
  const calls = [];
  const fetchImpl = async (value, init) => {
    const url = new URL(value);
    const call = { url, ...init };
    calls.push(call);
    if (options.intercept) {
      const response = await options.intercept(call, calls);
      if (response) return response;
    }
    if (url.origin === COURSE && url.pathname === '/webapps/login/') return html('<form name="login"></form>');
    if (url.origin === IAAA && url.pathname === '/iaaa/oauth.jsp') return html('<form id="user_name"></form>', { 'Set-Cookie': 'IAAA_TEST=secret; Secure; Path=/iaaa; HttpOnly' });
    if (url.pathname === '/iaaa/getPublicKey.do') return json({ success: true, key: publicKey });
    if (url.pathname === '/iaaa/isShowCode.do') return json({ success: !!options.captcha });
    if (url.pathname === '/iaaa/isMobileAuthen.do') return json({ success: true, isMobileAuthen: !!options.mode,
      authenMode: options.mode || '否', isBind: true, isUnuAuth: false });
    if (url.pathname === '/iaaa/servlet/DrawServlet') return new Response(Buffer.from('fake-png'), { headers: { 'Content-Type': 'image/png' } });
    if (url.pathname === '/iaaa/sendSMSCode.do') return json({ success: true });
    if (url.pathname === '/iaaa/oauthlogin.do') return json(options.loginResult || { success: true, token: 'fake-token-never-a-real-account' });
    if (url.pathname.endsWith('/campusLogin')) return html('<html>登录成功</html>', { 'Set-Cookie': 'BB_TEST=bb-secret; Secure; Path=/webapps; HttpOnly' });
    if (url.pathname === '/webapps/calendar/viewPersonal') return html();
    if (url.pathname === '/webapps/calendar/calendarData/calendars') return json(options.calendars || { calendars: [
      { id: 'PERSONAL' }, { id: 'INSTITUTION' }, { id: 'DEMO.COURSE', name: '演示课程', selected: false }
    ] });
    if (url.pathname === '/webapps/calendar/calendarData/events') return json(options.events || [assignment]);
    throw new Error('unhandled mock request containing secret ' + PASSWORD);
  };
  const client = createClient({ fetchImpl, now: () => NOW, ...(options.clientOptions || {}) });
  return { client, calls };
}
async function loggedIn(options) {
  const f = fixture(options);
  await f.client.login({ username: USER, password: PASSWORD, verification: { captcha: 'ABCD', sms: '123456', otp: '654321' } });
  return f;
}
function safeFailure(code) {
  return error => error.code === code && error.message === error.publicMessage &&
    ![PASSWORD, USER, 'fake-token', 'bb-secret', 'IAAA_TEST'].some(secret => error.message.includes(secret));
}

test('PKU login preserves the registered callback identifier and exchanges tokens only over HTTPS', async () => {
  const { client, calls } = await loggedIn();
  const login = calls.find(c => c.url.pathname === '/iaaa/oauthlogin.do');
  const form = new URLSearchParams(login.body);
  assert.equal(form.get('appid'), 'blackboard');
  assert.equal(form.get('userName'), USER);
  const registeredCallback = 'http://course.pku.edu.cn/webapps/bb-sso-BBLEARN/execute/authValidate/campusLogin';
  assert.equal(form.get('redirUrl'), registeredCallback);
  const entry = calls.find(c => c.url.pathname === '/iaaa/oauth.jsp');
  assert.equal(entry.url.searchParams.get('redirectUrl'), registeredCallback);
  assert.equal(login.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(login.headers.Referer, entry.url.href);
  assert.ok(calls.every(c => c.url.protocol === 'https:'));
  assert.ok(calls.filter(c => c.url.origin === IAAA && c.url.pathname.endsWith('.do')).every(c => c.headers['X-Requested-With'] === 'XMLHttpRequest'));
  assert.equal(form.get('remTrustChk'), 'false');
  assert.ok(!login.body.includes(PASSWORD));
  // RSA_NO_PADDING lets the test inspect PKCS#1 v1.5 encoding on runtimes that
  // disable legacy privateDecrypt padding. No key or credential is persisted.
  const encoded = crypto.privateDecrypt({ key: keys.privateKey, padding: crypto.constants.RSA_NO_PADDING }, Buffer.from(form.get('password'), 'base64'));
  assert.equal(encoded[0], 0); assert.equal(encoded[1], 2);
  const separator = encoded.indexOf(0, 2);
  assert.ok(separator >= 10);
  assert.equal(encoded.subarray(separator + 1).toString(), PASSWORD);
  assert.ok(login.headers.Cookie.includes('IAAA_TEST=secret'));
  const callback = calls.find(c => c.url.pathname.endsWith('/campusLogin'));
  assert.equal(callback.url.protocol, 'https:');
  assert.ok(!(callback.headers.Cookie || '').includes('IAAA_TEST'));
  assert.equal(callback.body, undefined);
  client.close();
});

test('prepare returns captcha/OTP requirements and does not submit credentials or send SMS', async () => {
  const { client, calls } = fixture({ captcha: true, mode: 'OTP' });
  const challenge = await client.prepare(USER);
  assert.equal(challenge.mode, 'otp');
  assert.equal(challenge.captchaRequired, true);
  assert.match(challenge.captchaImage, /^data:image\/png;base64,/);
  assert.ok(!calls.some(c => /oauthlogin|sendSMS/.test(c.url.pathname)));
  await assert.rejects(client.login({ username: USER, password: PASSWORD }), error =>
    safeFailure('CHALLENGE')(error) && error.challenge.mode === 'otp' && error.challenge.captchaRequired);
  assert.ok(!calls.some(c => c.url.pathname === '/iaaa/oauthlogin.do'));
  client.close();
});

test('SMS sending is explicit and submitted SMS/OTP/captcha fields match official names', async () => {
  const { client, calls } = fixture({ mode: 'SMS' });
  await client.prepare(USER);
  assert.ok(!calls.some(c => c.url.pathname.includes('sendSMS')));
  await client.sendSms(USER);
  const smsCall = calls.find(c => c.url.pathname.includes('sendSMS'));
  assert.equal(smsCall.url.searchParams.get('appId'), 'blackboard');
  await client.login({ username: USER, password: PASSWORD, verification: { sms: '123456' } });
  const form = new URLSearchParams(calls.find(c => c.url.pathname === '/iaaa/oauthlogin.do').body);
  assert.equal(form.get('smsCode'), '123456'); assert.equal(form.get('randCode'), '');
  client.close();
});

test('expired verification responses refresh the challenge without exposing upstream messages', async () => {
  for (const code of ['E03', 'E04', 'E05']) {
    const { client } = fixture({ loginResult: { success: false, showCode: code === 'E03', errors: { code, msg: PASSWORD + USER } } });
    await assert.rejects(client.login({ username: USER, password: PASSWORD }), error => {
      assert.ok(safeFailure('CHALLENGE')(error));
      assert.equal(error.challenge.mode, code === 'E04' ? 'sms' : code === 'E05' ? 'otp' : 'none');
      assert.equal(error.challenge.captchaRequired, code === 'E03');
      return true;
    });
    client.close();
  }
});

test('authentication failures and invalid key responses return fixed, secret-free errors', async () => {
  const badLogin = fixture({ loginResult: { success: false, errors: { code: 'E01', msg: PASSWORD + USER } } });
  await assert.rejects(badLogin.client.login({ username: USER, password: PASSWORD }), safeFailure('AUTH_FAILED'));
  badLogin.client.close();
  const badKey = fixture({ intercept: c => c.url.pathname === '/iaaa/getPublicKey.do' ? json({ success: true, key: 'invalid-' + PASSWORD }) : null });
  await assert.rejects(badKey.client.prepare(USER), safeFailure('UNSUPPORTED'));
  assert.ok(!badKey.calls.some(c => c.url.pathname.includes('oauthlogin')));
  badKey.client.close();
});

test('login diagnostics expose only bounded error codes and fixed account-state guidance', async () => {
  for (const [result, expected] of [
    [{ success: false, errors: { code: 'E01', msg: PASSWORD + USER } }, /E01/],
    [{ success: false, errors: { code: 'E21', msg: '账号锁定 ' + USER + PASSWORD }, showCode: true }, /暂时限制登录（E21）/],
    [{ success: false, errors: { code: 'E09', msg: USER + PASSWORD } }, /E09/],
    [{ success: false, errors: { code: USER, msg: PASSWORD } }, /未提供标准错误码/],
    [{ success: false, isFlag: true, errors: { code: 'E08', msg: PASSWORD } }, /密码安全状态（E08）/]
  ]) {
    const { client } = fixture({ loginResult: result });
    await assert.rejects(client.login({ username: USER, password: PASSWORD }), error => {
      assert.ok(safeFailure('AUTH_FAILED')(error)); assert.match(error.publicMessage, expected); return true;
    });
    client.close();
  }
});

test('calendar schema diagnostics describe types without reporting account, titles, IDs or date values', async () => {
  for (const options of [
    { events: [{ ...assignment, end: PASSWORD, title: USER }] },
    { events: [{ ...assignment, eventType: 'GradebookColumn', title: PASSWORD }] },
    { events: [{ ...assignment, eventType: 'PrivateAccount' }] },
    { events: [{ ...assignment, eventType: '虚构私人内容' }] },
    { calendars: { calendars: [{ id: USER, calendarType: PASSWORD }] } },
    { events: [{ ...assignment, calendarId: USER, title: PASSWORD }] }
  ]) {
    const { client } = await loggedIn(options);
    await assert.rejects(client.readDeadlines(USER), error => {
      assert.ok(safeFailure('UNSUPPORTED')(error)); assert.match(error.publicMessage, /格式诊断/);
      assert.doesNotMatch(error.publicMessage, /fake-calendar-event|2026-11|PrivateAccount|虚构私人内容/); return true;
    });
    client.close();
  }
});

test('PKU localized 作业 entries are imported just like Assignment and other localized calendar entries stay excluded', async () => {
  const { client } = await loggedIn({ events: [
    { ...assignment, eventType: '作业' },
    { ...assignment, id: 'demo-test', itemSourceId: '_200_1', eventType: '测试' },
    { ...assignment, id: 'demo-event', itemSourceId: '_300_1', eventType: '事件' }
  ] });
  const result = await client.readDeadlines(USER);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, '演示作业');
  assert.equal(result.items[0].due, '2026-11-10T23:59');
  assert.deepEqual(result.warnings, []);
  client.close();
});

test('deadline reads require the same authenticated account', async () => {
  const { client } = fixture();
  await assert.rejects(client.readDeadlines(USER), safeFailure('AUTH_FAILED'));
  await client.login({ username: USER, password: PASSWORD });
  await assert.rejects(client.readDeadlines('other-demo-account'), safeFailure('AUTH_FAILED'));
  client.close();
});

test('all course calendars are queried explicitly in bounded monthly windows, including unchecked calendars', async () => {
  const { client, calls } = await loggedIn({ calendars: { calendars: [
    { id: 'PERSONAL' }, { id: 'INSTITUTION' }, { id: 'DEMO.COURSE', selected: false }, { id: 'SECOND.COURSE', selected: true }
  ] } });
  const result = await client.readDeadlines(USER);
  assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['course', 'due', 'sourceId', 'sourceUrl', 'title']);
  assert.equal(result.items[0].due, '2026-11-10T23:59');
  assert.match(result.items[0].sourceId, /^[a-f\d]{64}$/);
  assert.equal(result.items[0].sourceUrl, COURSE + '/webapps/calendar/viewPersonal');
  const eventCalls = calls.filter(c => c.url.pathname.endsWith('/events'));
  assert.ok(eventCalls.length >= 7 && eventCalls.length <= 8);
  let previousEnd = NOW - 30 * 86400000;
  for (const c of eventCalls) {
    assert.equal(+c.url.searchParams.get('start'), previousEnd);
    previousEnd = +c.url.searchParams.get('end');
    assert.ok(previousEnd - +c.url.searchParams.get('start') <= 31 * 86400000);
    assert.equal(c.url.searchParams.get('calendarIds'), 'DEMO.COURSE,SECOND.COURSE');
    assert.ok(!c.url.href.includes('selectedCalendarEvents'));
    assert.ok(c.headers.Cookie.includes('BB_TEST=bb-secret'));
    assert.ok(!c.headers.Cookie.includes('IAAA_TEST'));
  }
  assert.equal(previousEnd, NOW + 180 * 86400000);
  client.close();
});

test('date-only precision is preserved and millisecond epochs are converted to Beijing time', async () => {
  const { client } = await loggedIn({ events: [
    { ...assignment, id: 'a', itemSourceId: 'a', end: '2026-11-10', allDay: true },
    { ...assignment, id: 'b', itemSourceId: 'b', end: Date.parse('2026-11-11T16:30:00Z') }
  ] });
  const { items } = await client.readDeadlines(USER);
  assert.deepEqual(items.map(i => i.due).sort(), ['2026-11-10', '2026-11-12T00:30']);
  client.close();
});

test('the alternative Blackboard endDate/localized course fields are read without inventing dates', async () => {
  const event = { ...assignment, calendarName: undefined, end: undefined, endDate: '2026-11-10T18:00:00+08:00', calendarNameLocalizable: { rawValue: '本地化课程' } };
  const { client } = await loggedIn({ events: [event] });
  const { items } = await client.readDeadlines(USER);
  assert.equal(items[0].course, '本地化课程');
  assert.equal(items[0].due, '2026-11-10T18:00');
  client.close();
});

test('source IDs remain stable after DDL/title changes and differ between accounts', async () => {
  let changed = false;
  const { client } = await loggedIn({ intercept: c => c.url.pathname.endsWith('/events') ? json([{ ...assignment,
    ...(changed ? { title: '修改后的作业', end: '2026-11-12T15:59:00Z' } : {}) }]) : null });
  const first = (await client.readDeadlines(USER)).items[0];
  changed = true;
  const second = (await client.readDeadlines(USER)).items[0];
  assert.equal(first.sourceId, second.sourceId);
  assert.notEqual(first.due, second.due);
  await client.login({ username: 'another-demo', password: PASSWORD });
  const other = (await client.readDeadlines('another-demo')).items[0];
  assert.notEqual(other.sourceId, first.sourceId);
  client.close();
});

test('personal events, meetings and tests are excluded from movable tasks', async () => {
  const { client } = await loggedIn({ events: [
    assignment, { ...assignment, id: 'b', itemSourceId: 'b', eventType: 'Test' },
    { ...assignment, id: 'c', itemSourceId: 'c', eventType: 'Course' },
    { ...assignment, id: 'd', itemSourceId: 'd', calendarId: 'PERSONAL' }
  ] });
  const { items } = await client.readDeadlines(USER);
  assert.equal(items.length, 1); assert.equal(items[0].title, assignment.title);
  client.close();
});

test('invalid dates and ambiguous all-day ends cannot produce a false empty success', async () => {
  for (const event of [
    { ...assignment, end: '2026-02-30T15:59:00Z' },
    { ...assignment, end: '2026-11-10T23:59:00+25:00' },
    { ...assignment, allDay: true },
    { ...assignment, end: 1794326340 },
    { ...assignment, itemSourceId: '', id: '' }
  ]) {
    const { client } = await loggedIn({ events: [event] });
    await assert.rejects(client.readDeadlines(USER), safeFailure('UNSUPPORTED'));
    client.close();
  }
});

test('floating calendar times preserve Beijing wall time with a visible review notice', async () => {
  const { client } = await loggedIn({ events: [
    { ...assignment, id: 'demo-floating', itemSourceId: 'demo-floating', eventType: '作业', end: '2026-11-10T23:59:00.000' },
    { ...assignment, id: 'demo-space', itemSourceId: 'demo-space', end: '2026-11-11 18:30:00' },
    { ...assignment, id: 'demo-canonical', itemSourceId: 'demo-canonical', end: '2026-11-12T07:00:00', endDate: '2026-11-12T15:00:00+0800' }
  ] });
  const result = await client.readDeadlines(USER);
  assert.deepEqual(result.items.map(item => item.due), ['2026-11-10T23:59', '2026-11-11T18:30', '2026-11-12T15:00']);
  assert.equal(result.warnings.length, 1); assert.match(result.warnings[0], /未注明时区.*北京时间.*核对/);
  client.close();
});

test('unknown calendar/event JSON shapes fail instead of being accepted as no deadlines', async () => {
  for (const options of [
    { calendars: {} }, { calendars: { calendars: [{}] } }, { events: {} },
    { events: [{ title: 'unknown profile', calendarId: 'DEMO.COURSE' }] },
    { calendars: { calendars: [{ id: 'DEMO.COURSE', calendarType: 'NewCourseProfile' }] } },
    { events: [{ ...assignment, eventType: 'GradableItem' }] },
    { events: [{ ...assignment, calendarId: 'UNKNOWN.COURSE' }] }
  ]) {
    const { client } = await loggedIn(options);
    await assert.rejects(client.readDeadlines(USER), safeFailure('UNSUPPORTED'));
    client.close();
  }
});

test('a valid empty events array succeeds, while the backend never mutates the remote calendar', async () => {
  const { client, calls } = await loggedIn({ events: [] });
  assert.deepEqual(await client.readDeadlines(USER), { items: [], warnings: [] });
  assert.ok(calls.filter(c => c.url.origin === COURSE).every(c => c.method === 'GET'));
  client.close();
});

test('cookies obey domain, path, expiry and host boundaries', async () => {
  const { client, calls } = await loggedIn({ intercept: c => {
    if (c.url.pathname === '/iaaa/getPublicKey.do') {
      const headers = new Headers({ 'Content-Type': 'application/json' });
      headers.append('Set-Cookie', 'wrongPath=no; Secure; Path=/other');
      headers.append('Set-Cookie', 'expired=no; Max-Age=0; Path=/');
      headers.append('Set-Cookie', 'badDomain=no; Domain=evil.example; Path=/');
      headers.append('Set-Cookie', 'suffix=no; Domain=edu.cn; Path=/');
      headers.append('Set-Cookie', 'rightPath=yes; Secure; Path=/iaaa');
      return new Response(JSON.stringify({ success: true, key: publicKey }), { headers });
    }
    return null;
  } });
  const auth = calls.find(c => c.url.pathname === '/iaaa/oauthlogin.do');
  assert.ok(auth.headers.Cookie.includes('rightPath=yes'));
  for (const name of ['wrongPath', 'expired', 'badDomain', 'suffix']) assert.ok(!auth.headers.Cookie.includes(name));
  const calendar = calls.find(c => c.url.pathname === '/webapps/calendar/viewPersonal');
  assert.ok(!calendar.headers.Cookie.includes('rightPath'));
  client.close();
});

test('external hosts, nondefault ports and credential-bearing redirects are rejected before any fetch', async () => {
  for (const target of ['http://course.pku.edu.cn:8080/unsafe', 'https://evil.example/exfiltrate', 'https://127.0.0.1/admin', 'https://user:pass@course.pku.edu.cn/']) {
    const { client, calls } = fixture({ intercept: c => c.url.pathname === '/webapps/login/' ? new Response(null, { status: 302, headers: { Location: target } }) : null });
    await assert.rejects(client.prepare(USER), safeFailure('UPSTREAM'));
    assert.equal(calls.length, 1);
    client.close();
  }
});

test('official legacy HTTP SSO redirects are upgraded before the request is sent', async () => {
  const { client, calls } = fixture({ intercept: c => {
    if (c.url.pathname.endsWith('/campusLogin')) return html("<script>document.location.replace('http://course.pku.edu.cn/webapps/portal/legacy');</script>");
    if (c.url.pathname === '/webapps/portal/legacy') return html();
    return null;
  } });
  await client.login({ username: USER, password: PASSWORD });
  assert.ok(calls.some(c => c.url.pathname === '/webapps/portal/legacy'));
  assert.ok(calls.every(c => c.url.protocol === 'https:'));
  client.close();
});

test('partially unrecognized calendars or event types produce a visible warning', async () => {
  const { client } = await loggedIn({ events: [assignment, { ...assignment, eventType: 'NewGradeColumn' }] });
  const result = await client.readDeadlines(USER);
  assert.equal(result.items.length, 1);
  assert.ok(result.warnings.some(w => w.includes('尚未适配')));
  client.close();
});

test('a cross-origin 307 cannot replay the encrypted password body', async () => {
  const { client, calls } = fixture({ intercept: c => c.url.pathname === '/iaaa/oauthlogin.do' ?
    new Response(null, { status: 307, headers: { Location: COURSE + '/replay' } }) : null });
  await assert.rejects(client.login({ username: USER, password: PASSWORD }), safeFailure('UPSTREAM'));
  assert.ok(!calls.some(c => c.url.pathname === '/replay'));
  client.close();
});

test('safe HTTP redirects switch a POST to GET without forwarding the password', async () => {
  const { client, calls } = fixture({ intercept: c => {
    if (c.url.pathname === '/iaaa/oauthlogin.do') return new Response(null, { status: 303, headers: { Location: IAAA + '/iaaa/mock-result' } });
    if (c.url.pathname === '/iaaa/mock-result') return json({ success: true, token: 'fake-token' });
    return null;
  } });
  await client.login({ username: USER, password: PASSWORD });
  const redirected = calls.find(c => c.url.pathname === '/iaaa/mock-result');
  assert.equal(redirected.method, 'GET'); assert.equal(redirected.body, undefined);
  client.close();
});

test('hex-escaped SSO redirects are decoded without evaluating scripts, and unsafe ones are rejected', async () => {
  const good = fixture({ intercept: c => {
    if (c.url.pathname.endsWith('/campusLogin')) return html("<script>document.location.replace('https\\x3A\\x2F\\x2Fcourse.pku.edu.cn\\x2Fwebapps\\x2Fportal\\x2Fhome');</script>");
    if (c.url.pathname === '/webapps/portal/home') return html();
    return null;
  } });
  await good.client.login({ username: USER, password: PASSWORD });
  assert.ok(good.calls.some(c => c.url.pathname === '/webapps/portal/home'));
  good.client.close();
  const bad = fixture({ intercept: c => c.url.pathname.endsWith('/campusLogin') ?
    html("<script>document.location.replace('https\\x3A\\x2F\\x2Fevil.example/exfiltrate');</script>") : null });
  await assert.rejects(bad.client.login({ username: USER, password: PASSWORD }), safeFailure('UPSTREAM'));
  assert.ok(!bad.calls.some(c => c.url.hostname === 'evil.example'));
  bad.client.close();
});

test('response lengths, MIME types and upstream login pages are checked', async () => {
  const huge = fixture({ intercept: c => c.url.pathname === '/iaaa/getPublicKey.do' ?
    new Response('small', { headers: { 'Content-Length': '99999999' } }) : null });
  await assert.rejects(huge.client.prepare(USER), safeFailure('UPSTREAM'));
  huge.client.close();
  const svg = fixture({ captcha: true, intercept: c => c.url.pathname.includes('DrawServlet') ?
    new Response('<svg onload="alert(1)"></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }) : null });
  await assert.rejects(svg.client.prepare(USER), safeFailure('UPSTREAM'));
  svg.client.close();
  const expired = fixture({ intercept: c => c.url.pathname === '/webapps/calendar/viewPersonal' ? html('<input id="user_id">') : null });
  await assert.rejects(expired.client.login({ username: USER, password: PASSWORD }), safeFailure('AUTH_FAILED'));
  expired.client.close();
});

test('network failures and timeouts do not expose request URLs or credential details', async () => {
  const leaking = createClient({ fetchImpl: async () => { throw new Error(PASSWORD + USER); } });
  await assert.rejects(leaking.prepare(USER), safeFailure('UPSTREAM'));
  leaking.close();
  const slow = createClient({ timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error(PASSWORD)))) });
  await assert.rejects(slow.prepare(USER), safeFailure('UPSTREAM'));
  slow.close();
});

test('close aborts active requests and makes future operations fail without network access', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let abortSeen = false;
  let count = 0;
  const client = createClient({ fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    count++; started(); signal.addEventListener('abort', () => { abortSeen = true; reject(new Error(PASSWORD)); });
  }) });
  const pending = client.prepare(USER);
  await ready; client.close();
  await assert.rejects(pending, safeFailure('UPSTREAM'));
  assert.equal(abortSeen, true);
  await assert.rejects(client.prepare(USER), safeFailure('UPSTREAM'));
  assert.equal(count, 1);
});
