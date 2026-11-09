'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAnnouncementPage, parseCurrentCourses } = require('../pku-announcement-page.cjs');

test('course discovery uses current-course internal IDs and rejects foreign links', () => {
  const page = `<div class="portlet"><span class="moduleTitle">当前课程</span><ul class="courseListing">
    <li><a href="/webapps/blackboard/execute/launcher?key=_123_1,abc&amp;type=Course">示例课程 &amp; 实验</a></li>
    <li><a href="https://evil.example/launcher?key=_456_1,abc">不应读取</a></li>
    <li><a href="/webapps/blackboard/execute/launcher?type=Course&amp;id=_789_1">示例专题</a></li></ul></div>
    <div class="portlet"><span class="moduleTitle">以往课程</span><ul class="courseListing"><li><a href="/launcher?key=_888_1,abc">旧课程</a></li></ul></div>`;
  assert.deepEqual(parseCurrentCourses(page), { recognized: true, courses: [{ id: '_123_1', name: '示例课程 & 实验' }, { id: '_789_1', name: '示例专题' }], skipped: 1 });
  assert.deepEqual(parseCurrentCourses('<html>layout changed</html>'), { recognized: false, courses: [], skipped: 0 });
});

test('announcement text preserves separate paragraphs and separates publication metadata', () => {
  const result = parseAnnouncementPage(`<ul id="announcementList"><li id="_demo_1" class="clearfix">
    <h3>示例 &lt;报告&gt; &#x4F5C;&#19994;</h3><div class="details"><div class="vtbegenerated"><p>请于2026年11月12日提交报告。</p><p>第二份练习11月15日截止。</p></div></div>
    <div class="announcementInfo"><p>发布时间：2026年11月09日 12:00</p><p>由示例教师发布</p></div></li></ul>`);
  assert.equal(result.recognized, true); assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, '_demo_1'); assert.equal(result.items[0].title, '示例 <报告> 作业');
  assert.equal(result.items[0].publishedAt, '2026-11-09');
  assert.match(result.items[0].body, /报告。\n第二/); assert.doesNotMatch(result.items[0].body, /教师|发布时间/);
});

test('script-shaped list markup, controls and attachment content are never read as announcements', () => {
  const result = parseAnnouncementPage(`<script>const fake = '</div><ul id="announcementList"><li><h3>fake</h3></li></ul>';</script>
    <ul id="announcementList"><li><h3>正常通知</h3><div class="details"><p>请于2026-11-12提交作业。</p>
    <script>请于2026-11-15提交机密</script><form>请于2026-11-16提交表单</form><iframe src="https://evil.example">外站内容</iframe>
    <a href="https://evil.example/file.pdf">附件</a></div></li></ul>`);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].title, '正常通知');
  assert.doesNotMatch(result.items[0].body, /机密|表单|外站/);
});

test('empty known pages and unsupported layouts are distinguished without guessing a publication date', () => {
  assert.deepEqual(parseAnnouncementPage('<ul id="announcementList"></ul>'), { recognized: true, items: [], skipped: 0 });
  assert.deepEqual(parseAnnouncementPage('<html>nothing</html>'), { recognized: false, items: [], skipped: 0 });
  const result = parseAnnouncementPage('<ul id="announcementList"><li><h3>示例</h3><div class="details"><p>11月12日提交。</p></div><div class="announcementInfo"><p>11月09日</p></div></li><li>unknown</li></ul>');
  assert.equal(result.items[0].publishedAt, null); assert.equal(result.items[0].id, ''); assert.equal(result.skipped, 1);
});

test('English publication labels and explicit time attributes are recognized', () => {
  const template = meta => '<ul id="announcementList"><li><h3>Demo</h3><div class="details">Submit tomorrow.</div><div class="announcementInfo">' + meta + '</div></li></ul>';
  assert.equal(parseAnnouncementPage(template('<p>Posted on: Monday, November 9, 2026</p>')).items[0].publishedAt, '2026-11-09');
  assert.equal(parseAnnouncementPage(template('<p>发布时间：<time datetime="2026-11-09T12:00:00+08:00">today</time></p>')).items[0].publishedAt, '2026-11-09T12:00:00+08:00');
  assert.equal(parseAnnouncementPage(template('<p>提交截止：<time datetime="2026-11-12">deadline</time></p>')).items[0].publishedAt, null);
  assert.equal(parseAnnouncementPage(template('<p>本次作业已发布，提交截止<time datetime="2026-11-20">11月20日</time>，请明天完成初稿。</p>')).items[0].publishedAt, null);
  assert.equal(parseAnnouncementPage(template('<p>提交截止<time datetime="2026-11-20">11月20日</time>；发布时间：2026年11月09日</p>')).items[0].publishedAt, '2026-11-09');
});

test('nonempty unsupported lists and oversized announcement bodies are reported as unread', () => {
  assert.equal(parseAnnouncementPage('<ul id="announcementList"><div><li>changed structure</li></div></ul>').recognized, false);
  const courses = parseCurrentCourses('<div class="portlet"><span class="moduleTitle">Current courses</span><ul class="courseListing"><li><a href="/new/course/123">Demo</a></li></ul></div>');
  assert.equal(courses.recognized, false); assert.equal(courses.skipped, 1);
  const page = parseAnnouncementPage('<ul id="announcementList"><li><h3>Demo</h3><div class="details">' + 'x'.repeat(50001) + '</div></li></ul>');
  assert.equal(page.items.length, 0); assert.equal(page.skipped, 1);
});

test('page parser has explicit size and nesting limits', () => {
  assert.throws(() => parseAnnouncementPage('x'.repeat(4 * 1024 * 1024 + 1)), /limit/);
  assert.throws(() => parseAnnouncementPage('<div>'.repeat(250)), /limit/);
});
