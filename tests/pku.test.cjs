'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../dist/data.js');
const K = require('../dist/pku.js');
function item(extra = {}) { return { sourceId: 'a'.repeat(64), title: '课程作业', course: '示例课程', due: '2026-11-12T23:59', sourceUrl: 'https://course.pku.edu.cn/webapps/calendar/viewMyCalendar', ...extra }; }
function state(extra = {}) { return D.validateState({ ...D.emptyState('2026-11-09'), ...extra }).value; }
function task(extra = {}) { return { id: 'manual-task', title: '课程作业', category: '课业', kind: 'task', progress: 30, target: 70, totalMinutes: 120, importance: 5, enjoyment: 1, due: '2026-11-11', nextAction: '先完成前半部分', flagged: true, ...extra }; }
function jsonResponse(value, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) }; }
function announcement(extra = {}) { return item({ sourceId: 'c'.repeat(64), title: '示例课程通知', course: 'DEMO', due: '', sourceKind: 'announcement', excerpt: 'preview-excerpt-only', dateNote: 'preview-date-note-only', sourceUrl: 'https://course.pku.edu.cn/webapps/blackboard/execute/announcement?method=search&context=course_entry&course_id=_DEMO_1', ...extra }); }

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

test('near-name candidates combine course, activity, sequence and DDL and expose the matching reason', () => {
  const base = state({ tasks: [task({ title: '🔴0408 ＤＥＭＯ：第３次课后作业', due: '2026-11-12', progress: 100 })] });
  const plan = K.createPlan(base, [item({ title: 'Homework 03', course: 'DEMO', due: '2026-11-12T23:59' })]);
  assert.equal(plan.ok, true); assert.equal(plan.rows[0].taskId, '');
  assert.equal(plan.rows[0].candidates.length, 1);
  const candidate = plan.rows[0].candidates[0];
  assert.equal(candidate.match, 'similar'); assert.match(candidate.reason, /课程.*编号一致/);
  assert.deepEqual([candidate.title, candidate.due, candidate.progress, candidate.done], ['🔴0408 ＤＥＭＯ：第３次课后作业', '2026-11-12', 100, true]);
  assert.equal(plan.baseTasks, JSON.stringify(base.tasks), 'a suggestion leaves current task data untouched');
  const datePrefix = K.createPlan(state({ tasks: [task({ title: '0408 示例专题研究论文', due: '2026-11-12' })] }), [item({ title: '示例专题研究论文', course: '', due: '2026-11-12' })]);
  assert.equal(datePrefix.rows[0].candidates.length, 1); assert.match(datePrefix.rows[0].candidates[0].reason, /日期前缀/);
});

test('generic task words, the same day or unconfirmed course aliases do not produce near-name candidates', () => {
  for (const local of ['另一门课的课后作业', '普通作业', '今天的事情']) {
    const plan = K.createPlan(state({ tasks: [task({ title: local, due: '2026-11-12' })] }), [item({ title: '作业', course: 'DEMO', due: '2026-11-12' })]);
    assert.deepEqual(plan.rows[0].candidates, [], local);
  }
  const alias = K.createPlan(state({ tasks: [task({ title: 'DEMO作业3', due: '2026-11-12' })] }), [item({ title: 'Homework 3', course: '示例系统原理', due: '2026-11-12' })]);
  assert.deepEqual(alias.rows[0].candidates, [], 'course abbreviation aliases are not guessed');
  const weekly = K.createPlan(state({ tasks: [task({ title: '0405 DEMO 作业', due: '2026-11-05' })] }), [item({ title: 'Homework', course: 'DEMO', due: '2026-11-12' })]);
  assert.deepEqual(weekly.rows[0].candidates, [], 'the same course and generic activity one week apart are separate');
});

test('near-name suggestions distinguish homework from LAB/exams and preserve multipart number boundaries', () => {
  for (const local of ['DEMO LAB3', 'DEMO小测3', 'DEMO期中考试3', 'DEMO作业13', 'DEMO作业31', 'DEMO作业3-1']) {
    const plan = K.createPlan(state({ tasks: [task({ title: local, due: '2026-11-12' })] }), [item({ title: 'Homework 3', course: 'DEMO', due: '2026-11-12' })]);
    assert.deepEqual(plan.rows[0].candidates, [], local);
  }
  const multipart = K.createPlan(state({ tasks: [task({ title: 'DEMO作业31', due: '2026-11-12' })] }), [item({ title: 'Homework 3-1', course: 'DEMO', due: '2026-11-12' })]);
  assert.deepEqual(multipart.rows[0].candidates, []);
  const matched = K.createPlan(state({ tasks: [task({ title: 'DEMO实验3-1', due: '2026-11-12' })] }), [item({ title: 'Lab 3-1', course: 'DEMO', due: '2026-11-12' })]);
  assert.equal(matched.rows[0].candidates.length, 1);
});

test('manual cross-name linking is available without suggestions and preserves completion, task IDs and work logs', () => {
  const existing = task({ title: '我自己写的另一种名称', progress: 100, due: '2026-11-11' });
  const log = { id: 'log-stable', taskId: existing.id, taskTitle: existing.title, date: '2026-11-09', at: '2026-11-09T03:00:00.000Z', minutes: 45, note: '自己的历史记录', fromProgress: 60, toProgress: 100, status: 'completed', startedAt: '', endedAt: '' };
  const base = state({ tasks: [existing, task({ id: 'already-linked', title: '另一项', sourceGroup: 'pku:' + 'b'.repeat(64) }), task({ id: 'fixed-event', title: '固定考试', kind: 'event' })], logs: [log] });
  const plan = K.createPlan(base, [item()]);
  assert.deepEqual(plan.rows[0].candidates, []); assert.deepEqual(plan.linkableTasks.map(entry => entry.id), [existing.id]);
  const linked = K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: existing.id }]);
  assert.equal(linked.ok, true); assert.equal(linked.value.tasks.length, base.tasks.length);
  assert.deepEqual(linked.value.tasks[0], { ...base.tasks[0], due: item().due, duePrecision: 'time', sourceGroup: 'pku:' + item().sourceId });
  assert.deepEqual(linked.value.logs, base.logs);
  assert.equal(K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: 'already-linked' }]).ok, false);
  assert.equal(K.applyPlan(base, plan, [{ sourceId: item().sourceId, targetId: 'fixed-event' }]).ok, false);
  const two = K.createPlan(base, [item(), item({ sourceId: 'c'.repeat(64) })]);
  assert.equal(K.applyPlan(base, two, two.rows.map(row => ({ sourceId: row.item.sourceId, targetId: existing.id }))).ok, false);
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

test('announcement items allow missing dates only for preview and accept only the read-only PKU announcement link', () => {
  const base = state(), plan = K.createPlan(base, [announcement()]);
  assert.equal(plan.ok, true); assert.equal(plan.rows[0].item.due, '');
  assert.equal(K.createPlan(base, [item({ due: '' })]).ok, false, 'calendar entries still need valid DDLs');
  assert.equal(K.applyPlan(base, plan, [{ sourceId: announcement().sourceId, targetId: null }]).ok, false);
  for (const sourceUrl of [
    'javascript:alert(1)',
    'https://course.pku.edu.cn/webapps/calendar/viewMyCalendar',
    'https://course.pku.edu.cn/webapps/blackboard/execute/announcement?method=delete&context=course_entry&course_id=_DEMO_1',
    announcement().sourceUrl + '&redirect=https%3A%2F%2Fevil.example',
    announcement().sourceUrl + '&method=delete',
    announcement().sourceUrl.replace('course.pku.edu.cn', 'course.pku.edu.cn.evil.example')
  ]) assert.equal(K.createPlan(base, [announcement({ sourceUrl })]).ok, false, sourceUrl);
  assert.equal(K.createPlan(base, [announcement({ excerpt: 'x'.repeat(1201) })]).ok, false);
  assert.equal(K.createPlan(base, [announcement({ dateNote: 'x'.repeat(201) })]).ok, false);
  assert.equal(K.createPlan(base, [item({ sourceKind: 'unrecognized' })]).ok, false);
});

test('announcement confirmation can revise title and date, recompute suggestions and keep raw source text outside saved tasks', () => {
  const existing = task({ title: '0408 DEMO第3次课后作业' }), base = state({ tasks: [existing] });
  const plan = K.createPlan(base, [announcement()]); assert.deepEqual(plan.rows[0].candidates, []);
  const edited = K.reviseAnnouncement(base, plan, announcement().sourceId, { title: 'Homework 03', due: '2026-11-12' });
  assert.equal(edited.ok, true); assert.equal(edited.rows[0].item.sourceId, announcement().sourceId);
  assert.equal(edited.rows[0].candidates[0].id, existing.id); assert.doesNotMatch(JSON.stringify(edited.rows[0].candidates), /NaN/);
  const linked = K.applyPlan(base, edited, [{ sourceId: announcement().sourceId, targetId: existing.id }]);
  assert.equal(linked.ok, true); assert.equal(linked.value.tasks.length, 1);
  assert.deepEqual([linked.value.tasks[0].id, linked.value.tasks[0].title, linked.value.tasks[0].progress, linked.value.tasks[0].totalMinutes], [existing.id, existing.title, 30, 120]);
  const created = K.applyPlan(state(), K.reviseAnnouncement(state(), K.createPlan(state(), [announcement()]), announcement().sourceId, { title: '整理示例课程专题', due: '2026-11-19T16:30' }), [{ sourceId: announcement().sourceId, targetId: null }]);
  assert.equal(created.ok, true); assert.equal(created.value.tasks[0].title, '【DEMO】整理示例课程专题');
  assert.equal(created.value.tasks[0].due, '2026-11-19T16:30');
  assert.doesNotMatch(JSON.stringify(created.value), /preview-excerpt-only|preview-date-note-only|sourceKind|sourceUrl|excerpt|dateNote/);
});

test('announcement edits preserve stale-plan protection and stable bindings after local renaming', () => {
  const bound = task({ sourceGroup: 'pku:' + announcement().sourceId, title: '本地保留的名称', progress: 60 }), base = state({ tasks: [bound] });
  const plan = K.createPlan(base, [announcement({ due: '2026-11-20' })]);
  const edited = K.reviseAnnouncement(base, plan, announcement().sourceId, { title: '另一种公告标题', due: '2026-11-21T10:00' });
  assert.equal(edited.rows[0].taskId, bound.id);
  const saved = K.applyPlan(base, edited, [{ sourceId: announcement().sourceId, targetId: bound.id }]);
  assert.equal(saved.ok, true); assert.equal(saved.value.tasks[0].title, bound.title); assert.equal(saved.value.tasks[0].progress, 60);
  assert.equal(K.reviseAnnouncement(saved.value, plan, announcement().sourceId, { title: '过期编辑' }).ok, false);
  assert.equal(K.reviseAnnouncement(base, plan, announcement().sourceId, { sourceUrl: 'https://evil.example' }).ok, false);
  assert.equal(K.reviseAnnouncement(base, plan, announcement().sourceId, { title: '' }).ok, false);
  assert.equal(K.reviseAnnouncement(base, plan, announcement().sourceId, { due: '2026-02-30' }).ok, false);
});
