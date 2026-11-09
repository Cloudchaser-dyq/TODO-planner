'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../dist/data.js');
const K = require('../dist/pku.js');
function item(extra = {}) { return { sourceId: 'a'.repeat(64), title: '课程作业', course: '示例课程', due: '2026-11-12T23:59', sourceUrl: 'https://course.pku.edu.cn/webapps/calendar/viewMyCalendar', ...extra }; }
function state(extra = {}) { return D.validateState({ ...D.emptyState('2026-11-09'), ...extra }).value; }
function task(extra = {}) { return { id: 'manual-task', title: '课程作业', category: '课业', kind: 'task', progress: 30, target: 70, totalMinutes: 120, importance: 5, enjoyment: 1, due: '2026-11-11', nextAction: '先完成前半部分', flagged: true, ...extra }; }
function jsonResponse(value, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) }; }

test('PKU imports start at 0/100, use stable opaque sources and update only the DDL', () => {
  const base = state(), plan = K.createPlan(base, [item()]); assert.equal(plan.ok, true);
  const first = K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: null }]); assert.equal(first.ok, true);
  const created = first.value.tasks[0];
  assert.deepEqual([created.progress, created.target, created.totalMinutes, created.importance, created.enjoyment], [0, 100, null, null, null]);
  assert.equal(created.sourceGroup, 'pku:' + item().sourceId); assert.equal(created.title, '【示例课程】课程作业');
  const changed = state({ tasks: [{ ...created, progress: 40, target: 60, totalMinutes: 180, importance: 4, enjoyment: 2, nextAction: '自己的备注', title: '自己改的任务名' }] });
  const repeated = K.createPlan(changed, [item()]); assert.equal(repeated.rows[0].type, 'unchanged');
  const moved = K.createPlan(changed, [item({ due: '2026-11-15T12:00', title: '远端改名' })]); assert.equal(moved.rows[0].type, 'update');
  const saved = K.applyPlan(changed, moved, [{ sourceId: item().sourceId, targetId: created.id }]); assert.equal(saved.ok, true);
  assert.equal(saved.value.tasks.length, 1);
  assert.deepEqual(saved.value.tasks[0], { ...changed.tasks[0], due: '2026-11-15T12:00' });
  assert.equal(JSON.stringify(base.tasks), '[]');
});

test('same-name manual tasks need explicit linking and preserve task IDs and work records', () => {
  const base = state({ tasks: [task()] }), plan = K.createPlan(base, [item()]);
  assert.equal(plan.rows[0].taskId, ''); assert.deepEqual(plan.rows[0].candidates.map(candidate => candidate.id), ['manual-task']);
  const linked = K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: 'manual-task' }]);
  assert.equal(linked.ok, true); assert.equal(linked.added, 0); assert.equal(linked.linked, 1);
  assert.deepEqual(linked.value.tasks[0], { ...base.tasks[0], due: item().due, duePrecision: 'time', sourceGroup: 'pku:' + item().sourceId });
  const separately = K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: null }]);
  assert.equal(separately.ok, true); assert.equal(separately.value.tasks.length, 2);
  assert.equal(K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: 'unrelated' }]).ok, false);
});

test('sync rejects stale plans, conflicting links, malformed remote sources and invalid dates atomically', () => {
  const base = state({ tasks: [task()] }), items = [item(), item({ sourceId: 'b'.repeat(64) })], plan = K.createPlan(base, items);
  const snapshot = JSON.stringify(base);
  assert.equal(K.applyPlan(base, plan, items.map(value => ({ sourceId: value.sourceId, targetId: 'manual-task' }))).ok, false);
  assert.equal(JSON.stringify(base), snapshot);
  const updated = state({ tasks: [task({ progress: 50 })] });
  assert.equal(K.applyPlan(updated, plan, [{ sourceId: item().sourceId, targetId: null }]).ok, false);
  for (const invalid of [item({ due: '2026-02-30T12:00' }), item({ sourceUrl: 'https://course.pku.edu.cn.evil.example/a' }), item({ sourceUrl: 'https://course.pku.edu.cn/\\evil' }), item({ sourceId: 123 }), item({ sourceId: '__proto__', title: '' })]) assert.equal(K.createPlan(base, [invalid]).ok, false);
  assert.equal(K.createPlan(base, [item(), item()]).ok, false);
  assert.equal(K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: null }, { sourceId: item().sourceId, targetId: null }]).ok, false);
});

test('account-scoped source IDs prevent another account from updating a previous account task', () => {
  const first = K.applyPlan(state(), K.createPlan(state(), [item()]), [{ sourceId: item().sourceId, targetId: null }]);
  const other = item({ sourceId: 'b'.repeat(64), due: '2026-11-16T12:00' }), plan = K.createPlan(first.value, [other]);
  assert.equal(plan.rows[0].type, 'create'); assert.deepEqual(plan.rows[0].candidates, []);
  const result = K.applyPlan(first.value, plan, [{ sourceId: other.sourceId, targetId: null }]);
  assert.equal(result.value.tasks.length, 2); assert.equal(result.value.tasks[0].due, item().due);
});

test('date-only deadlines retain their precision without inventing a submission time', () => {
  const remote = item({ due: '2026-11-12' }), base = state(), plan = K.createPlan(base, [remote]);
  assert.equal(plan.ok, true);
  const result = K.applyPlan(base, plan, [{ sourceId: remote.sourceId, targetId: null }]);
  assert.equal(result.ok, true); assert.equal(result.value.tasks[0].due, '2026-11-12'); assert.equal(result.value.tasks[0].duePrecision, 'date');
});

test('only whitelisted item fields enter task state and unknown remote omissions never delete local tasks', () => {
  const base = state({ tasks: [task()] });
  const plan = K.createPlan(base, [item({ password: 'remote-private-password', cookie: 'remote-private-cookie' })]);
  const result = K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: null }]);
  assert.doesNotMatch(JSON.stringify(result.value), /remote-private|password|cookie/);
  const none = K.applyPlan(result.value, K.createPlan(result.value, []), []);
  assert.equal(none.ok, true); assert.deepEqual(none.value.tasks, result.value.tasks);
});

test('local requests require a pairing code, fixed loopback destination and omit browser cookies', async () => {
  let calls = 0, captured;
  const fetchImpl = async (url, options) => { calls++; captured = { url, options }; return jsonResponse({ items: [item()], warnings: [] }); };
  const key = 'p'.repeat(64), body = { username: 'test-user', password: 'private-password', remember: true };
  await K.request({ key, path: '/api/pku/sync', method: 'POST', body, fetchImpl });
  assert.equal(captured.url, 'http://127.0.0.1:4174/api/pku/sync');
  assert.equal(captured.options.headers.Authorization, 'Bearer ' + key);
  assert.equal(captured.options.credentials, 'omit'); assert.equal(captured.options.redirect, 'error');
  assert.deepEqual(JSON.parse(captured.options.body), body);
  assert.doesNotMatch(captured.url, /private-password|test-user/);
  await assert.rejects(K.request({ key: '', path: '/api/pku/status', fetchImpl }), /配对码/);
  await assert.rejects(K.request({ key, path: '/api/ai', fetchImpl }), /无效/); assert.equal(calls, 1);
});

test('authentication challenges carry only validated verification UI data and errors hide credentials', async () => {
  const key = 'p'.repeat(64), body = { username: 'test-user', password: 'private-password' };
  await assert.rejects(K.request({ key, path: '/api/pku/sync', method: 'POST', body,
    fetchImpl: async () => jsonResponse({ error: 'verify private-password ' + key, challenge: { captchaRequired: true, mode: 'sms', captchaImage: 'data:image/png;base64,YQ==' } }, 409) }), error => {
    assert.equal(error.status, 409); assert.deepEqual(error.challenge, { captchaRequired: true, mode: 'sms', captchaImage: 'data:image/png;base64,YQ==' });
    assert.doesNotMatch(error.message, /private-password|pppp/); return true;
  });
  assert.equal(K.normalizeChallenge({ captchaRequired: true, mode: 'evil' }), null);
  assert.deepEqual(K.normalizeChallenge({ captchaRequired: true, mode: 'otp', captchaImage: 'data:image/svg+xml;base64,AAAA' }), { captchaRequired: true, mode: 'otp' });
  await assert.rejects(K.request({ key, path: '/api/pku/status', fetchImpl: async () => ({ ok: true, text: async () => '<html>login</html>' }) }), /响应无效/);
});
