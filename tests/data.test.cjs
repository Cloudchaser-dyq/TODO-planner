'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Data = require('../dist/data.js');

test('demo and empty state validate; default semester starts on Monday eight weeks earlier', () => {
  const state = Data.createDemo('2026-11-01');
  assert.equal(Data.validateState(state).ok, true);
  assert.equal(Data.validateState(Data.emptyState('2026-11-01')).ok, true);
  assert.equal(state.tasks.length, 4);
  assert.ok(state.tasks.every(task => task.title.includes('示例')));
  assert.equal(state.settings.weights.enjoyment, -10);
  assert.equal(state.settings.useDailyBudget, false);
  assert.equal(state.settings.semesterStart, '2026-08-31');
});

test('backup validation rejects wrong types, duplicate ids, unsafe keys and impossible dates', () => {
  const base = () => Data.createDemo('2026-11-01');
  const wrongType = base(); wrongType.settings.dailyBudget = '240';
  assert.equal(Data.validateState(wrongType).ok, false);
  const duplicate = base(); duplicate.tasks[1].id = duplicate.tasks[0].id;
  assert.equal(Data.validateState(duplicate).ok, false);
  const impossibleDate = base(); impossibleDate.tasks[0].due = '2026-02-30T12:00';
  assert.equal(Data.validateState(impossibleDate).ok, false);
  const invalidTime = base(); invalidTime.courses[0].end = '24:01';
  assert.equal(Data.validateState(invalidTime).ok, false);
  const malicious = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.equal(Data.validateState(malicious).ok, false);
  assert.equal({}.polluted, undefined);
  assert.equal(Data.validateState(null).ok, false);
});

test('validation strips extra keys and accepts completed tasks and valid activity logs', () => {
  const state = Data.createDemo('2026-11-01');
  state.tasks[0].progress = 100; state.tasks[0].remaining = 'untrusted derived value';
  state.tasks[0].done = false;
  state.tasks[0].untrustedExtra = 'ignored';
  state.logs.push({id: 'log-1', taskId: state.tasks[0].id, taskTitle: state.tasks[0].title, date: '2026-11-01', minutes: 45, at: '2026-11-01T10:30:00.000Z'});
  const result = Data.validateState(state);
  assert.equal(result.ok, true);
  assert.equal(result.value.tasks[0].done, true);
  assert.equal(result.value.tasks[0].remaining, 0);
  assert.equal(Object.hasOwn(result.value.tasks[0], 'untrustedExtra'), false);
  state.logs[0].date = '2025-02-29';
  assert.equal(Data.validateState(state).ok, false);
});

test('percentage targets derive minutes without marking a stage as the whole task complete', () => {
  const task = {totalMinutes: 300, progress: 20, target: 50};
  assert.deepEqual(Data.taskMetrics(task), {remaining: 90, overallRemaining: 240, stageReached: false, done: false, needsEstimate: false});
  task.target = 20;
  assert.deepEqual(Data.taskMetrics(task), {remaining: 0, overallRemaining: 240, stageReached: true, done: false, needsEstimate: false});
  task.target = 10;
  assert.equal(Data.taskMetrics(task).remaining, 0);
  assert.equal(Data.taskMetrics(task).overallRemaining, 240);
  assert.equal(Data.taskMetrics({totalMinutes: 10000, progress: 50, target: 50.1}).remaining, 10);
  const state = Data.createDemo('2026-11-01');
  state.tasks[0].progress = 50; state.tasks[0].target = 20;
  const validated = Data.validateState(state);
  assert.equal(validated.ok, true);
  assert.equal(validated.value.tasks[0].remaining, 0);
  assert.equal(validated.value.tasks[0].done, false);
  assert.equal(Object.hasOwn(validated.value.tasks[0], 'urgency'), false);
});

test('percentage imports reject malformed canonical values and migrate old remaining-only backups', () => {
  for (const [key, value] of [['target', 0], ['target', 101], ['target', '50'], ['progress', -1], ['progress', 20.01], ['totalMinutes', 4]]) {
    const state = Data.createDemo('2026-11-01');
    state.tasks[0][key] = value;
    assert.equal(Data.validateState(state).ok, false, key + ':' + value);
  }
  const state = Data.createDemo('2026-11-01');
  state.tasks.forEach((task, index) => {
    delete task.totalMinutes; delete task.progress; delete task.target;
    task.remaining = index ? 45 : 0;
    task.done = !index;
    task.urgency = 5;
  });
  const migrated = Data.validateState(state);
  assert.equal(migrated.ok, true);
  assert.deepEqual(migrated.value.tasks.map(task => [task.totalMinutes, task.progress, task.target, task.remaining, task.done]), [[5, 100, 100, 0, true], [45, 0, 100, 45, false], [45, 0, 100, 45, false], [45, 0, 100, 45, false]]);
});

test('CSV round trip preserves quoted names, multiline locations, recurrence and Sunday', () => {
  const courses = Data.createDemo('2026-11-01').courses;
  courses[0].title = '统计学, "实验"';
  courses[0].location = '主楼\n302';
  courses[1].day = 0; courses[1].weekMode = 'even'; courses[1].startWeek = 2;
  const result = Data.parseCoursesCSV(Data.exportCoursesCSV(courses));
  assert.deepEqual(result.errors, []);
  const withoutId = list => list.map(({id, ...rest}) => rest);
  assert.deepEqual(withoutId(result.courses), withoutId(courses));
});

test('CSV supports Chinese weekdays and catches bad timing, weeks and unclosed quotes', () => {
  const header = '课程,星期,开始,结束,地点,单双周,起始周,结束周\n';
  const result = Data.parseCoursesCSV(header + '数学,周一,08:00,09:35,A201,单周,1,18\n英语,星期日,10:00,11:30,,双周,2,20');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.courses.map(course => [course.day, course.weekMode]), [[1, 'odd'], [0, 'even']]);
  assert.ok(Data.parseCoursesCSV(header + '数学,1,09:00,08:00,,all,1,20').errors.length);
  assert.ok(Data.parseCoursesCSV(header + '数学,1,08:00,09:00,,all,21,20').errors.length);
  assert.ok(Data.parseCoursesCSV(header + '"数学,1,08:00,09:00,,all,1,20').errors.length);
});

test('date-only tasks preserve unknown estimates, explicit flags and inferred precision', () => {
  const batch = Data.validateTaskBatch({type: 'youxu-task-batch', version: 1, id: 'sample-group', tasks: [
    {id: 'date-only', title: '完成实验报告', due: '2026-11-08', flagged: true, sourceGroup: 'sample-group'},
    {id: 'with-time', title: '提交实习材料', due: '2026-11-08T18:00'},
    {id: 'no-ddl', title: '准备选题'}
  ]});
  assert.equal(batch.ok, true);
  const [dateOnly, withTime, withoutDDL] = batch.value.tasks;
  assert.deepEqual([dateOnly.totalMinutes, dateOnly.importance, dateOnly.enjoyment, dateOnly.progress, dateOnly.target], [null, null, null, 0, 100]);
  assert.deepEqual(Data.taskMetrics(dateOnly), {remaining: null, overallRemaining: null, stageReached: false, done: false, needsEstimate: true});
  assert.deepEqual([dateOnly.duePrecision, withTime.duePrecision, withoutDDL.duePrecision], ['date', 'time', 'none']);
  assert.equal(dateOnly.flagged, true);
  assert.equal(dateOnly.sourceGroup, 'sample-group');
  const state = Data.emptyState('2026-11-01'); state.tasks = batch.value.tasks;
  assert.equal(Data.validateState(state).ok, true);
  const ratingMissing = {totalMinutes: 120, progress: 25, target: 50, importance: null, enjoyment: 3};
  assert.equal(Data.taskMetrics(ratingMissing).remaining, 30);
  assert.equal(Data.taskMetrics(ratingMissing).needsEstimate, true);
});

test('known progress can complete a task or reach a stage without an estimated duration', () => {
  const unknown = {totalMinutes: null, progress: 100, target: null, importance: null, enjoyment: null};
  assert.deepEqual(Data.taskMetrics(unknown), {remaining: 0, overallRemaining: 0, stageReached: true, done: true, needsEstimate: true});
  unknown.progress = 50; unknown.target = 50;
  assert.deepEqual(Data.taskMetrics(unknown), {remaining: 0, overallRemaining: null, stageReached: true, done: false, needsEstimate: true});
  unknown.importance = 3; unknown.enjoyment = 3;
  assert.equal(Data.taskMetrics(unknown).needsEstimate, false);
  unknown.target = 80;
  assert.equal(Data.taskMetrics(unknown).remaining, null);
  assert.equal(Data.taskMetrics(unknown).needsEstimate, true);
  const batch = Data.validateTaskBatch({type: 'youxu-task-batch', version: 1, tasks: [{title: '未估时也可以完成', progress: 100}]});
  assert.equal(batch.ok, true);
  assert.equal(batch.value.tasks[0].done, true);
  assert.equal(batch.value.tasks[0].remaining, 0);
});

test('batch validation rejects impossible dates, wrong types and unsafe objects', () => {
  const wrap = task => ({type: 'youxu-task-batch', version: 1, tasks: [{title: '任务', ...task}]});
  for (const task of [{due: '2026-02-29'}, {due: '2026-11-31'}, {due: '2026-11-08T24:00'}, {progress: '50'}, {flagged: 'yes'}, {sourceGroup: 'x'.repeat(101)}]) {
    assert.equal(Data.validateTaskBatch(wrap(task)).ok, false);
  }
  assert.equal(Data.validateTaskBatch(JSON.parse('{"type":"youxu-task-batch","version":1,"tasks":[{"title":"任务","__proto__":{"polluted":true}}]}')).ok, false);
  assert.equal(Data.validateTaskBatch({type: 'wrong', version: 1, tasks: [{title: '任务'}]}).ok, false);
  assert.equal(Data.validateTaskBatch({type: 'youxu-task-batch', version: 1, tasks: []}).ok, false);
  assert.equal(Data.validateTaskBatch({...wrap({}), id: 123}).ok, false);
});

test('batch append deduplicates without replacing real tasks, settings, courses or logs', () => {
  const current = Data.createDemo('2026-11-01'); current.demo = false;
  current.tasks[0].title = '已有的真实任务'; current.tasks[0].due = '2026-11-08'; current.settings.weights.enjoyment = -40;
  current.logs.push({id: 'real-log', taskId: current.tasks[0].id, taskTitle: current.tasks[0].title, date: '2026-11-01', minutes: 20, at: '2026-11-01T08:00:00.000Z'});
  const snapshot = JSON.stringify(current);
  const batch = {type: 'youxu-task-batch', version: 1, id: 'sample-batch', tasks: [
    {id: 'new-duplicate-id', title: '  已有的真实任务  ', due: '2026-11-08'},
    {id: 'new-task', title: '新任务', due: '2026-11-10'},
    {id: 'another-id', title: '新任务', due: '2026-11-10'},
    {id: 'same-title-different-precision', title: '新任务', due: '2026-11-10T18:00'}
  ]};
  const merged = Data.mergeTaskBatch(current, batch);
  assert.equal(merged.ok, true);
  assert.deepEqual([merged.added, merged.skipped], [2, 2]);
  assert.equal(merged.value.tasks[0].totalMinutes, current.tasks[0].totalMinutes);
  assert.deepEqual(merged.value.settings, current.settings);
  assert.deepEqual(merged.value.courses, current.courses);
  assert.deepEqual(merged.value.logs, current.logs.map(log => Data.normalizeLog(log).value));
  assert.equal(JSON.stringify(current), snapshot, 'merge does not mutate the source state');
  assert.deepEqual(merged.value.appliedBatches, ['sample-batch']);
  merged.value.tasks = merged.value.tasks.filter(task => task.id !== 'new-task');
  const repeated = Data.mergeTaskBatch(merged.value, batch);
  assert.equal(repeated.added, 0);
  assert.equal(repeated.value.tasks.some(task => task.id === 'new-task'), false, 'a deleted imported task must not be resurrected');
});

test('demo cleanup preserves real additions, edited samples, and unrelated logs', () => {
  const current = Data.createDemo('2026-11-01');
  current.tasks[0].due = '2026-11-20T18:00'; // A user-edited sample deadline is meaningful data.
  current.tasks.push({id: 'real-task', title: '用户自己的任务', category: '课业', importance: null, enjoyment: null, totalMinutes: null, progress: null, target: null, due: '2026-11-08', nextAction: ''});
  current.courses.push({id: 'real-course', title: '用户真实课程', day: 2, start: '16:00', end: '17:00', location: '', weekMode: 'all', startWeek: 1, endWeek: 20});
  current.logs.push({id: 'real-log', taskId: 'real-task', taskTitle: '用户自己的任务', date: '2026-11-01', minutes: 20, at: '2026-11-01T08:00:00.000Z'});
  const merged = Data.mergeTaskBatch(current, {type: 'youxu-task-batch', version: 1, tasks: [{title: '导入任务', due: '2026-11-09'}]});
  assert.equal(merged.ok, true);
  assert.equal(merged.value.demo, false);
  assert.deepEqual(merged.value.tasks.map(task => task.title), ['【示例】完成实习周报', '用户自己的任务', '导入任务']);
  assert.deepEqual(merged.value.courses.map(course => course.title), ['用户真实课程']);
  assert.equal(merged.value.logs.length, 1);
  assert.deepEqual(merged.value.settings, current.settings);
  const fresh = Data.mergeTaskBatch(Data.createDemo('2026-11-01'), {type: 'youxu-task-batch', version: 1, tasks: [{title: '导入任务'}]});
  assert.equal(fresh.value.tasks.length, 1);
  assert.equal(fresh.value.courses.length, 0);
});

test('applied batch metadata defaults for old backups and rejects invalid values', () => {
  const old = Data.emptyState('2026-11-01'); delete old.appliedBatches;
  assert.deepEqual(Data.validateState(old).value.appliedBatches, []);
  old.appliedBatches = ['same', 'same'];
  assert.equal(Data.validateState(old).ok, false);
  old.appliedBatches = [100];
  assert.equal(Data.validateState(old).ok, false);
});

function activity(overrides = {}) {
  return {id: 'activity-1', taskId: 'snapshot-task', taskTitle: '完成调研初稿', date: '2026-11-01', minutes: 45, at: '2026-11-01T10:00:00.000Z', ...overrides};
}

test('legacy activity logs gain safe defaults while preserving historical titles and minutes', () => {
  const state = Data.emptyState('2026-11-01');
  state.logs = [activity()];
  const checked = Data.validateState(state);
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value.logs[0], activity({note: '', fromProgress: null, toProgress: null, status: 'activity', startedAt: '', endedAt: ''}));
  assert.equal(state.logs[0].status, undefined, 'migration does not mutate original backup');
});

test('progress snapshots can record partial or completed work with unknown elapsed time', () => {
  const partial = Data.normalizeLog(activity({minutes: null, note: '整理完两份访谈，尚未写结论', fromProgress: 20.2, toProgress: 50.1}));
  assert.equal(partial.ok, true);
  assert.deepEqual([partial.value.minutes, partial.value.status, partial.value.fromProgress, partial.value.toProgress], [null, 'partial', 20.2, 50.1]);
  const completed = Data.normalizeLog(activity({minutes: null, fromProgress: 50, toProgress: 100, status: 'partial'}));
  assert.equal(completed.value.status, 'completed');
  const standalone = Data.normalizeLog(activity({taskId: '', minutes: null, status: 'completed', note: '清理完书桌'}));
  assert.equal(standalone.ok, true);
  assert.equal(standalone.value.status, 'completed');
  const state = Data.emptyState('2026-11-01'); state.logs = [partial.value];
  assert.equal(Data.validateState(state).ok, true, 'a deleted source task does not invalidate the snapshot');
});

test('start and end times derive accurate duration and assign cross-midnight work to its start day', () => {
  const sameDay = Data.normalizeLog(activity({minutes: 'stale value is ignored', startedAt: '2026-11-01T09:15', endedAt: '2026-11-01T10:00'}));
  assert.equal(sameDay.ok, true);
  assert.equal(sameDay.value.minutes, 45);
  const overnight = Data.normalizeLog(activity({minutes: null, startedAt: '2026-11-01T23:30', endedAt: '2026-11-02T00:15'}));
  assert.equal(overnight.ok, true);
  assert.deepEqual([overnight.value.date, overnight.value.minutes], ['2026-11-01', 45]);
  assert.equal(Data.summarizeLogs([overnight.value], '2026-11-01').totalMinutes, 45);
  assert.equal(Data.summarizeLogs([overnight.value], '2026-11-02').totalMinutes, 0);
});

test('activity validation rejects bad intervals, dates, progress, text and duration types', () => {
  for (const patch of [
    {startedAt: '2026-11-01T10:00'},
    {startedAt: '2026-11-01T10:00', endedAt: '2026-11-01T09:00'},
    {startedAt: '2026-11-01T10:00', endedAt: '2026-11-01T10:00'},
    {startedAt: '2026-11-01T10:00', endedAt: '2026-11-02T10:01'},
    {startedAt: '2026-11-02T10:00', endedAt: '2026-11-02T11:00'},
    {startedAt: '2026-11-01T24:00', endedAt: '2026-11-02T01:00'},
    {date: '2026-02-30'}, {minutes: '45'}, {minutes: 0}, {minutes: 1441},
    {fromProgress: -1}, {toProgress: 100.1}, {fromProgress: 20.01}, {note: 'x'.repeat(2001)}, {status: 'unknown'}
  ]) assert.equal(Data.normalizeLog(activity(patch)).ok, false, JSON.stringify(patch).slice(0, 120));
});

test('daily summary sorts records, counts statuses and excludes unknown durations from totals', () => {
  const logs = [
    activity({id: 'early', minutes: 30, fromProgress: 20, toProgress: 50, startedAt: '2026-11-01T08:00', endedAt: '2026-11-01T08:30'}),
    activity({id: 'later', minutes: null, fromProgress: 50, toProgress: 100, at: '2026-11-01T12:00:00.000Z'}),
    activity({id: 'standalone', taskId: '', minutes: 15, status: 'activity', at: '2026-11-01T13:00:00.000Z'}),
    activity({id: 'other-day', date: '2026-11-02', minutes: 120})
  ];
  const summary = Data.summarizeLogs(logs, '2026-11-01');
  assert.deepEqual(summary.entries.map(log => log.id), ['standalone', 'later', 'early']);
  assert.deepEqual([summary.totalMinutes, summary.completedCount, summary.partialCount, summary.unknownDurationCount], [45, 1, 1, 1]);
  assert.equal(logs[0].id, 'early', 'summary does not reorder input');
});

test('14-day retention includes today and 13 prior dates, expiring only older records', () => {
  const logs = [activity({id: 'expired', date: '2026-10-18'}), activity({id: 'boundary', date: '2026-10-19'}), activity({id: 'today', date: '2026-11-01'}), activity({id: 'future', date: '2026-11-02'})];
  const pruned = Data.pruneLogs(logs, '2026-11-01');
  assert.equal(pruned.cutoff, '2026-10-19');
  assert.equal(pruned.removed, 1);
  assert.deepEqual(pruned.logs.map(log => log.id), ['boundary', 'today', 'future']);
  assert.equal(logs.length, 4, 'retention does not mutate the original list');
  assert.equal(Data.summarizeLogs(pruned.logs, '2026-10-19').totalMinutes, 45);
});

test('retention uses calendar dates correctly across a year boundary and leap day', () => {
  assert.equal(Data.pruneLogs([], '2032-01-01').cutoff, '2031-12-19');
  assert.equal(Data.pruneLogs([], '2028-03-01').cutoff, '2028-02-17');
  const result = Data.pruneLogs([activity({id: 'too-old', date: '2028-02-16'}), activity({id: 'boundary', date: '2028-02-17'}), activity({id: 'leap-day', date: '2028-02-29'})], '2028-03-01');
  assert.equal(result.removed, 1);
  assert.deepEqual(result.logs.map(log => log.date), ['2028-02-17', '2028-02-29']);
});

test('daily task cap is opt-in and older backups default to no cap', () => {
  const state = Data.emptyState('2026-11-01');
  assert.equal(state.settings.useDailyBudget, false);
  assert.equal(state.settings.dailyBudget, 240, 'latent user configuration remains available');
  delete state.settings.useDailyBudget;
  assert.equal(Data.validateState(state).value.settings.useDailyBudget, false);
  state.settings.useDailyBudget = true;
  assert.equal(Data.validateState(state).value.settings.useDailyBudget, true);
  for (const invalid of ['true', 1, null]) {
    state.settings.useDailyBudget = invalid;
    assert.equal(Data.validateState(state).ok, false);
  }
});

test('ordinary legacy tasks default to actionable tasks without inferring events from titles', () => {
  const state = Data.createDemo('2026-11-02');
  state.tasks[0].title = '固定活动的准备工作';
  const checked = Data.validateState(state);
  assert.equal(checked.ok, true);
  assert.ok(checked.value.tasks.every(task => task.kind === 'task' && task.eventStatus === 'pending'));
  assert.equal(Data.isEvent(checked.value.tasks[0]), false);
  assert.equal(Data.isEvent(null), false);
  assert.equal(checked.value.tasks[0].remaining, state.tasks[0].remaining);
});

test('explicit kinds and opaque IDs are preserved without guessing events from titles', () => {
  const tasks = [
    {id: 'opaque-reference-a', title: '固定活动', due: '2031-04-09'},
    {id: 'opaque-reference-b', title: '课程甲考试', due: '2031-04-09', kind: 'task'},
    {id: 'opaque-reference-c', title: '普通报告', due: '2031-04-09', kind: 'event', eventStatus: 'attended'},
    {id: 'opaque-reference-d', title: '其他记录', due: '2031-04-09', kind: 'event', eventStatus: 'pending', progress: 100}
  ];
  const checked = Data.validateTaskBatch({type: 'youxu-task-batch', version: 1, tasks});
  assert.equal(checked.ok, true);
  assert.deepEqual(checked.value.tasks.map(task => task.kind), ['task', 'task', 'event', 'event']);
  assert.deepEqual(checked.value.tasks.map(task => task.id), tasks.map(task => task.id));
  assert.equal(checked.value.tasks[2].done, true);
  assert.equal(checked.value.tasks[3].done, false);
});

test('event metrics depend on attendance status and never require work estimates or stage progress', () => {
  const event = {kind: 'event', eventStatus: 'pending', totalMinutes: 600, progress: 100, target: 100, importance: null, enjoyment: null};
  assert.deepEqual(Data.taskMetrics(event), {remaining: 0, overallRemaining: 0, stageReached: false, done: false, needsEstimate: false});
  event.eventStatus = 'attended'; event.progress = 0;
  assert.deepEqual(Data.taskMetrics(event), {remaining: 0, overallRemaining: 0, stageReached: false, done: true, needsEstimate: false});
  event.eventStatus = 'missed';
  assert.equal(Data.taskMetrics(event).done, true);
  assert.equal(Data.isEvent(event), true);
});

test('batch events preserve occurrence metadata and numeric legacy fields without actionability', () => {
  const input = {id: 'exam-event', title: '考试安排', kind: 'event', due: '2031-04-09T15:00', eventEnd: '2031-04-09T17:25', eventLocation: '第二教学楼 201', eventStatus: 'pending', totalMinutes: 300, progress: 20, target: 50};
  const checked = Data.validateTaskBatch({type: 'youxu-task-batch', version: 1, tasks: [input]});
  assert.equal(checked.ok, true);
  const event = checked.value.tasks[0];
  assert.deepEqual([event.kind, event.eventEnd, event.eventLocation, event.eventStatus], ['event', input.eventEnd, input.eventLocation, 'pending']);
  assert.deepEqual([event.totalMinutes, event.progress, event.target, event.remaining], [300, 20, 50, 0]);
  const state = Data.emptyState('2026-11-02'); state.tasks = [event];
  assert.equal(Data.validateState(state).ok, true);
});

test('date-only events are valid, while end times require a valid exact start and at most seven days', () => {
  function check(patch) { return Data.validateTaskBatch({type: 'youxu-task-batch', version: 1, tasks: [{title: '固定活动', kind: 'event', due: '2031-04-09', ...patch}]}); }
  assert.equal(check({}).ok, true);
  assert.equal(check({due: ''}).ok, true);
  assert.equal(check({due: '2031-04-09T10:00', eventEnd: '2031-04-16T10:00'}).ok, true);
  for (const patch of [
    {eventEnd: '2031-04-09T12:00'},
    {due: '', eventEnd: '2031-04-09T12:00'},
    {due: '2031-04-09T12:00', eventEnd: '2031-04-09T12:00'},
    {due: '2031-04-09T12:00', eventEnd: '2031-04-09T11:00'},
    {due: '2031-04-09T10:00', eventEnd: '2031-04-16T10:01'},
    {eventEnd: '2031-04-32T12:00'},
    {eventLocation: 'x'.repeat(201)}, {eventStatus: 'done'}, {kind: 'unknown'}
  ]) assert.equal(check(patch).ok, false, JSON.stringify(patch).slice(0, 120));
});

test('explicit event batches deduplicate without replacing user changes', () => {
  const batch = {type: 'youxu-task-batch', version: 1, tasks: [{id: 'example-event', title: '固定活动甲', due: '2031-04-09', kind: 'event'}]};
  const current = Data.emptyState('2031-04-01');
  current.tasks = Data.validateTaskBatch(batch).value.tasks;
  current.tasks[0].eventLocation = '用户修改的地点';
  const merged = Data.mergeTaskBatch(current, batch);
  assert.equal(merged.ok, true);
  assert.deepEqual([merged.added, merged.skipped, merged.value.tasks.length], [0, 1, 1]);
  assert.equal(merged.value.tasks[0].kind, 'event');
  assert.equal(merged.value.tasks[0].eventLocation, '用户修改的地点');
});

test('generic batch fixtures preserve dates, explicit classifications, flags and unknown estimates', () => {
  const input = {type: 'youxu-task-batch', version: 1, id: 'generic-example', tasks: [
    {id: 'example-report', title: '课程甲报告', due: '2031-04-07', kind: 'task', flagged: true, sourceGroup: 'example-group'},
    {id: 'example-event', title: '固定活动', due: '2031-04-09', kind: 'event', flagged: true},
    {id: 'example-practice', title: '课程乙练习', due: '2031-04-12', kind: 'task'}
  ]};
  const checked = Data.validateTaskBatch(input);
  assert.equal(checked.ok, true);
  assert.equal(checked.value.id, input.id);
  assert.deepEqual(checked.value.tasks.map(task => [task.id, task.title, task.due, task.kind, task.flagged, task.sourceGroup]), [
    ['example-report', '课程甲报告', '2031-04-07', 'task', true, 'example-group'],
    ['example-event', '固定活动', '2031-04-09', 'event', true, ''],
    ['example-practice', '课程乙练习', '2031-04-12', 'task', false, '']
  ]);
  for (const task of checked.value.tasks) {
    assert.deepEqual([task.totalMinutes, task.progress, task.target, task.importance, task.enjoyment], [null, task.kind === 'event' ? null : 0, task.kind === 'event' ? null : 100, null, null]);
    assert.equal(task.duePrecision, 'date');
    if (Data.isEvent(task)) assert.deepEqual([task.eventStatus, task.eventEnd, task.eventLocation], ['pending', '', '']);
  }
});

test('generic batches deduplicate and cannot resurrect deleted work after reapplication', () => {
  const batches = [
    {type: 'youxu-task-batch', version: 1, id: 'example-a', tasks: [{id: 'report', title: '报告', due: '2031-04-07', flagged: true}, {id: 'meeting', title: '固定活动', due: '2031-04-09', kind: 'event'}]},
    {type: 'youxu-task-batch', version: 1, id: 'example-b', tasks: [{id: 'report', title: '报告', due: '2031-04-07'}, {id: 'exercise', title: '课程乙练习', due: '2031-04-12'}]},
    {type: 'youxu-task-batch', version: 1, id: 'example-c', tasks: [{id: 'final-report', title: '课程甲报告', due: '2031-04-17', flagged: true}, {id: 'meeting-b', title: '固定活动乙', due: '2031-04-21', kind: 'event', flagged: true}]}
  ];
  let current = Data.emptyState('2031-04-01');
  const changes = [];
  for (const batch of batches) {
    const merged = Data.mergeTaskBatch(current, batch);
    assert.equal(merged.ok, true); changes.push([merged.added, merged.skipped]); current = merged.value;
  }
  assert.deepEqual(changes, [[2, 0], [1, 1], [2, 0]]);
  assert.equal(current.tasks.length, 5);
  assert.equal(new Set(current.tasks.map(task => task.id)).size, 5);
  assert.deepEqual([current.tasks.filter(task => task.kind === 'task').length, current.tasks.filter(task => task.kind === 'event').length], [3, 2]);
  current.tasks = current.tasks.filter(task => task.id !== 'final-report');
  current.tasks.find(task => task.id === 'exercise').progress = 50;
  const repeated = Data.mergeTaskBatch(current, batches[2]);
  assert.deepEqual([repeated.added, repeated.skipped, repeated.value.tasks.length], [0, 2, 4]);
  assert.equal(repeated.value.tasks.some(task => task.id === 'final-report'), false);
  assert.equal(repeated.value.tasks.find(task => task.id === 'exercise').progress, 50);
});

test('new batches default missing or null task progress to 0/100 while preserving explicit values and events', () => {
  const batch = Data.validateTaskBatch({type: 'youxu-task-batch', version: 1, tasks: [
    {id: 'default-missing', title: '未填进度', totalMinutes: 120},
    {id: 'default-null', title: '原本为空', progress: null, target: null},
    {id: 'explicit-stage', title: '明确的阶段', progress: 20, target: 50, totalMinutes: 300},
    {id: 'event-null', title: '未知进度的事件', kind: 'event'},
    {id: 'generic-event', title: '固定活动', kind: 'event'},
    {id: 'event-latent', title: '保留旧数字的事件', kind: 'event', progress: 30, target: 60}
  ]});
  assert.equal(batch.ok, true);
  assert.deepEqual(batch.value.tasks.map(task => [task.progress, task.target, task.remaining]), [[0, 100, 120], [0, 100, null], [20, 50, 90], [null, null, 0], [null, null, 0], [30, 60, 0]]);
  assert.equal(batch.value.tasks[4].kind, 'event', 'explicit events do not gain task progress defaults');
});

test('complete-backup validation preserves existing task percentages including explicit unknowns', () => {
  const state = Data.createDemo('2026-11-02');
  state.tasks[0].progress = null; state.tasks[0].target = null;
  delete state.appliedMigrations;
  const checked = Data.validateState(state);
  assert.equal(checked.ok, true);
  assert.deepEqual([checked.value.tasks[0].progress, checked.value.tasks[0].target], [null, null]);
  assert.deepEqual([checked.value.tasks[1].progress, checked.value.tasks[1].target], [25, 75]);
  assert.deepEqual(checked.value.appliedMigrations, []);
});

test('one-time defaults fill only unknown percentages and preserve completed work and logs', () => {
  const state = Data.createDemo('2031-04-01'); state.demo = false;
  state.tasks[0].progress = 100; state.tasks[0].target = 100;
  state.tasks[1].progress = null; state.tasks[1].target = null;
  state.tasks[2].progress = 35; state.tasks[2].target = null;
  state.tasks[3].progress = null; state.tasks[3].target = 40;
  state.tasks.push({id: 'event-preserved', title: '已登记的固定活动', kind: 'event', eventStatus: 'attended', totalMinutes: 300, progress: 75, target: 75, importance: 4, enjoyment: 2, category: '课业', due: '2031-03-30T10:00', eventEnd: '2031-03-30T11:00', eventLocation: '示例地点', nextAction: ''});
  state.logs.push(activity({fromProgress: 20, toProgress: 100}));
  state.appliedBatches = ['existing-import']; state.appliedMigrations = ['existing-other-migration'];
  const before = Data.validateState(state).value, original = JSON.stringify(state);
  const result = Data.applyTaskProgressDefaults(state);
  assert.equal(result.ok, true); assert.equal(result.changed, true);
  assert.equal(JSON.stringify(state), original);
  for (const task of result.value.tasks.filter(task => task.kind === 'task')) {
    const previous = before.tasks.find(item => item.id === task.id);
    assert.deepEqual([task.progress, task.target], [previous.progress ?? 0, previous.target ?? 100]);
  }
  assert.equal(result.value.tasks[0].done, true, 'known completed work must never reset on startup');
  assert.equal(result.value.tasks[2].progress, 35);
  assert.equal(result.value.tasks[3].target, 40);
  assert.deepEqual(result.value.tasks.find(task => task.id === 'event-preserved'), before.tasks.find(task => task.id === 'event-preserved'));
  assert.deepEqual(result.value.logs, before.logs);
  assert.deepEqual(result.value.courses, before.courses);
  assert.deepEqual(result.value.settings, before.settings);
  assert.deepEqual(result.value.appliedBatches, before.appliedBatches);
  assert.deepEqual(result.value.appliedMigrations, ['existing-other-migration', Data.TASK_PROGRESS_DEFAULTS_MIGRATION_ID]);
  result.value.tasks[0].progress = 35; result.value.tasks[0].target = 60;
  const again = Data.applyTaskProgressDefaults(result.value);
  assert.equal(again.changed, false);
  assert.deepEqual([again.value.tasks[0].progress, again.value.tasks[0].target], [35, 60]);
  assert.equal(again.value.logs.length, before.logs.length);
});

test('migration markers survive JSON backups, support empty states, and reject malformed metadata', () => {
  const migrated = Data.applyTaskProgressDefaults(Data.emptyState('2026-11-02'));
  assert.equal(migrated.ok, true); assert.equal(migrated.changed, true);
  assert.deepEqual(migrated.value.appliedMigrations, ['task-progress-defaults-0-100-v1']);
  const restored = Data.validateState(JSON.parse(JSON.stringify(migrated.value)));
  assert.equal(restored.ok, true);
  assert.equal(Data.applyTaskProgressDefaults(restored.value).changed, false);
  for (const metadata of ['invalid', [123], ['duplicate', 'duplicate'], ['x'.repeat(101)]]) {
    const state = Data.emptyState('2026-11-02'); state.appliedMigrations = metadata;
    assert.equal(Data.validateState(state).ok, false);
    assert.equal(Data.applyTaskProgressDefaults(state).ok, false);
  }
});

test('default filling before a generic import still removes untouched demo records', () => {
  let state = Data.applyTaskProgressDefaults(Data.createDemo('2031-04-01')).value;
  state = Data.mergeTaskBatch(state, {type: 'youxu-task-batch', version: 1, tasks: [{title: '报告', due: '2031-04-07'}, {title: '固定活动', due: '2031-04-09', kind: 'event'}]}).value;
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks.some(task => task.title.startsWith('【示例】')), false);
  assert.ok(state.tasks.filter(task => task.kind === 'task').every(task => task.progress === 0 && task.target === 100));
  assert.ok(state.tasks.filter(task => task.kind === 'event').every(task => task.progress === null && task.target === null));
  assert.deepEqual(state.appliedMigrations, [Data.TASK_PROGRESS_DEFAULTS_MIGRATION_ID]);
});

test('task view defaults to table and preserves a valid card preference through complete backups', () => {
  const state = Data.emptyState('2026-11-02');
  assert.equal(state.settings.taskView, 'table');
  delete state.settings.taskView;
  assert.equal(Data.validateState(state).value.settings.taskView, 'table');
  state.settings.taskView = 'cards';
  const restored = Data.validateState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.ok, true);
  assert.equal(restored.value.settings.taskView, 'cards');
  for (const invalid of ['list', '', null, true, 1, []]) {
    state.settings.taskView = invalid;
    assert.equal(Data.validateState(state).ok, false);
  }
});

function suggestionTask(id, title, totalMinutes, patch = {}) {
  return {id, title, kind: 'task', category: '课业', importance: 3, enjoyment: 3, totalMinutes, progress: 0, target: 100, due: '', nextAction: '', ...patch};
}
function suggestionDay(offset = 0) {
  const date = new Date(); date.setDate(date.getDate() + offset);
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
function suggestionLog(id, taskId, title, fromProgress, toProgress, minutes, hour, patch = {}) {
  const day = suggestionDay();
  return activity({id, taskId, taskTitle: title, date: day, at: day + 'T' + String(hour).padStart(2, '0') + ':00:00.000Z', fromProgress, toProgress, minutes, ...patch});
}

test('calendar recurrence includes the original task, preserves its progress and resets only later occurrences', () => {
  const task = suggestionTask('original-cycle', '课程甲作业', 300, {due: '2026-12-25T10:30', progress: 20, target: 50, importance: 5, enjoyment: 2, nextAction: '先完成题目一', flagged: true, sourceGroup: 'example-cycle'});
  const before = JSON.stringify(task);
  const checked = Data.createRecurringTaskBatch(task, {frequency: 'weekly', interval: 2, count: 3});
  assert.equal(checked.ok, true);
  assert.equal(Object.hasOwn(checked.value, 'id'), false, 'recurrence batches must remain reusable');
  const tasks = checked.value.tasks;
  assert.deepEqual(tasks.map(task => task.due), ['2026-12-25T10:30', '2027-01-08T10:30', '2027-01-22T10:30']);
  assert.equal(tasks[0].id, 'original-cycle');
  assert.equal(new Set(tasks.map(task => task.id)).size, 3);
  assert.deepEqual(tasks.map(task => [task.progress, task.target, task.remaining]), [[20, 50, 90], [0, 100, 300], [0, 100, 300]]);
  for (const item of tasks) assert.deepEqual([item.title, item.category, item.totalMinutes, item.importance, item.enjoyment, item.nextAction, item.flagged], [task.title, task.category, 300, 5, 2, task.nextAction, true]);
  assert.equal(JSON.stringify(task), before);
  const state = Data.emptyState();
  const merged = Data.mergeTaskBatch(state, checked.value);
  const repeated = Data.mergeTaskBatch(merged.value, Data.createRecurringTaskBatch(task, {frequency: 'weekly', interval: 2, count: 3}).value);
  assert.deepEqual([merged.added, repeated.added, repeated.skipped], [3, 0, 3]);
});

test('daily recurrence preserves date precision and local clock through leap dates and clock-change periods', () => {
  const leap = Data.createRecurringTaskBatch(suggestionTask('leap', '每日练习', null, {due: '2028-02-28'}), {frequency: 'daily', interval: 1, count: 3});
  assert.deepEqual(leap.value.tasks.map(task => task.due), ['2028-02-28', '2028-02-29', '2028-03-01']);
  const clock = Data.createRecurringTaskBatch(suggestionTask('clock', '每日练习', null, {due: '2026-03-07T10:30'}), {frequency: 'daily', interval: 1, count: 3});
  assert.deepEqual(clock.value.tasks.map(task => task.due), ['2026-03-07T10:30', '2026-03-08T10:30', '2026-03-09T10:30']);
  const unknown = Data.createRecurringTaskBatch(suggestionTask('unknown-first', '保留首条未知进度', null, {due: '2026-11-03', progress: null, target: null}), {frequency: 'daily', interval: 1, count: 2});
  assert.deepEqual(unknown.value.tasks.map(task => [task.progress, task.target]), [[null, null], [0, 100]]);
});

test('recurrence rejects events, invalid counts and intervals, missing deadlines and overflowing years', () => {
  const task = suggestionTask('cycle', '课程甲作业', 60, {due: '2026-11-03'}), options = {frequency: 'weekly', interval: 1, count: 3};
  for (const patch of [{frequency: 'monthly'}, {interval: 0}, {interval: 13}, {interval: '1'}, {count: 1}, {count: 53}, {count: 2.5}]) assert.equal(Data.createRecurringTaskBatch(task, {...options, ...patch}).ok, false);
  assert.equal(Data.createRecurringTaskBatch({...task, kind: 'event'}, options).ok, false);
  assert.equal(Data.createRecurringTaskBatch({...task, id: 'invalid-kind', title: '固定活动', kind: undefined}, options).ok, false);
  assert.equal(Data.createRecurringTaskBatch({...task, due: ''}, options).ok, false);
  assert.equal(Data.createRecurringTaskBatch({...task, due: '2200-12-31'}, options).ok, false);
  assert.equal(Data.createRecurringTaskBatch(task, {frequency: 'daily', interval: 1, count: 52}).value.tasks.length, 52);
});

test('estimate suggestions prefer exact normalized titles and use median estimates without modifying data', () => {
  const state = Data.emptyState(); state.tasks = [suggestionTask('a', '课程甲作业', 100), suggestionTask('b', '课程甲 作业！', 80), suggestionTask('nearby', '课程甲作业第2次', 500), suggestionTask('event', '课程甲作业', 999, {kind: 'event'})];
  const before = JSON.stringify(state), result = Data.getEstimateSuggestion(state, '课程甲 作业');
  assert.deepEqual([result.minutes, result.sampleCount, result.source, result.exact], [90, 2, 'estimated', true]);
  assert.deepEqual(new Set(result.matchedTitles), new Set(['课程甲作业', '课程甲 作业！']));
  assert.equal(Data.getEstimateSuggestion(state, '课程甲作业', 'a').minutes, 80);
  assert.equal(JSON.stringify(state), before);
});

test('safe approximate matching keeps subjects and work categories separate', () => {
  const state = Data.emptyState();
  state.tasks = [suggestionTask('lab5', '课程甲 lab5', 90), suggestionTask('lab7', '课程甲 lab7', 120), suggestionTask('course-a-2', '课程甲作业2', 70), suggestionTask('discrete', '课程乙作业2', 500), suggestionTask('written', '课程丙第5章书面作业', 60), suggestionTask('mooc', '课程丙第6章在线作业', 240), suggestionTask('bare', '作业1', 999), suggestionTask('cpp', 'C++作业1', 55), suggestionTask('c', 'C作业1', 400)];
  const lab = Data.getEstimateSuggestion(state, '课程甲 LAB6');
  assert.deepEqual([lab.minutes, lab.sampleCount, lab.exact], [105, 2, false]);
  assert.equal(Data.getEstimateSuggestion(state, '课程甲作业3').minutes, 70);
  assert.equal(Data.getEstimateSuggestion(state, '课程丙第六章书面作业').minutes, 60);
  assert.equal(Data.getEstimateSuggestion(state, 'C++作业2').minutes, 55);
  assert.equal(Data.getEstimateSuggestion(state, '课程甲考试'), null);
  assert.equal(Data.getEstimateSuggestion(state, '课程甲 LAB测试'), null);
  assert.equal(Data.getEstimateSuggestion(state, '作业3'), null);
  assert.equal(Data.getEstimateSuggestion(state, '课程丁作业3'), null);
});

test('complete nonoverlapping progress chains provide actual medians ahead of matching estimates', () => {
  const state = Data.emptyState();
  state.tasks = [suggestionTask('actual-a', '课程甲作业', 300, {progress: 100}), suggestionTask('actual-b', '课程甲作业', 400, {progress: 100})];
  state.logs = [suggestionLog('a1', 'actual-a', '课程甲作业', 0, 50, 40, 8), suggestionLog('a2', 'actual-a', '课程甲作业', 50, 100, 60, 9), suggestionLog('b1', 'actual-b', '课程甲作业', 0, 100, 150, 10)];
  const result = Data.getEstimateSuggestion(state, '课程甲作业');
  assert.deepEqual([result.minutes, result.sampleCount, result.source, result.exact], [125, 2, 'actual', true]);
  assert.equal(Data.getEstimateSuggestion(state, '课程甲作业', 'actual-a').minutes, 150);
});

test('gaps, overlaps, duplicate or unknown segments and expired evidence cannot establish actual totals', () => {
  const day = suggestionDay();
  const base = [suggestionLog('one', 'history', '课程甲作业', 0, 50, 40, 8), suggestionLog('two', 'history', '课程甲作业', 50, 100, 60, 9)];
  const cases = [
    [base[0], {...base[1], fromProgress: 60}],
    [base[0], {...base[1], fromProgress: 40}],
    [base[0], {...base[1], minutes: null}],
    [base[0], base[1], {...base[0], id: 'duplicate'}],
    [{...base[0], date: suggestionDay(-14)}, base[1]],
    [base[0], {...base[1], at: day + 'T07:00:00.000Z'}],
    [base[0], {...base[1], fromProgress: null}],
    [{...base[0], startedAt: day + 'T08:00', endedAt: day + 'T09:00'}, {...base[1], startedAt: day + 'T08:30', endedAt: day + 'T09:30'}]
  ];
  for (const logs of cases) {
    const state = Data.emptyState(); state.tasks = [suggestionTask('history', '课程甲作业', 200)]; state.logs = logs;
    const result = Data.getEstimateSuggestion(state, '课程甲作业');
    assert.ok(result); assert.equal(result.source, 'estimated'); assert.equal(result.minutes, 200);
  }
});

test('recent deleted-task snapshots remain usable while expired logs never create hidden historical memory', () => {
  const state = Data.emptyState(); state.logs = [suggestionLog('deleted', 'deleted-task', '课程甲作业', 0, 100, 75, 8)];
  assert.equal(Data.getEstimateSuggestion(state, '课程甲作业').source, 'actual');
  state.logs[0].date = suggestionDay(-14);
  assert.equal(Data.getEstimateSuggestion(state, '课程甲作业'), null);
  state.tasks = [suggestionTask('estimate-memory', '课程甲作业', 80)];
  assert.equal(Data.getEstimateSuggestion(state, '课程甲作业').source, 'estimated');
  assert.equal(Data.getEstimateSuggestion(state, '课程甲作业').minutes, 80);
});

test('daily fixed arrangements remain single records and preserve their flag through backups', () => {
  const state = Data.emptyState('2026-11-03');
  state.courses = [{id: 'daily-arrangement', title: '午休', day: 0, daily: true, start: '12:30', end: '13:00', location: '', weekMode: 'all', startWeek: 1, endWeek: 20}];
  const checked = Data.validateState(JSON.parse(JSON.stringify(state)));
  assert.equal(checked.ok, true);
  assert.equal(checked.value.courses.length, 1);
  assert.deepEqual([checked.value.courses[0].id, checked.value.courses[0].daily, checked.value.courses[0].day], ['daily-arrangement', true, 0]);
  delete state.courses[0].daily;
  assert.equal(Data.validateState(state).value.courses[0].daily, false);
  for (const invalid of ['true', 1, null]) {
    state.courses[0].daily = invalid;
    assert.equal(Data.validateState(state).ok, false);
  }
});

test('course CSV round trips daily entries while preserving weekday numbers and old seven-column files', () => {
  const courses = [
    {id: 'daily', title: '午休,固定', day: 0, daily: true, start: '12:30', end: '13:00', location: '宿舍\nA区', weekMode: 'even', startWeek: 2, endWeek: 18},
    {id: 'sunday', title: '周日课程', day: 0, daily: false, start: '15:00', end: '16:00', location: '', weekMode: 'all', startWeek: 1, endWeek: 20}
  ];
  const text = Data.exportCoursesCSV(courses), checked = Data.parseCoursesCSV(text);
  assert.match(text, /每天/);
  assert.deepEqual(checked.errors, []);
  assert.deepEqual(checked.courses.map(({id, ...rest}) => rest), courses.map(({id, ...rest}) => rest));
  const old = Data.parseCoursesCSV('课程,星期,开始,结束,单双周,起始周,结束周\n数学,1,08:00,09:00,all,1,20\n阅读,7,10:00,11:00,odd,1,20');
  assert.deepEqual(old.errors, []);
  assert.deepEqual(old.courses.map(course => [course.day, course.daily]), [[1, false], [0, false]]);
  for (const label of ['每天', '每日', 'daily']) {
    const result = Data.parseCoursesCSV('课程,星期,开始,结束\n午休,' + label + ',12:30,13:00');
    assert.deepEqual(result.errors, []);
    assert.deepEqual([result.courses[0].day, result.courses[0].daily], [0, true]);
  }
});

test('a user-modified demo course set to daily is retained when importing real tasks', () => {
  const state = Data.createDemo('2026-11-03'); state.courses[0].daily = true;
  const merged = Data.mergeTaskBatch(state, {type: 'youxu-task-batch', version: 1, tasks: [{title: '用户真实任务'}]});
  assert.equal(merged.ok, true);
  assert.equal(merged.value.courses.length, 1);
  assert.equal(merged.value.courses[0].id, state.courses[0].id);
  assert.equal(merged.value.courses[0].daily, true);
});
