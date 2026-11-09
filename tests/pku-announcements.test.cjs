'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { extractDeadlines } = require('../pku-announcements.cjs');
const read = (body, extra = {}) => extractDeadlines({ title: '示例课程通知', body, publishedAt: '2026-11-09', ...extra });

test('explicit Chinese and numeric dates retain their stated precision', () => {
  assert.deepEqual(read('示例报告请于2026年11月12日提交。')[0], { due: '2026-11-12', excerpt: '示例报告请于2026年11月12日提交', dateNote: '' });
  assert.equal(read('提交截止日期：2026/11/12 23:59。')[0].due, '2026-11-12T23:59');
  assert.equal(read('Deadline: 2026-11-12T18:30。')[0].due, '2026-11-12T18:30');
  assert.equal(read('请于２０２６年１１月１２日下午三点半提交报告。')[0].due, '2026-11-12T15:30');
  assert.equal(read('2026年11月12日（周四）23:59截止。')[0].due, '2026-11-12T23:59');
  assert.equal(read('2026年11月12日提交报告，课堂于13:00开始。')[0].due, '2026-11-12');
  assert.equal(read('请在11月12日前完成示例报告。')[0].due, '2026-11-12');
  assert.equal(read('请在11月12日之前完成示例报告。')[0].due, '2026-11-12');
  assert.deepEqual(read('11月12日完成了示例报告。'), []);
});

test('time precision stays uncertain when the text leaves morning, noon or a timezone ambiguous', () => {
  assert.equal(read('2026年11月12日晚上八点交作业。')[0].due, '2026-11-12T20:00');
  assert.equal(read('2026年11月12日下午三点一刻提交。')[0].due, '2026-11-12T15:15');
  const ambiguous = read('2026年11月12日三点提交。')[0];
  assert.equal(ambiguous.due, '2026-11-12'); assert.match(ambiguous.dateNote, /上午或下午/);
  assert.equal(read('2026年11月12日晚上12点提交。')[0].due, '2026-11-12');
  assert.equal(read('Deadline: 2026-11-12 18:00 UTC。')[0].due, '2026-11-12');
  const midnight = read('2026年11月12日24:00截止。')[0];
  assert.equal(midnight.due, '2026-11-13T00:00'); assert.match(midnight.dateNote, /次日/);
});

test('missing years are inferred from reliable publication dates with a visible note and year rollover', () => {
  const value = read('11月12日23:59前提交。')[0];
  assert.equal(value.due, '2026-11-12T23:59'); assert.match(value.dateNote, /年份.*推断/);
  assert.equal(read('1月5日交作业。', { publishedAt: '2026-12-28' })[0].due, '2027-01-05');
  assert.equal(read('12月31日提交。', { publishedAt: '2027-01-02' })[0].due, '2026-12-31');
  assert.equal(read('11/12提交。')[0].due, '2026-11-12');
  const missing = read('11月12日提交。', { publishedAt: '' })[0];
  assert.equal(missing.due, ''); assert.match(missing.dateNote, /未写年份/);
});

test('relative dates use the publication day in Beijing rather than the reading day', () => {
  const rows = read('明天下午三点提交报告。下周三18:00交作业。本周五截止。', { now: Date.UTC(2030, 0, 1) });
  assert.deepEqual(rows.map(value => value.due), ['2026-11-10T15:00', '2026-11-18T18:00', '2026-11-13']);
  assert.ok(rows.every(value => /公告发布日/.test(value.dateNote)));
  assert.equal(read('明天提交。', { publishedAt: '2026-11-09T18:00:00Z' })[0].due, '2026-11-11');
  assert.equal(read('今晚8点提交。')[0].due, '2026-11-09T20:00');
  assert.equal(read('明天提交。', { publishedAt: 'unknown' })[0].due, '');
  assert.equal(read('周五提交。')[0].due, '');
});

test('publication, class, exam and opening dates do not become due dates', () => {
  assert.deepEqual(read('发布时间2026年11月9日。2026年11月12日上课。考试时间为2026年11月13日。'), []);
  assert.deepEqual(read('开放提交时间2026年11月10日。'), []);
  assert.deepEqual(read('2026年11月10日开始提交报告。'), []);
  assert.deepEqual(read('下周开始提交报告。'), []);
  const rows = read('2026年11月10日上课，2026年11月12日提交报告。');
  assert.deepEqual(rows.map(value => value.due), ['2026-11-12']);
  const withTitle = read('发布时间2026年11月9日。2026年11月12日23:59。', { title: '示例报告截止时间' });
  assert.deepEqual(withTitle.map(value => value.due), ['2026-11-12T23:59']);
  assert.deepEqual(read('11月12日期中考试。11月13日上课。', { title: '示例截止时间汇总' }), []);
  assert.deepEqual(read('11月12日18:00期中考试。', { title: '示例截止时间汇总' }), []);
  assert.equal(read('11月12日提交考试论文。', { title: '示例截止时间汇总' })[0].due, '2026-11-12');
});

test('each deadline is preserved while extensions select the replacement date', () => {
  const rows = read('示例一11月12日截止，示例二11月15日截止。');
  assert.deepEqual(rows.map(value => value.due), ['2026-11-12', '2026-11-15']);
  const moved = read('作业截止时间由11月12日延期至11月15日23:59。')[0];
  assert.equal(moved.due, '2026-11-15T23:59'); assert.match(moved.excerpt, /11月12日/); assert.match(moved.dateNote, /调整后/);
  assert.deepEqual(read('请于11月10日至11月12日提交报告。').map(value => value.due), ['2026-11-12']);
  assert.deepEqual(read('11月12日截止已取消，另行通知。').map(value => value.due), ['']);
  const independent = read('示例A11月12日截止，示例B由11月13日延期至11月15日。');
  assert.deepEqual(independent.map(value => value.due), ['2026-11-12', '2026-11-15']);
  assert.doesNotMatch(independent[0].dateNote, /调整后/); assert.match(independent[1].dateNote, /调整后/);
  assert.deepEqual(read('截止时间原定11/12，现延期到11/15。').map(value => value.due), ['2026-11-15']);
});

test('fuzzy and invalid dates remain editable candidates, without inventing a deadline', () => {
  const rows = read('请在下周提交报告。请于课前交作业。请在月底提交论文。');
  assert.equal(rows.length, 3); assert.ok(rows.every(value => value.due === '' && /补全日期/.test(value.dateNote)));
  assert.equal(read('2026年2月30日提交。')[0].due, '');
  assert.match(read('00月10日提交。')[0].dateNote, /日期无效/);
  assert.equal(read('2026年11月12日25:00截止。')[0].due, '2026-11-12');
  assert.equal(read('2028年2月29日截止。')[0].due, '2028-02-29');
  assert.equal(read('截止日期：\n11月12日23:59。')[0].due, '2026-11-12T23:59');
  assert.deepEqual(read('作业截止时间如下：\n示例A 11月12日\n示例B 11月15日').map(value => value.due), ['2026-11-12', '2026-11-15']);
  assert.deepEqual(read('作业截止时间如下：\n示例A 11月12日\n\n其他活动 11月15日').map(value => value.due), ['2026-11-12']);
  assert.equal(read('请于23:59前提交。')[0].due, '');
  assert.equal(read('截止时间待定。')[0].due, '');
  for (const invalid of ['2026-11-123', '2026年11月123日', '11月123日', '2026/11/123']) {
    assert.deepEqual(read(invalid + '提交。'), []);
  }
});

test('bounded inputs, repeated extraction and duplicate text stay deterministic', () => {
  const long = '11月12日截止。'.repeat(10000);
  const rows = read(long); assert.equal(rows.length, 1); assert.ok(rows.every(value => value.excerpt.length <= 1200 && value.dateNote.length <= 200));
  assert.deepEqual(read('请在下周提交。'), read('请在下周提交。'));
  assert.deepEqual(extractDeadlines({ title: null, body: {}, publishedAt: 100 }), []);
  const distant = read('相关说明'.repeat(1000) + '请于2026年11月12日提交。')[0];
  assert.ok(distant.excerpt.length <= 1200); assert.match(distant.excerpt, /2026年11月12日/);
});
