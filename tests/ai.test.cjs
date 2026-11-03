'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const AI = require('../dist/ai.js');
const D = require('../dist/data.js');
function seed() {
  const state = D.emptyState('2026-11-03');
  state.appliedMigrations = [D.TASK_PROGRESS_DEFAULTS_MIGRATION_ID];
  state.appliedBatches = ['existing-batch'];
  state.tasks = D.validateTaskBatch({ type: 'youxu-task-batch', version: 1, tasks: [
    { id: 'a', title: '论文', kind: 'task', due: '2026-11-10', totalMinutes: 300, progress: 20, target: 80, sourceGroup: '保留来源', flagged: true },
    { id: 'b', title: '作业', kind: 'task', due: '2026-11-09' },
    { id: 'event', title: '期末考试', kind: 'event', due: '2026-12-10T09:00', eventEnd: '2026-12-10T11:00', eventLocation: 'A101', progress: 20, target: 50 }
  ] }).value.tasks;
  state.courses = [{ id: 'course', title: '课程', day: 1, start: '08:00', end: '09:00', location: '保留地点', weekMode: 'all', startWeek: 1, endWeek: 20 }];
  state.logs = [{ id: 'log', taskId: 'a', taskTitle: '论文', date: '2026-11-02', minutes: 30, at: '2026-11-02T02:00:00.000Z', fromProgress: 10, toProgress: 20 }];
  return D.validateState(state).value;
}
const dateOptions = { now: '2026-11-03T10:00:00', dateString: '2026-11-03' };
function requestOptions(extra = {}) { return { provider: 'deepseek', model: 'deepseek-flash', apiKey: 'secret-never-log', tasks: seed().tasks, instruction: '把论文预计时长改为400分钟', dateString: '2026-11-03', ...extra }; }
function response(content = '{"summary":"完成","actions":[]}', extra = {}) { return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content }, ...extra }] }) }; }

test('AI prompt transmits only selected canonical task fields, never unrelated private state', () => {
  const state = seed(); state.tasks[0].apiKey = 'must-not-send'; state.tasks[0].logs = state.logs;
  const messages = AI.buildMessages([state.tasks[0]], '只改论文', '2026-11-03');
  assert.equal(messages.length, 2);
  const sent = JSON.parse(messages[1].content);
  assert.equal(sent.tasks.length, 1); assert.equal(sent.tasks[0].id, 'a');
  assert.equal(sent.tasks[0].apiKey, undefined); assert.equal(sent.tasks[0].logs, undefined);
  assert.doesNotMatch(JSON.stringify(messages), /must-not-send|保留地点/);
  assert.throws(() => AI.buildMessages(Array(201).fill(state.tasks[0]), '要求', '2026-11-03'), /200/);
  assert.throws(() => AI.buildMessages([], '', '2026-11-03'), /修改要求/);
});

test('AI plan atomically creates, updates and deletes while preserving logs, courses and metadata', () => {
  const state = seed(), original = JSON.stringify(state);
  const result = AI.validatePlan(state, { summary: '三项修改', actions: [
    { type: 'update', id: 'a', changes: { totalMinutes: 400, progress: 35 } },
    { type: 'delete', id: 'b' },
    { type: 'create', task: { title: '新任务', due: '2026-11-20' } }
  ] }, { ...dateOptions, allowedIds: ['a', 'b'] });
  assert.equal(result.ok, true, result.errors.join(' '));
  assert.equal(JSON.stringify(state), original);
  assert.equal(result.value.tasks.length, 3);
  const added = result.value.tasks.find(task => task.title === '新任务');
  assert.ok(added.id); assert.deepEqual([added.progress, added.target, added.totalMinutes], [0, 100, null]);
  assert.deepEqual(result.value.logs, state.logs); assert.deepEqual(result.value.courses, state.courses);
  assert.deepEqual(result.value.settings, state.settings); assert.deepEqual(result.value.appliedBatches, state.appliedBatches);
  assert.deepEqual(result.value.appliedMigrations, state.appliedMigrations);
  assert.deepEqual(result.value.tasks.find(task => task.id === 'event'), state.tasks[2]);
  assert.deepEqual(result.changes.map(change => change.type), ['update', 'delete', 'create']);
  assert.equal(result.changes[0].before.progress, 20); assert.equal(result.changes[0].after.progress, 35);
  assert.equal(result.value.logs.length, 1, 'module never creates work logs');
});

test('invalid AI operations never partially apply and cannot access excluded IDs or protected fields', () => {
  const state = seed(), raw = JSON.stringify(state);
  const plans = [
    { actions: [{ type: 'update', id: 'a', changes: { progress: 35 } }, { type: 'update', id: 'missing', changes: { title: '坏' } }] },
    { actions: [{ type: 'update', id: 'b', changes: { title: '范围外' } }] },
    { actions: [{ type: 'update', id: 'a', changes: { id: 'replace' } }] },
    { actions: [{ type: 'update', id: 'a', changes: { logs: [] } }] },
    { actions: [{ type: 'delete', id: 'a' }, { type: 'delete', id: 'a' }] },
    { actions: [{ type: 'update', id: 'a', changes: { totalMinutes: -1 } }] },
    { actions: [{ type: 'create', task: { title: '论文', due: '2026-11-10' } }] },
    { actions: [{ type: 'send-email', id: 'a' }] },
    { actions: [], settings: {} },
    { actions: Array.from({ length: 51 }, () => ({ type: 'create', task: { title: '太多' } })) }
  ];
  for (const plan of plans) {
    const result = AI.validatePlan(state, plan, { ...dateOptions, allowedIds: ['a'] });
    assert.equal(result.ok, false, JSON.stringify(plan)); assert.equal(result.value, undefined); assert.equal(JSON.stringify(state), raw);
  }
});

test('unsafe objects, getters, prototype pollution, excessive depth and huge plans are rejected without execution', () => {
  let invoked = false;
  const getter = { actions: [] }; Object.defineProperty(getter, 'summary', { enumerable: true, get() { invoked = true; return 'danger'; } });
  const deep = { actions: [] }; let pointer = deep; for (let i = 0; i < 30; i++) { pointer.next = {}; pointer = pointer.next; }
  for (const plan of [getter, deep, JSON.parse('{"actions":[],"__proto__":{"polluted":true}}'), Object.create({ actions: [] }), { summary: 'x'.repeat(600000), actions: [] }]) assert.equal(AI.validatePlan(seed(), plan).ok, false);
  assert.equal(invoked, false); assert.equal({}.polluted, undefined);
});

test('events preserve hidden legacy progress and reject task conversion or invented work metrics', () => {
  const state = seed();
  const result = AI.validatePlan(state, { actions: [{ type: 'update', id: 'event', changes: { eventLocation: 'A202' } }] }, dateOptions);
  assert.equal(result.ok, true); assert.deepEqual([result.value.tasks[2].progress, result.value.tasks[2].target], [20, 50]);
  for (const changes of [{ kind: 'task' }, { progress: 40 }, { totalMinutes: 120 }, { eventStatus: 'attended' }, { eventStatus: 'missed' }]) assert.equal(AI.validatePlan(state, { actions: [{ type: 'update', id: 'event', changes }] }, dateOptions).ok, false);
  const made = AI.validatePlan(state, { actions: [{ type: 'create', task: { title: '新活动', kind: 'event', due: '2026-11-05' } }] }, dateOptions);
  assert.equal(made.ok, true); assert.deepEqual([made.changes[0].after.progress, made.changes[0].after.target, made.changes[0].after.eventStatus], [null, null, 'pending']);
});

test('event status checks use exact times where provided and allow past or current date-only occurrences', () => {
  for (const [due, permitted] of [['', false], ['2026-11-04', false], ['2026-11-03T11:00', false], ['2026-11-03T09:00', true], ['2026-11-03', true], ['2026-11-02', true]]) {
    const result = AI.validatePlan(seed(), { actions: [{ type: 'create', task: { title: '已参加活动', kind: 'event', due, eventStatus: 'attended' } }] }, dateOptions);
    assert.equal(result.ok, permitted, due);
  }
});

test('official provider requests use exact destinations and authorization while keeping secrets out of messages', async () => {
  for (const provider of ['deepseek', 'openai']) {
    let captured;
    const plan = await AI.requestPlan(requestOptions({ provider }), async (url, init) => { captured = { url, init }; return response(); });
    assert.deepEqual(plan.actions, []); assert.equal(captured.url, AI.PROVIDERS[provider].url);
    assert.equal(captured.init.headers.Authorization, 'Bearer secret-never-log');
    const body = JSON.parse(captured.init.body); assert.equal(body.stream, false);
    assert.equal(body.temperature, undefined); assert.equal(body.response_format, undefined);
    assert.doesNotMatch(captured.init.body, /secret-never-log/); assert.equal(captured.init.redirect, 'error');
  }
});

test('local proxy requests use the fixed route and strict provider selection', async () => {
  let captured;
  await AI.requestPlan(requestOptions({ proxyUrl: '/api/ai' }), async (url, init) => { captured = { url, init }; return response(); });
  assert.equal(captured.url, '/api/ai'); const body = JSON.parse(captured.init.body);
  assert.equal(body.provider, 'deepseek'); assert.equal(body.apiKey, 'secret-never-log');
  assert.equal(captured.init.headers.Authorization, undefined);
  for (const extra of [{ provider: 'https://evil.example' }, { proxyUrl: 'https://evil.example/api/ai' }, { apiKey: '' }, { model: '' }]) await assert.rejects(AI.requestPlan(requestOptions(extra), () => { throw new Error('must not fetch'); }));
});

test('AI response extraction accepts JSON fences and rejects truncation, reasoning-only and malformed content', async () => {
  const fenced = await AI.requestPlan(requestOptions(), async () => response('```json\n{"summary":"可确认","actions":[]}\n```'));
  assert.equal(fenced.summary, '可确认');
  for (const upstream of [response('{"actions":[]}', { finish_reason: 'length' }), response(''), response('分析后我认为应该修改。'), response('x'.repeat(600000)), response(null, { message: { reasoning_content: '推理', content: null } })]) await assert.rejects(AI.requestPlan(requestOptions(), async () => upstream));
});

test('provider errors and network exceptions are sanitized and cancellations stop waiting', async () => {
  for (const status of [401, 429, 500]) {
    await assert.rejects(AI.requestPlan(requestOptions(), async () => ({ ok: false, status, text: async () => 'secret-never-log' })), error => !error.message.includes('secret-never-log'));
  }
  await assert.rejects(AI.requestPlan(requestOptions(), async () => { throw new Error('secret-never-log'); }), error => /node preview.cjs/.test(error.message) && !error.message.includes('secret-never-log'));
  const controller = new AbortController();
  const pending = AI.requestPlan(requestOptions({ signal: controller.signal }), () => new Promise(() => {}));
  controller.abort(); await assert.rejects(pending, error => error.name === 'AbortError');
});

test('AI requests stop waiting at sixty seconds even when a transport ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestSignal;
  const pending = AI.requestPlan(requestOptions(), (_url, init) => { requestSignal = init.signal; return new Promise(() => {}); });
  const rejected = assert.rejects(pending, error => error.name === 'TimeoutError' && /60/.test(error.message));
  t.mock.timers.tick(60000); await rejected;
  assert.equal(requestSignal.aborted, true);
});

test('oversized streamed responses are canceled before the remainder is read', async () => {
  let cancelled = false, released = false, reads = 0;
  const upstream = { body: { getReader: () => ({ read: async () => { reads++; return { value: new Uint8Array(20), done: false }; }, cancel: async () => { cancelled = true; }, releaseLock: () => { released = true; } }) } };
  await assert.rejects(AI.readResponseText(upstream, 10), /响应过大/);
  assert.equal(reads, 1); assert.equal(cancelled, true); assert.equal(released, true);
});
