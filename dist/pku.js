(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./data.js'));
  else root.PlannerPKU = factory(root.PlannerData);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (D) {
  'use strict';
  const ENDPOINT = 'http://127.0.0.1:4174';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const plain = value => !!value && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  const cleanTitle = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const fail = message => ({ ok: false, errors: [message] });
  function titleProfile(value) {
    let text = value.normalize('NFKC').toLowerCase().trim().replace(/^[\s#*=~!！·•🔴\-–—]+/gu, '');
    text = text.replace(/^(?:(?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}日?|\d{1,2}[-/.月]\d{1,2}日?|(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01]))(?:\s*[:：\-–—.)、]\s*|\s+|(?=[a-z\u3400-\u9fff【\[(]))/i, '');
    const chinese = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    text = text.replace(/第([一二三四五六七八九十]{1,3})(?=[次章节周题])/g, (all, digits) => {
      if (digits.length === 1) return '第' + chinese[digits];
      if (digits[0] === '十' && digits.length === 2) return '第' + (10 + chinese[digits[1]]);
      if (digits[1] === '十') return '第' + (chinese[digits[0]] * 10 + (digits[2] ? chinese[digits[2]] : 0));
      return all;
    });
    const canonical = text.replace(/home\s*work|assignment|\bhw(?=\d|\b)/g, '作业')
      .replace(/laboratory|\blab(?=\d|\b)|实验/g, 'lab').replace(/quiz|exam|\btest(?=\d|\b)|考试|小测|测验/g, '考试')
      .replace(/(\d)[^\p{L}\p{N}]+(?=\d)/gu, '$1|').replace(/[^\p{L}\p{N}|]/gu, '');
    return { exact: cleanTitle(value), canonical };
  }
  function activity(text) {
    if (/lab|上机/.test(text)) return 'lab';
    if (/考试|期中|期末|测试/.test(text)) return 'exam';
    if (/作业|习题|练习/.test(text)) return 'homework';
    if (/论文|报告|paper|report/.test(text)) return 'paper';
    return '';
  }
  function numbers(text) { return (text.match(/\d+/g) || []).map(value => value.replace(/^0+(?=\d)/, '')).join('|'); }
  function topic(text) { return text.replace(/\d+|\||作业|习题|练习|考试|期中|期末|测试|lab|论文|报告|paper|report|课程|课后|课堂|本周|本次|书面|提交|完成|ddl|deadline|第|次|章节|章|周|题/g, ''); }
  function meaningful(text) { return /[\u3400-\u9fff]{3}/.test(text) || /[a-z]{6}/.test(text); }
  function grams(text) { const result = new Set(); for (let i = 1; i < text.length; i++) result.add(text.slice(i - 1, i + 1)); return result; }
  function similarity(a, b) { const aa = grams(a), bb = grams(b); let count = 0; for (const token of aa) if (bb.has(token)) count++; return aa.size + bb.size ? 2 * count / (aa.size + bb.size) : 0; }
  function courseForms(course) {
    const fragments = [course, course.replace(/[（(【\[][\s\S]*?[）)】\]]/g, '')];
    for (const match of course.matchAll(/[（(【\[]([^）)】\]]+)[）)】\]]/g)) fragments.push(match[1]);
    for (const match of course.matchAll(/(?:^|[^A-Za-z0-9])([A-Z]{2,8}(?:[- ]?\d{1,4})?)(?=$|[^A-Za-z0-9])/g)) fragments.push(match[1]);
    return Array.from(new Set(fragments.map(value => titleProfile(value).canonical).filter(value => value.length >= 2 && !/^\d+$/.test(value)))).sort((a, b) => b.length - a.length);
  }
  function stripCourse(text, forms) {
    for (const form of forms) if (text.startsWith(form)) {
      const rest = text.slice(form.length);
      if (/^[a-z]+$/.test(form) && /^[a-z]/.test(rest) && !/^(?:lab|hw|homework|assignment|quiz|exam|paper|report)/.test(rest)) continue;
      return { core: rest, course: true };
    }
    return { core: text, course: false };
  }
  function taskChoice(task) { return { id: task.id, title: task.title, due: task.due, progress: task.progress, done: task.done }; }
  function createCandidateIndex(tasks) {
    const profiles = tasks.map(task => ({ task, ...titleProfile(task.title), dueDay: task.due ? Date.parse(task.due.slice(0, 10) + 'T00:00:00Z') : null, courseCache: new Map() })), exact = new Map(), canonical = new Map(), topics = new Map(), courses = new Map(), forms = new Map();
    function add(index, key, profile) { if (!index.has(key)) index.set(key, []); index.get(key).push(profile); }
    for (const profile of profiles) {
      add(exact, profile.exact, profile); add(canonical, profile.canonical, profile);
      const content = topic(profile.canonical); if (meaningful(content)) for (const gram of grams(content)) add(topics, gram, profile);
    }
    return { profiles, exact, canonical, topics, courses, forms };
  }
  function findCandidates(item, index) {
    if (!index.forms.has(item.course)) index.forms.set(item.course, courseForms(item.course));
    const remote = titleProfile(item.title), displayed = titleProfile(item.displayTitle), forms = index.forms.get(item.course), remoteCore = stripCourse(remote.canonical, forms).core;
    const remoteActivity = activity(remoteCore), remoteNumbers = numbers(remoteCore), remoteTopic = topic(remoteCore), dueDay = item.due ? Date.parse(item.due.slice(0, 10) + 'T00:00:00Z') : null, pool = new Map();
    function include(values) { for (const value of values || []) pool.set(value.task.id, value); }
    include(index.exact.get(remote.exact)); include(index.exact.get(displayed.exact));
    include(index.canonical.get(remote.canonical)); include(index.canonical.get(displayed.canonical));
    const courseKey = JSON.stringify(forms);
    if (!index.courses.has(courseKey)) index.courses.set(courseKey, forms.length ? index.profiles.filter(profile => stripCourse(profile.canonical, forms).course) : []);
    include(index.courses.get(courseKey));
    if (meaningful(remoteTopic)) {
      const counts = new Map(); for (const gram of grams(remoteTopic)) for (const profile of index.topics.get(gram) || []) counts.set(profile, (counts.get(profile) || 0) + 1);
      for (const [profile, count] of counts) if (count >= 2) pool.set(profile.task.id, profile);
    }
    const result = [];
    for (const profile of pool.values()) {
      if (!profile.courseCache.has(courseKey)) { const stripped = stripCourse(profile.canonical, forms); profile.courseCache.set(courseKey, { ...stripped, activity: activity(stripped.core), numbers: numbers(stripped.core), topic: topic(stripped.core) }); }
      const stripped = profile.courseCache.get(courseKey), local = stripped.core, localActivity = stripped.activity, localNumbers = stripped.numbers, localTopic = stripped.topic, distance = profile.dueDay === null || dueDay === null ? null : Math.abs(profile.dueDay - dueDay) / 86400000;
      if ((remoteActivity === 'lab' || localActivity === 'lab') && remoteActivity !== localActivity || (remoteActivity === 'exam' || localActivity === 'exam') && remoteActivity !== localActivity) continue;
      const exact = profile.exact === remote.exact || profile.exact === displayed.exact;
      if (!exact && remoteNumbers && localNumbers && remoteNumbers !== localNumbers) continue;
      let score = 0, reason = '';
      if (exact) { score = 100; reason = '名称相同，请核对课程'; }
      else if ((local === remoteCore || profile.canonical === remote.canonical || profile.canonical === displayed.canonical) && (meaningful(remoteTopic) || stripped.course && remoteNumbers && remoteNumbers === localNumbers) && (distance === null || distance <= 21)) {
        score = 94; reason = '去除日期前缀、标点后名称一致';
      } else if (stripped.course && remoteActivity && remoteActivity === localActivity && remoteNumbers && remoteNumbers === localNumbers && (distance === null || distance <= 14)) {
        score = 88; reason = '课程、事项类型及编号一致';
      } else if (stripped.course && remoteActivity && remoteActivity === localActivity && distance === 0 && (!remoteNumbers || !localNumbers)) {
        score = 72; reason = '课程及事项类型相同、DDL 同日，需核对具体内容';
      } else if (meaningful(remoteTopic) && meaningful(localTopic) && (distance === null || distance <= 7) && similarity(remoteTopic, localTopic) >= 0.82) {
        score = 80; reason = '标题内容接近，请核对是否同一事项';
      }
      if (!score) continue;
      if (distance !== null && !reason.includes('DDL')) reason += distance === 0 ? '；DDL 同日' : '；DDL 相差 ' + distance + ' 天';
      result.push({ ...taskChoice(profile.task), match: exact ? 'exact' : 'similar', reason, score, distance });
    }
    return result.sort((a, b) => b.score - a.score || (a.distance === null ? Infinity : a.distance) - (b.distance === null ? Infinity : b.distance) || a.id.localeCompare(b.id)).slice(0, 6);
  }
  function validDue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value)) return false;
    const [year, month, day] = value.slice(0, 10).split('-').map(Number), date = new Date(year, month - 1, day, 12);
    return year >= 1900 && year <= 2200 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }
  function validAnnouncementUrl(value) {
    const match = /^https:\/\/course\.pku\.edu\.cn\/webapps\/blackboard\/execute\/announcement\?([^#]+)$/.exec(value);
    if (!match) return false;
    const params = Object.create(null);
    try {
      for (const pair of match[1].split('&')) {
        const split = pair.indexOf('='); if (split < 1) return false;
        const key = decodeURIComponent(pair.slice(0, split)), content = decodeURIComponent(pair.slice(split + 1));
        if (!['method', 'context', 'course_id'].includes(key) || own(params, key)) return false;
        params[key] = content;
      }
    } catch { return false; }
    return Object.keys(params).length === 3 && params.method === 'search' && params.context === 'course_entry' && /^_[A-Za-z0-9]+_\d+$/.test(params.course_id);
  }
  function normalizeItems(input) {
    if (!Array.isArray(input) || input.length > 5000) throw new Error('教学网返回的事项数量无效，请缩小同步范围。');
    const seen = new Set();
    return input.map(item => {
      if (!plain(item) || typeof item.sourceId !== 'string' || !/^[A-Za-z0-9:_-]{1,96}$/.test(item.sourceId) || seen.has(item.sourceId)) throw new Error('教学网事项的来源标识无效或重复。');
      seen.add(item.sourceId);
      const announcement = item.sourceKind === 'announcement';
      if (item.sourceKind !== undefined && !announcement) throw new Error('教学网事项来源类型无效。');
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 || typeof item.course !== 'string' || item.course.length > 200 || !(validDue(item.due) || announcement && item.due === '')) throw new Error('教学网事项的名称、课程或截止时间无效。');
      if (typeof item.sourceUrl !== 'string' || item.sourceUrl.length > 2000 || !/^https:\/\/course\.pku\.edu\.cn\/(?!\/)[^\s<>"\\]*$/.test(item.sourceUrl)) throw new Error('教学网事项来源地址无效。');
      if (announcement && !validAnnouncementUrl(item.sourceUrl)) throw new Error('公告来源必须是教学网的只读公告页面。');
      if (announcement && (item.excerpt !== undefined && (typeof item.excerpt !== 'string' || item.excerpt.length > 1200) || item.dateNote !== undefined && (typeof item.dateNote !== 'string' || item.dateNote.length > 200))) throw new Error('公告原文片段或日期提示无效。');
      const title = item.title.trim(), course = item.course.trim();
      return { sourceId: item.sourceId, title, course, due: item.due, sourceUrl: item.sourceUrl,
        displayTitle: (course ? '【' + course + '】' : '') + title,
        ...(announcement ? { sourceKind: 'announcement', excerpt: item.excerpt || '', dateNote: item.dateNote || '' } : {}) };
    });
  }
  function createPlan(state, input) {
    const checked = D.validateState(state); if (!checked.ok) return fail('当前任务数据无效，请先恢复本地数据。');
    let items; try { items = normalizeItems(input); } catch (error) { return fail(error.message); }
    const tasks = checked.value.tasks, linkable = tasks.filter(task => !D.isEvent(task) && !task.sourceGroup.startsWith('pku:'));
    const candidateIndex = createCandidateIndex(linkable);
    const rows = [];
    for (const item of items) {
      const group = 'pku:' + item.sourceId, linked = tasks.filter(task => task.sourceGroup === group);
      if (linked.length > 1) return fail('多个本地任务关联到同一教学网事项，请先整理重复关联。');
      const task = linked[0];
      if (task && D.isEvent(task)) return fail('教学网作业已被改为固定事件，请先解除关联或恢复为任务。');
      const candidates = task ? [] : findCandidates(item, candidateIndex);
      rows.push({ item, taskId: task ? task.id : '', beforeDue: task ? task.due : '', candidates,
        type: task ? (task.due === item.due ? 'unchanged' : 'update') : 'create' });
    }
    return { ok: true, errors: [], baseTasks: JSON.stringify(state.tasks), rows, linkableTasks: linkable.map(taskChoice) };
  }
  function reviseAnnouncement(state, plan, sourceId, changes) {
    if (!plan || !plan.ok || plan.baseTasks !== JSON.stringify(state.tasks)) return fail('任务已有更新，请重新读取 DDL 后再核对公告。');
    const row = plan.rows.find(entry => entry.item.sourceId === sourceId);
    if (!row || row.item.sourceKind !== 'announcement' || !plain(changes) || Object.keys(changes).some(key => !['title', 'due'].includes(key))) return fail('公告编辑无效。');
    const edited = createPlan(state, [{ ...row.item, ...changes }]); if (!edited.ok) return edited;
    return { ...plan, rows: plan.rows.map(entry => entry === row ? edited.rows[0] : entry) };
  }
  function applyPlan(state, plan, selections) {
    if (!plan || !plan.ok || !Array.isArray(plan.rows) || plan.baseTasks !== JSON.stringify(state.tasks)) return fail('任务已有更新，请重新读取 DDL 后再合并。');
    if (!Array.isArray(selections) || selections.length > plan.rows.length) return fail('同步选择无效。');
    const next = JSON.parse(JSON.stringify(state)), sources = new Set(), targets = new Set();
    let added = 0, updated = 0, linked = 0;
    for (const choice of selections) {
      if (!plain(choice) || typeof choice.sourceId !== 'string' || sources.has(choice.sourceId) || !(choice.targetId === null || typeof choice.targetId === 'string')) return fail('同步选择无效或重复。');
      sources.add(choice.sourceId);
      const row = plan.rows.find(entry => entry.item.sourceId === choice.sourceId); if (!row) return fail('所选教学网事项已失效，请重新读取。');
      if (row.item.sourceKind === 'announcement' && !validDue(row.item.due)) return fail('所选公告尚未填写有效的截止日期，请补充后确认。');
      const group = 'pku:' + row.item.sourceId;
      let task;
      if (row.taskId) {
        if (choice.targetId !== row.taskId) return fail('已关联事项应更新原任务。');
        task = next.tasks.find(entry => entry.id === row.taskId);
      } else if (choice.targetId !== null) {
        if (!Array.isArray(plan.linkableTasks) || !plan.linkableTasks.some(candidate => candidate.id === choice.targetId)) return fail('只能关联当前预览中可手选的本地任务。');
        task = next.tasks.find(entry => entry.id === choice.targetId);
      }
      if (task) {
        if (targets.has(task.id) || D.isEvent(task) || task.sourceGroup.startsWith('pku:') && task.sourceGroup !== group) return fail('一个本地任务只能关联一个教学网事项。');
        targets.add(task.id);
        if (task.due !== row.item.due) updated += 1;
        if (task.sourceGroup !== group) linked += 1;
        task.due = row.item.due; task.sourceGroup = group;
      } else {
        if (row.taskId || choice.targetId !== null) return fail('原任务不存在，请重新读取 DDL。');
        next.tasks.push({ id: D.id(), title: row.item.displayTitle.slice(0, 200), kind: 'task', category: '课业',
          due: row.item.due, progress: 0, target: 100, totalMinutes: null, importance: null, enjoyment: null,
          nextAction: '', flagged: false, sourceGroup: group });
        added += 1;
      }
    }
    const checked = D.validateState(next); if (!checked.ok) return fail(checked.errors.join(' '));
    return { ok: true, errors: [], value: checked.value, added, updated, linked };
  }
  function normalizeChallenge(value) {
    if (!plain(value) || typeof value.captchaRequired !== 'boolean' || !['none', 'sms', 'otp'].includes(value.mode)) return null;
    const result = { captchaRequired: value.captchaRequired, mode: value.mode };
    if (value.captchaImage && typeof value.captchaImage === 'string' && value.captchaImage.length < 500000 && /^data:image\/(?:png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(value.captchaImage)) result.captchaImage = value.captchaImage;
    return result;
  }
  async function request(options) {
    const { path, method = 'GET', body, signal } = options;
    const key = typeof options.key === 'string' ? options.key.trim() : '';
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new Error('请先输入连接器窗口显示的配对码。');
    if (!['GET /api/pku/status', 'POST /api/pku/sync', 'POST /api/pku/sms', 'DELETE /api/pku/credentials'].includes(method + ' ' + path)) throw new Error('同步操作无效。');
    let response;
    try { response = await (options.fetchImpl || globalThis.fetch)(ENDPOINT + path, { method, signal, credentials: 'omit', redirect: 'error',
      headers: { Authorization: 'Bearer ' + key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }); }
    catch (error) { if (signal && signal.aborted) throw new Error('已取消同步。'); throw new Error('无法连接本机同步服务。请先运行“启动教学网同步.cmd”，并允许浏览器访问本地网络。'); }
    const text = await response.text(); if (text.length > 2 * 1024 * 1024) throw new Error('同步响应过大，请稍后重试。');
    let value; try { value = JSON.parse(text); } catch { throw new Error('本机同步服务响应无效。'); }
    if (!plain(value)) throw new Error('本机同步服务响应无效。');
    if (!response.ok) {
      let message = typeof value.error === 'string' && value.error.length <= 500 ? value.error : '教学网同步失败，请重试。';
      for (const secret of [key, body && body.password, body && body.username].filter(Boolean)) message = message.split(secret).join('[已隐藏]');
      const error = new Error(message); error.status = response.status;
      if (response.status === 409) error.challenge = normalizeChallenge(value.challenge);
      throw error;
    }
    return value;
  }
  return { ENDPOINT, createPlan, reviseAnnouncement, applyPlan, normalizeItems, normalizeChallenge, request };
});
