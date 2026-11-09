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
  function validDue(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value)) return false;
    const [year, month, day] = value.slice(0, 10).split('-').map(Number), date = new Date(year, month - 1, day, 12);
    return year >= 1900 && year <= 2200 && date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  }
  function normalizeItems(input) {
    if (!Array.isArray(input) || input.length > 5000) throw new Error('教学网返回的事项数量无效，请缩小同步范围。');
    const seen = new Set();
    return input.map(item => {
      if (!plain(item) || typeof item.sourceId !== 'string' || !/^[A-Za-z0-9:_-]{1,96}$/.test(item.sourceId) || seen.has(item.sourceId)) throw new Error('教学网事项的来源标识无效或重复。');
      seen.add(item.sourceId);
      if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 || typeof item.course !== 'string' || item.course.length > 200 || !validDue(item.due)) throw new Error('教学网事项的名称、课程或截止时间无效。');
      if (typeof item.sourceUrl !== 'string' || item.sourceUrl.length > 2000 || !/^https:\/\/course\.pku\.edu\.cn\/(?!\/)[^\s<>"\\]*$/.test(item.sourceUrl)) throw new Error('教学网事项来源地址无效。');
      const title = item.title.trim(), course = item.course.trim();
      return { sourceId: item.sourceId, title, course, due: item.due, sourceUrl: item.sourceUrl,
        displayTitle: (course ? '【' + course + '】' : '') + title };
    });
  }
  function createPlan(state, input) {
    const checked = D.validateState(state); if (!checked.ok) return fail('当前任务数据无效，请先恢复本地数据。');
    let items; try { items = normalizeItems(input); } catch (error) { return fail(error.message); }
    const tasks = checked.value.tasks;
    const rows = [];
    for (const item of items) {
      const group = 'pku:' + item.sourceId, linked = tasks.filter(task => task.sourceGroup === group);
      if (linked.length > 1) return fail('多个本地任务关联到同一教学网事项，请先整理重复关联。');
      const task = linked[0];
      if (task && D.isEvent(task)) return fail('教学网作业已被改为固定事件，请先解除关联或恢复为任务。');
      const titles = [item.title, item.displayTitle].map(cleanTitle);
      const candidates = task ? [] : tasks.filter(candidate => !D.isEvent(candidate) && !candidate.sourceGroup.startsWith('pku:') && titles.includes(cleanTitle(candidate.title)))
        .map(candidate => ({ id: candidate.id, title: candidate.title, due: candidate.due }));
      rows.push({ item, taskId: task ? task.id : '', beforeDue: task ? task.due : '', candidates,
        type: task ? (task.due === item.due ? 'unchanged' : 'update') : 'create' });
    }
    return { ok: true, errors: [], baseTasks: JSON.stringify(state.tasks), rows };
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
      const group = 'pku:' + row.item.sourceId;
      let task;
      if (row.taskId) {
        if (choice.targetId !== row.taskId) return fail('已关联事项应更新原任务。');
        task = next.tasks.find(entry => entry.id === row.taskId);
      } else if (choice.targetId !== null) {
        if (!row.candidates.some(candidate => candidate.id === choice.targetId)) return fail('只能关联预览中列出的同名任务。');
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
  return { ENDPOINT, createPlan, applyPlan, normalizeItems, normalizeChallenge, request };
});
