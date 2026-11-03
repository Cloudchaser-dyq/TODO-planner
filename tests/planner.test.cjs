const test = require('node:test');
const assert = require('node:assert/strict');
const Planner = require('../dist/planner.js');

const settings = {
  weights: { importance: 60, urgency: 35, enjoyment: -10 },
  dayStart: '08:00', dayEnd: '22:00', dailyBudget: 240,
  blockMinutes: 45, breakMinutes: 10, courseBuffer: 10,
  semesterStart: '2026-10-26', semesterWeeks: 20
};
const task = (id, extra = {}) => ({ id, title: id, importance: 3, urgency: 3, enjoyment: 3,
  remaining: 120, due: '', nextAction: '推进下一步', done: false, ...extra });
const at = (day, h = 0, m = 0) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year, month - 1, date, h, m);
};

test('daily fixed arrangements match all seven weekdays and retain week and semester restrictions', () => {
  const daily = {id: 'daily-even', title: '每天固定安排', day: 0, daily: true, start: '09:00', end: '10:00', weekMode: 'even', startWeek: 2, endWeek: 3};
  for (let offset = 0; offset < 7; offset += 1) {
    const day = Planner.addDays('2026-11-02', offset);
    assert.deepEqual(Planner.coursesForDate([daily], day, settings).map(course => course.id), ['daily-even']);
  }
  assert.equal(Planner.coursesForDate([daily], '2026-11-01', settings).length, 0);
  assert.equal(Planner.coursesForDate([daily], '2026-11-09', settings).length, 0);
  assert.equal(Planner.coursesForDate([daily], '2026-10-25', settings).length, 0);
  assert.equal(Planner.coursesForDate([daily], '2027-04-05', settings).length, 0);
  const odd = {...daily, weekMode: 'odd'};
  assert.equal(Planner.coursesForDate([odd], '2026-11-09', settings).length, 1);
  assert.equal(Planner.coursesForDate([odd], '2026-11-15', settings).length, 1);
  assert.equal(Planner.coursesForDate([odd], '2026-11-16', settings).length, 0);
  assert.equal(Planner.coursesForDate([{...daily, daily: false, weekMode: 'all'}], '2026-11-02', settings).length, 0);
  assert.equal(Planner.coursesForDate([{...daily, daily: false, weekMode: 'all'}], '2026-11-08', settings).length, 1);
});

test('a single daily course occupies and buffers its interval on every day without duplicating source records', () => {
  const courses = [{id: 'daily-break', title: '每日固定安排', day: 0, daily: true, start: '09:00', end: '10:00', weekMode: 'all', startWeek: 1, endWeek: 20}];
  const config = {...settings, useDailyBudget: false, dayEnd: '12:00', courseBuffer: 15, breakMinutes: 0};
  for (let offset = 0; offset < 7; offset += 1) {
    const day = Planner.addDays('2026-11-02', offset);
    const plan = Planner.planDay({tasks: [task('work', {remaining: 300})], courses, settings: config, date: day, now: at('2026-11-01')});
    assert.equal(plan.blocks.filter(block => block.kind === 'course').length, 1);
    assert.equal(plan.freeMinutes, 150);
    assert.equal(plan.plannedMinutes, 150);
    for (const block of plan.blocks.filter(block => block.kind === 'task')) assert.ok(block.end <= 525 || block.start >= 615);
  }
  assert.equal(courses.length, 1);
  assert.equal(courses[0].day, 0);
});

test('daily courses also reduce future-day deadline capacity instead of blocking only Sunday', () => {
  const config = {...settings, useDailyBudget: false, dayStart: '08:00', dayEnd: '10:00', courseBuffer: 0, breakMinutes: 0};
  const course = {id: 'daily-busy', title: '每天占用', day: 0, daily: true, start: '08:00', end: '10:00', weekMode: 'all', startWeek: 1, endWeek: 20};
  const options = {tasks: [task('delivery', {remaining: 180, due: '2026-11-04T10:00'})], settings: config, date: '2026-11-02', now: at('2026-11-01')};
  const weekly = Planner.planDay({...options, courses: [{...course, daily: false}]});
  const daily = Planner.planDay({...options, courses: [course]});
  assert.equal(weekly.ranked[0].priority.risk, 'normal');
  assert.equal(daily.ranked[0].priority.risk, 'tight');
  assert.equal(daily.plannedMinutes, 0);
});

test('negative enjoyment lowers priority; zero and entirely negative scores still schedule', () => {
  const bitter = task('bitter', { enjoyment: 1 });
  const sweet = task('sweet', { enjoyment: 5 });
  assert.ok(Planner.getTaskPriority(bitter, settings, '2026-11-02').score >
    Planner.getTaskPriority(sweet, settings, '2026-11-02').score);
  const negative = { ...settings, weights: { importance: 0, urgency: 0, enjoyment: -100 } };
  const p = Planner.planDay({ tasks: [sweet, bitter], settings: negative, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.blocks.find(b => b.kind === 'task').taskId, 'bitter');
  assert.ok(p.plannedMinutes > 0);
  const zero = Planner.planDay({ tasks: [task('low', { importance: 1 }), task('high', { importance: 5 })],
    settings: { ...settings, weights: { importance: 0, urgency: 0, enjoyment: 0 } }, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(zero.ranked[0].id, 'high');
  assert.equal(zero.ranked[0].priority.score, 0);
});

test('local date math and odd/even recurrence include semester boundaries', () => {
  assert.equal(Planner.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(Planner.getWeek('2026-11-01', '2026-10-26'), 1);
  assert.equal(Planner.getWeek('2026-11-02', '2026-10-26'), 2);
  const courses = [
    { id: 'odd', title: '单周', day: 1, start: '09:00', end: '10:00', weekMode: 'odd', startWeek: 1, endWeek: 20 },
    { id: 'even', title: '双周', day: 1, start: '10:00', end: '11:00', weekMode: 'even', startWeek: 1, endWeek: 20 }
  ];
  assert.deepEqual(Planner.coursesForDate(courses, '2026-10-26', settings).map(c => c.id), ['odd']);
  assert.deepEqual(Planner.coursesForDate(courses, '2026-11-02', settings).map(c => c.id), ['even']);
  assert.equal(Planner.coursesForDate(courses, '2026-10-19', settings).length, 0);
  assert.equal(Planner.coursesForDate(courses, '2027-04-05', settings).length, 0);
});

test('courses, buffers, breaks, remaining work and daily budget never overlap or overallocate', () => {
  const courses = [{ id: 'math', title: '数学', day: 1, start: '09:00', end: '11:00', weekMode: 'all' }];
  const tasks = [task('a', { remaining: 70 }), task('b', { remaining: 900 })];
  const p = Planner.planDay({ tasks, courses, settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.freeMinutes, 840 - 120 - 20);
  assert.equal(p.bufferMinutes, 20);
  assert.ok(p.plannedMinutes <= settings.dailyBudget);
  assert.equal(p.plannedMinutes, Object.values(p.allocations).reduce((a, b) => a + b, 0));
  assert.ok(p.allocations.a <= 70);
  assert.ok(p.blocks.some(b => b.kind === 'break'));
  for (let i = 1; i < p.blocks.length; i++) assert.ok(p.blocks[i].start >= p.blocks[i - 1].end);
  for (const block of p.blocks.filter(b => b.kind === 'task')) {
    assert.ok(block.end <= 530 || block.start >= 670, 'course buffer is respected');
    assert.ok(block.end - block.start <= settings.blockMinutes);
  }
  assert.equal(tasks[0].remaining, 70, 'input tasks are not mutated');
});

test('hard deadline outranks signed scores; unfinished work never runs after a future deadline', () => {
  const urgent = task('deadline', { importance: 1, enjoyment: 5, remaining: 90, due: '2026-11-02T08:30' });
  const p = Planner.planDay({ tasks: [task('fun', { importance: 5, enjoyment: 1 }), urgent], settings,
    date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.ranked[0].id, 'deadline');
  assert.equal(p.ranked[0].priority.risk, 'tight');
  const work = p.blocks.filter(b => b.taskId === 'deadline');
  assert.equal(work.length, 1);
  assert.equal(work[0].end, 510);
  assert.equal(p.allocations.deadline, 30);
  assert.ok(p.warnings.some(w => w.includes('deadline') && w.includes('未排入')));
});

test('today starts at current time, and overdue tasks explicitly warn while allowing catch-up', () => {
  const p = Planner.planDay({ tasks: [task('late', { due: '2026-11-02T09:00' })], settings,
    date: '2026-11-02', now: at('2026-11-02', 13, 17) });
  const work = p.blocks.filter(b => b.kind === 'task');
  assert.ok(work.length);
  assert.ok(work.every(b => b.start >= 797));
  assert.equal(p.ranked[0].priority.risk, 'overdue');
  assert.ok(p.warnings.some(w => w.includes('已逾期')));
});

test('deadlines use available capacity including classes across coming days', () => {
  const busy = [{ id: 'busy', title: '整日课', day: 2, start: '08:00', end: '22:00', weekMode: 'all' }];
  const p = Planner.planDay({ tasks: [task('large', { remaining: 500, due: '2026-11-04T09:00' })],
    courses: busy, settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.ranked[0].priority.risk, 'tight');
  assert.ok(p.ranked[0].priority.reason.includes('可用时间'));
});

test('completed tasks, zero budgets, and exhausted days are handled without phantom allocation', () => {
  const tasks = [task('done', { done: true }), task('empty', { remaining: 0 }), task('todo')];
  const zero = Planner.planDay({ tasks, settings: { ...settings, dailyBudget: 0 }, date: '2026-11-02', now: at('2026-11-01') });
  assert.deepEqual(zero.ranked.map(t => t.id), ['todo']);
  assert.equal(zero.plannedMinutes, 0);
  const ended = Planner.planDay({ tasks, settings, date: '2026-11-02', now: at('2026-11-02', 23) });
  assert.equal(ended.freeMinutes, 0);
  assert.equal(ended.plannedMinutes, 0);
});

test('important long-term work receives a session when urgent work still fits in the budget', () => {
  const p = Planner.planDay({ tasks: [task('delivery', { remaining: 100, due: '2026-11-02T21:00' }),
    task('growth', { importance: 5, urgency: 1, enjoyment: 5, remaining: 60 })], settings,
    date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.allocations.delivery, 100);
  assert.equal(p.allocations.growth, 60);
});

test('protecting long-term work never pushes a feasible same-day delivery past its deadline', () => {
  const p = Planner.planDay({ tasks: [task('delivery', { remaining: 100, due: '2026-11-02T10:00' }),
    task('growth', { importance: 5, urgency: 1, enjoyment: 5, remaining: 60 })], settings,
    date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.allocations.delivery, 100);
  assert.ok(p.blocks.filter(b => b.taskId === 'delivery').every(b => b.end <= 600));
});

test('protected long-term session interrupts an otherwise dominant nonurgent task', () => {
  const p = Planner.planDay({ tasks: [task('routine', { importance: 5, enjoyment: 1, remaining: 900 }),
    task('growth', { importance: 5, urgency: 1, enjoyment: 5, remaining: 60 })], settings,
    date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.blocks.filter(b => b.kind === 'task')[2].taskId, 'growth');
  assert.ok(p.allocations.growth >= 45);
});

test('urgency is automatic: manual values do not affect score and closer deadlines increase urgency', () => {
  const early = task('auto', { due: '2026-11-09T20:00', urgency: 1 });
  const manual = { ...early, urgency: 5 };
  const a = Planner.getTaskPriority(early, settings, at('2026-11-02', 8), 2000);
  const b = Planner.getTaskPriority(manual, settings, at('2026-11-02', 8), 2000);
  const closer = Planner.getTaskPriority(early, settings, at('2026-11-08', 8), 2000);
  assert.equal(a.score, b.score);
  assert.equal(a.urgency, b.urgency);
  assert.ok(closer.urgency > a.urgency);
  assert.equal(Planner.getTaskPriority(task('no-ddl', { urgency: 5 }), settings, '2026-11-02').urgency, 1);
});

test('stage target schedules only the progress difference and preserves overall workload', () => {
  const p = Planner.planDay({ tasks: [task('staged', { totalMinutes: 600, progress: 20, target: 35 })], settings,
    date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.allocations.staged, 90);
  assert.equal(p.ranked[0].remaining, 90);
  assert.equal(p.ranked[0].overallRemaining, 480);
});

test('meeting a stage target is not completion and warns when the overall deadline is tight', () => {
  const staged = task('stage-met', { totalMinutes: 600, progress: 35, target: 30, done: false, due: '2026-11-02T20:00' });
  const p = Planner.planDay({ tasks: [staged], settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.ranked.length, 0);
  assert.equal(p.plannedMinutes, 0);
  assert.equal(staged.done, false);
  assert.ok(p.warnings.some(w => w.includes('本轮目标已达成') && w.includes('提高目标')));
  const complete = Planner.planDay({ tasks: [{ ...staged, progress: 100 }], settings,
    date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(complete.ranked.length, 0);
  assert.equal(complete.warnings.length, 0);
});

test('a small stage target cannot disguise the overall deadline risk', () => {
  const staged = task('large-stage', { totalMinutes: 1000, progress: 10, target: 11, due: '2026-11-05T20:00' });
  const whole = { ...staged, target: 100 };
  const a = Planner.getTaskPriority(staged, settings, '2026-11-02', 500);
  const b = Planner.getTaskPriority(whole, settings, '2026-11-02', 500);
  assert.equal(a.risk, 'tight');
  assert.equal(a.risk, b.risk);
  assert.equal(a.urgency, b.urgency);
  assert.ok(a.reason.includes('整体'));
});

test('decimal progress uses integer tenths without adding phantom stage or overall minutes', () => {
  const tasks = [
    task('decimal-stage', { importance: 5, totalMinutes: 1000, progress: 10.2, target: 10.3 }),
    task('decimal-overall', { totalMinutes: 1000, progress: 34.6, target: 100 })
  ];
  const p = Planner.planDay({ tasks, settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.ranked.find(t => t.id === 'decimal-stage').remaining, 1);
  assert.equal(p.allocations['decimal-stage'], 1);
  assert.equal(p.ranked.find(t => t.id === 'decimal-overall').overallRemaining, 654);
  assert.equal(p.ranked.find(t => t.id === 'decimal-overall').remaining, 654);
});

test('seeded mixed schedules preserve buffers, stage limits, daily budgets and deadlines', () => {
  let seed = 0x34a91cf2;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const integer = (low, high) => low + Math.floor(random() * (high - low + 1));
  const hhmm = n => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  const expectedRemaining = t => Math.ceil(t.totalMinutes * Math.max(0, Math.round(t.target * 10) - Math.round(t.progress * 10)) / 1000);
  for (let scenario = 0; scenario < 64; scenario++) {
    const s = { ...settings, dailyBudget: integer(0, 480), blockMinutes: integer(10, 60),
      breakMinutes: integer(0, 20), courseBuffer: integer(0, 20),
      weights: { importance: integer(-100, 100), urgency: integer(-100, 100), enjoyment: integer(-100, 100) } };
    const now = at('2026-11-02', integer(7, 14), integer(0, 59));
    const courses = Array.from({ length: integer(1, 6) }, (_, i) => {
      const start = integer(16, 40) * 30;
      return { id: 'course-' + i, title: '课程 ' + i, day: random() < 0.8 ? 1 : integer(0, 6),
        start: hhmm(start), end: hhmm(Math.min(1320, start + integer(1, 4) * 30)),
        weekMode: ['all', 'odd', 'even'][integer(0, 2)], startWeek: 1, endWeek: 20 };
    });
    const tasks = Array.from({ length: integer(2, 8) }, (_, i) => {
      const dueType = integer(0, 3), dueDay = dueType === 1 ? '2026-11-01' : dueType === 2 ? '2026-11-02' : Planner.addDays('2026-11-02', integer(1, 5));
      return task('t-' + i, { importance: integer(1, 5), enjoyment: integer(1, 5), totalMinutes: integer(5, 1200),
        progress: integer(0, 1000) / 10, target: integer(10, 1000) / 10,
        due: dueType ? dueDay + 'T' + hhmm(integer(8, 22) * 60) : '' });
    });
    const p = Planner.planDay({ tasks, courses, settings: s, date: '2026-11-02', now });
    const work = p.blocks.filter(b => b.kind === 'task');
    const activeCourses = Planner.coursesForDate(courses, '2026-11-02', s);
    assert.ok(p.plannedMinutes <= s.dailyBudget, 'scenario ' + scenario + ': daily budget');
    assert.equal(p.plannedMinutes, work.reduce((sum, b) => sum + b.end - b.start, 0));
    tasks.forEach(t => assert.ok((p.allocations[t.id] || 0) <= expectedRemaining(t), 'scenario ' + scenario + ': stage allocation'));
    for (let i = 0; i < work.length; i++) {
      const block = work[i], source = tasks.find(t => t.id === block.taskId);
      assert.ok(block.start >= Math.max(480, now.getHours() * 60 + now.getMinutes()));
      assert.ok(block.end > block.start && block.end <= 1320);
      if (i) assert.ok(block.start >= work[i - 1].end, 'scenario ' + scenario + ': task overlap');
      for (const course of activeCourses) {
        assert.ok(block.end <= course.startMin - s.courseBuffer || block.start >= course.endMin + s.courseBuffer,
          'scenario ' + scenario + ': buffered course overlap');
      }
      if (source.due.startsWith('2026-11-02') && block.risk !== 'overdue') {
        const [hours, minutes] = source.due.slice(11).split(':').map(Number);
        assert.ok(block.end <= hours * 60 + minutes, 'scenario ' + scenario + ': crossed deadline');
      }
    }
  }
});

test('logged actual minutes reduce the selected day budget and preserve fixed courses', () => {
  const courses = [{ id: 'math', title: '数学', day: 1, start: '09:00', end: '11:00', weekMode: 'all' }];
  const options = { tasks: [task('work', { remaining: 900 })], courses, settings,
    date: '2026-11-02', now: at('2026-11-01') };
  const partial = Planner.planDay({ ...options, spentMinutes: 180 });
  assert.equal(partial.spentMinutes, 180);
  assert.equal(partial.remainingBudget, 60);
  assert.equal(partial.plannedMinutes, 60);
  const used = Planner.planDay({ ...options, spentMinutes: 300 });
  assert.equal(used.remainingBudget, 0);
  assert.equal(used.plannedMinutes, 0);
  assert.equal(used.blocks.filter(b => b.kind === 'course').length, 1);
  assert.equal(used.blocks.filter(b => b.kind === 'task').length, 0);
  assert.ok(used.warnings.some(w => w.includes('已达到每日预算')));
  const negative = Planner.planDay({ ...options, spentMinutes: -40 });
  assert.equal(negative.spentMinutes, 0);
  assert.equal(negative.remainingBudget, settings.dailyBudget);
});

test('actual time reduces first-day deadline capacity while later days retain their full budget', () => {
  const options = { tasks: [task('delivery', { totalMinutes: 200, progress: 0, target: 100, due: '2026-11-03T20:00' })],
    settings, date: '2026-11-02', now: at('2026-11-01') };
  const baseline = Planner.planDay(options);
  const spent = Planner.planDay({ ...options, spentMinutes: 180 });
  // First day 60 + next day 240 = 300 minutes; the next day must not also lose 180.
  assert.equal(spent.ranked[0].priority.risk, 'normal');
  assert.ok(spent.ranked[0].priority.reason.includes('5 小时'));
  assert.ok(spent.ranked[0].priority.urgency > baseline.ranked[0].priority.urgency);
  const tight = Planner.planDay({ ...options, tasks: [{ ...options.tasks[0], totalMinutes: 300 }], spentMinutes: 180 });
  assert.equal(tight.ranked[0].priority.risk, 'tight');
});

test('date-only deadline covers its entire local day and becomes overdue at next midnight', () => {
  const dated = task('date-only', { totalMinutes: 180, progress: 0, target: 100, due: '2026-11-02' });
  const midday = Planner.getTaskPriority(dated, settings, at('2026-11-02', 12));
  assert.equal(midday.risk, 'tight');
  assert.equal(Planner.getTaskPriority(dated, settings, at('2026-11-03')).risk, 'overdue');
  const p = Planner.planDay({ tasks: [dated], settings, date: '2026-11-02', now: at('2026-11-02', 12) });
  assert.equal(p.ranked[0].due, '2026-11-02');
  assert.equal(p.ranked[0].priority.risk, 'tight');
  assert.equal(p.allocations['date-only'], 180);
  assert.ok(p.blocks.filter(b => b.kind === 'task').every(b => b.end <= 1320));
});

test('explicit null estimates remain in ranking without fabricating workload or time blocks', () => {
  const unknown = task('unknown', { totalMinutes: null, importance: null, enjoyment: null,
    progress: null, target: null, remaining: 900, due: '2026-11-02' });
  const p = Planner.planDay({ tasks: [unknown], settings, date: '2026-11-02', now: at('2026-11-02', 12) });
  assert.equal(p.ranked.length, 1);
  assert.equal(p.ranked[0].needsEstimate, true);
  assert.equal(p.ranked[0].remaining, null);
  assert.equal(p.ranked[0].overallRemaining, null);
  assert.equal(p.ranked[0].importance, null);
  assert.equal(p.ranked[0].enjoyment, null);
  assert.equal(p.ranked[0].priority.provisional, true);
  assert.equal(p.ranked[0].priority.workloadKnown, false);
  assert.equal(p.ranked[0].priority.risk, 'tight');
  assert.ok(p.ranked[0].priority.reason.includes('未估时'));
  assert.ok(p.ranked[0].priority.reason.includes('仅按 DDL'));
  assert.equal(p.plannedMinutes, 0);
  assert.equal(p.blocks.filter(b => b.kind === 'task').length, 0);
  assert.equal(p.allocations.unknown, 0);
});

test('unknown progress or target also prevents scheduling; unknown work does not imply effort risk', () => {
  const tasks = [
    task('no-progress', { totalMinutes: 600, progress: null, target: 100, due: '2026-11-09' }),
    task('no-target', { totalMinutes: 600, progress: 20, target: null, due: '2026-11-10' }),
    task('later', { totalMinutes: null, progress: null, target: null, due: '2026-11-20', flagged: true })
  ];
  const p = Planner.planDay({ tasks, settings: { ...settings, dailyBudget: 0 }, date: '2026-11-02', now: at('2026-11-01') });
  assert.deepEqual(p.ranked.map(t => t.id), ['no-progress', 'no-target', 'later']);
  assert.ok(p.ranked.every(t => t.needsEstimate && t.priority.risk === 'normal'));
  assert.ok(p.ranked[0].priority.urgency > p.ranked[2].priority.urgency);
  assert.equal(p.plannedMinutes, 0);
  assert.equal(p.ranked[2].flagged, true);
});

test('flagged marker is only a soft tie-break and never changes the numeric score', () => {
  const unflagged = task('a', { due: '2026-11-09', totalMinutes: null, progress: null, target: null });
  const flagged = { ...unflagged, id: 'z', flagged: true };
  const p = Planner.planDay({ tasks: [unflagged, flagged], settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.ranked[0].id, 'z');
  assert.equal(p.ranked[0].priority.score, p.ranked[1].priority.score);
});

test('known 100 percent means completed even when duration and stage target are unknown', () => {
  const completed = task('completed-unknown', { totalMinutes: null, progress: 100, target: null,
    done: false, due: '2026-11-01', remaining: 900 });
  const p = Planner.planDay({ tasks: [completed], settings, date: '2026-11-02', now: at('2026-11-02', 12) });
  assert.equal(p.ranked.length, 0);
  assert.equal(p.plannedMinutes, 0);
  assert.equal(p.warnings.length, 0);
  const priority = Planner.getTaskPriority(completed, settings, at('2026-11-02', 12));
  assert.equal(priority.risk, 'normal');
  assert.equal(priority.workloadKnown, true, 'completion establishes zero remaining work');
  assert.ok(priority.reason.includes('已完成'));
  const withoutDurationField = { ...completed };
  delete withoutDurationField.totalMinutes;
  assert.equal(Planner.planDay({ tasks: [withoutDurationField], settings, date: '2026-11-02' }).ranked.length, 0);
});

test('known progress can meet a phase goal without an estimate and still warn about an urgent unfinished whole task', () => {
  const reached = task('phase-unknown', { totalMinutes: null, progress: 40.2, target: 40.1,
    due: '2026-11-02', remaining: 900 });
  const p = Planner.planDay({ tasks: [reached], settings, date: '2026-11-02', now: at('2026-11-02', 12) });
  assert.equal(p.ranked.length, 0, 'reached phase is omitted from the active queue');
  assert.equal(p.plannedMinutes, 0);
  assert.equal(p.blocks.filter(b => b.kind === 'task').length, 0);
  assert.ok(p.warnings.some(w => w.includes('本轮目标已达成') && w.includes('整体任务尚未完成')));
  const priority = Planner.getTaskPriority(reached, settings, at('2026-11-02', 12));
  assert.equal(priority.workloadKnown, false, 'overall unknown estimate remains unknown');
  assert.equal(priority.risk, 'tight');
  const future = Planner.planDay({ tasks: [{ ...reached, due: '2026-12-02' }], settings,
    date: '2026-11-02', now: at('2026-11-02', 12) });
  assert.equal(future.ranked.length, 0);
  assert.equal(future.warnings.length, 0);
});

test('daily budget is optional: disabling it schedules beyond four hours within real available slots', () => {
  const options = { tasks: [task('long-work', { totalMinutes: 1200, progress: 0, target: 100 })],
    date: '2026-11-02', now: at('2026-11-01') };
  const unrestricted = Planner.planDay({ ...options, settings: { ...settings, useDailyBudget: false } });
  const limited = Planner.planDay({ ...options, settings: { ...settings, useDailyBudget: true } });
  assert.ok(unrestricted.plannedMinutes > 240);
  assert.ok(unrestricted.plannedMinutes <= unrestricted.freeMinutes);
  assert.equal(unrestricted.remainingBudget, unrestricted.freeMinutes);
  assert.equal(limited.plannedMinutes, 240);
  assert.ok(unrestricted.blocks.filter(b => b.kind === 'task').every(b => b.start >= 480 && b.end <= 1320));
});

test('without a daily cap, deadline capacity uses the configured windows instead of a four-hour assumption', () => {
  const options = { tasks: [task('delivery', { totalMinutes: 1000, progress: 0, target: 100, due: '2026-11-03T20:00' })],
    date: '2026-11-02', now: at('2026-11-01') };
  const unrestricted = Planner.planDay({ ...options, settings: { ...settings, useDailyBudget: false } });
  const limited = Planner.planDay({ ...options, settings: { ...settings, useDailyBudget: true } });
  assert.equal(unrestricted.ranked[0].priority.risk, 'normal');
  assert.ok(unrestricted.ranked[0].priority.reason.includes('26 小时'));
  assert.equal(limited.ranked[0].priority.risk, 'tight');
});

test('without a daily cap, logged work is not subtracted again from the rest of the day', () => {
  const options = { tasks: [task('remaining-work', { totalMinutes: 900, progress: 0, target: 100 })],
    settings: { ...settings, useDailyBudget: false, dailyBudget: 0 },
    date: '2026-11-02', now: at('2026-11-02', 12) };
  const noLog = Planner.planDay(options);
  const logged = Planner.planDay({ ...options, spentMinutes: 600 });
  assert.ok(logged.plannedMinutes > 240);
  assert.equal(logged.plannedMinutes, noLog.plannedMinutes);
  assert.equal(logged.remainingBudget, noLog.remainingBudget);
  assert.ok(logged.blocks.filter(b => b.kind === 'task').every(b => b.start >= 720));
  assert.ok(!logged.warnings.some(w => w.includes('预算')));
});

test('fixed events never enter task ranking, task allocations or long-term work sessions', () => {
  const event = task('example-event', { kind: 'event', title: '参加固定活动', due: '2031-04-09',
    eventStatus: 'pending', totalMinutes: 1200, progress: 0, target: 100, importance: 5 });
  const p = Planner.planDay({ tasks: [event, task('prepare', { remaining: 900 })], settings,
    date: '2026-11-02', now: at('2026-11-01') });
  assert.deepEqual(p.ranked.map(t => t.id), ['prepare']);
  assert.equal(p.allocations['example-event'], undefined);
  assert.ok(p.blocks.every(b => b.taskId !== 'example-event'));
  assert.equal(p.events[0].id, 'example-event');
  const priority = Planner.getTaskPriority({ ...event, due: '2026-10-01' }, settings, '2026-11-02');
  assert.equal(priority.event, true);
  assert.equal(priority.score, 0);
  assert.equal(priority.urgency, 0);
  assert.equal(priority.risk, 'normal');
});

test('date-only events are reminders and do not occupy invented time', () => {
  const p = Planner.planDay({ tasks: [task('exam', { kind: 'event', due: '2026-11-02', eventStatus: 'pending' })],
    settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.freeMinutes, 840);
  assert.equal(p.bufferMinutes, 0);
  assert.equal(p.blocks.length, 0);
  assert.equal(p.plannedMinutes, 0);
  assert.equal(p.events.length, 1);
  assert.equal(p.warnings.length, 0);
});

test('fixed event stays on its occurrence date and exact interval outside semester recurrence rules', () => {
  const exam = task('exam', { kind: 'event', due: '2031-04-09T15:00', eventEnd: '2031-04-09T17:00',
    eventStatus: 'pending', eventLocation: '考场 A' });
  const s = { ...settings, semesterStart: '2020-01-01', useDailyBudget: false };
  const early = Planner.planDay({ tasks: [exam], settings: s, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(early.blocks.length, 0);
  const occurrence = Planner.planDay({ tasks: [exam, task('work', { remaining: 1200 })], settings: s,
    date: '2031-04-09', now: at('2026-11-01') });
  const block = occurrence.blocks.find(b => b.kind === 'event');
  assert.equal(block.start, 900);
  assert.equal(block.end, 1020);
  assert.equal(block.eventId, 'exam');
  assert.equal(block.location, '考场 A');
  assert.equal(occurrence.freeMinutes, 700);
  assert.ok(occurrence.blocks.filter(b => b.kind === 'task').every(b => b.end <= 890 || b.start >= 1030));
});

test('future fixed events and their buffers reduce task deadline capacity', () => {
  const delivery = task('delivery', { totalMinutes: 1100, progress: 0, target: 100, due: '2026-11-03T20:00' });
  const event = task('interview', { kind: 'event', due: '2026-11-03T09:00', eventEnd: '2026-11-03T12:00', eventStatus: 'pending' });
  const options = { settings: { ...settings, useDailyBudget: false }, date: '2026-11-02', now: at('2026-11-01') };
  const baseline = Planner.planDay({ ...options, tasks: [delivery] });
  const fixed = Planner.planDay({ ...options, tasks: [delivery, event] });
  assert.equal(baseline.ranked[0].priority.risk, 'normal');
  assert.equal(fixed.ranked[0].priority.risk, 'tight');
  assert.equal(fixed.blocks.filter(b => b.kind === 'event').length, 0, 'future event is not moved to today');
});

test('pending precise event without an end warns without inventing duration', () => {
  const event = task('unbounded', { kind: 'event', due: '2026-11-02T16:00', eventEnd: '', eventStatus: 'pending' });
  const p = Planner.planDay({ tasks: [event], settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.freeMinutes, 840);
  assert.equal(p.blocks.length, 0);
  assert.equal(p.ranked.length, 0);
  assert.ok(p.warnings.some(w => w.includes('结束时间待补充') && w.includes('无法保证避开')));
});

test('missed or completed events are not caught up and attended intervals remain fixed', () => {
  const missed = task('missed', { kind: 'event', due: '2026-10-01T16:00', eventEnd: '', eventStatus: 'missed' });
  const complete = task('complete', { kind: 'event', due: '2026-11-02T08:00', eventEnd: '', eventStatus: 'completed' });
  const attended = task('attended', { kind: 'event', due: '2026-11-02T10:00', eventEnd: '2026-11-02T11:00', eventStatus: 'attended' });
  const p = Planner.planDay({ tasks: [complete, attended, missed], settings, date: '2026-11-02', now: at('2026-11-01') });
  assert.equal(p.ranked.length, 0);
  assert.equal(p.plannedMinutes, 0);
  assert.equal(p.warnings.length, 0);
  assert.deepEqual(p.events.map(e => e.id), ['missed', 'complete', 'attended']);
  assert.equal(p.blocks.length, 1);
  assert.equal(p.blocks[0].kind, 'event');
  assert.equal(p.blocks[0].eventId, 'attended');
});

test('actual fixed-event conflicts warn while mere buffer overlap does not', () => {
  const course = { id: 'math', title: '数学课', day: 1, start: '09:00', end: '10:00', weekMode: 'all' };
  const event = task('exam', { kind: 'event', title: '考试', due: '2026-11-02T09:30',
    eventEnd: '2026-11-02T10:30', eventStatus: 'pending' });
  const second = task('interview', { kind: 'event', title: '面试', due: '2026-11-02T10:15',
    eventEnd: '2026-11-02T11:00', eventStatus: 'pending' });
  const options = { courses: [course], settings, date: '2026-11-02', now: at('2026-11-01') };
  const conflict = Planner.planDay({ ...options, tasks: [event, second] });
  assert.ok(conflict.warnings.some(w => w.includes('考试') && w.includes('数学课') && w.includes('时间重叠')));
  assert.ok(conflict.warnings.some(w => w.includes('考试') && w.includes('面试') && w.includes('时间重叠')));
  const bufferOnly = Planner.planDay({ ...options, tasks: [{ ...event,
    due: '2026-11-02T10:05', eventEnd: '2026-11-02T10:30' }] });
  assert.ok(!bufferOnly.warnings.some(w => w.includes('时间重叠')));
});
