(function () {
  'use strict';
  const P = window.Planner, D = window.PlannerData, A = window.PlannerAI, K = window.PlannerPKU;
  const $ = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
  const weekdayOrder = [1, 2, 3, 4, 5, 6, 0];
  const time = min => String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(Math.round(min % 60)).padStart(2, '0');
  const percent = n => Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%';
  const optionalNumber = value => value === '' || value == null ? null : Number(value);
  const durationText = value => value == null ? '待估时' : P.formatMinutes(value);
  function missingFields(task) {
    return [['totalMinutes', '预计时长'], ['progress', '当前进度'], ['target', '本轮目标'], ['importance', '重要性'], ['enjoyment', '愉悦性']].filter(pair => task[pair[0]] == null).map(pair => pair[1]);
  }
  function stageText(task) {
    return (task.progress == null ? '进度待填写' : percent(task.progress)) + ' → ' + (task.target == null ? '目标待设置' : percent(task.target));
  }
  function taskSourceLabel(task) { return task.sourceGroup.startsWith('pku:') ? '北大教学网' : task.sourceGroup; }
  function rememberImportHistory(candidate) {
    const bundled = window.PlannerImports && Array.isArray(window.PlannerImports.batches) ? window.PlannerImports.batches.map(batch => batch.id).filter(Boolean) : [];
    candidate.appliedBatches = Array.from(new Set([...(state.appliedBatches || []), ...(candidate.appliedBatches || []), ...bundled]));
    candidate.appliedMigrations = Array.from(new Set([...(state.appliedMigrations || []), ...(candidate.appliedMigrations || []), D.TASK_PROGRESS_DEFAULTS_MIGRATION_ID]));
    return candidate;
  }
  let selectedDate = P.localDate(), logDate = P.localDate(), currentView = 'live', state, confirmCallback, toastTimer, imageURL;
  let lastSaved = true, lastPlan, storageLocked = false, protectedRaw = null, storageReadError = false, initializeStorage = false, persistEventMigration = false;
  let taskListView = 'table', tableRowIds = [];
  const tableDrafts = new Map(), tableErrors = new Map();
  const tableLabels = { dueDate: '日期', dueTime: '时刻', eventEnd: '结束时刻', totalMinutes: '整体预计分钟', progress: '当前进度', target: '本轮目标', importance: '重要性', enjoyment: '愉悦性' };
  let aiPending = null, aiController = null, aiRequestVersion = 0;
  let pkuPending = null, pkuController = null, pkuRequestVersion = 0, pkuChallenge = null;
  let pkuRememberKnown = false, pkuRememberTouched = false, pkuRememberKey = '';

  function notify(message) {
    $('toast').textContent = message; $('toast').hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
  }
  function load() {
    let raw;
    try {
      raw = localStorage.getItem(D.STORAGE_KEY);
    } catch (error) {
      storageLocked = true; storageReadError = true; lastSaved = false;
      setTimeout(() => notify('读取本地数据失败，已暂停写入。请先恢复浏览器存储权限，再重新打开。'), 100);
      return D.createDemo(P.localDate());
    }
    if (raw === null) { initializeStorage = true; lastSaved = false; return D.emptyState(P.localDate()); }
    try {
      const input = JSON.parse(raw), checked = D.validateState(input);
      if (checked.ok) {
        persistEventMigration = input.tasks.some((task, index) => task.kind == null && D.isEvent(checked.value.tasks[index]));
        return checked.value;
      }
    } catch (error) { /* Invalid JSON is protected just like an unsupported schema. */ }
    storageLocked = true; protectedRaw = raw; lastSaved = false;
    setTimeout(() => notify('原始本地数据已保留，当前仅作演示预览，暂停写入。可先导出原始数据。'), 100);
    return D.createDemo(P.localDate());
  }
  function renderStorageStatus() {
    $('storage-status').textContent = storageLocked ? (storageReadError ? '读取异常，已暂停写入' : '原数据已保留，暂停写入') : lastSaved ? '已保存在当前浏览器' : '暂未保存，请导出备份';
  }
  function save(candidate, replaceProtectedData) {
    if (storageLocked && !replaceProtectedData) return '本地数据保护中，暂停修改。请先导出原始数据，或明确选择清空、导入替换。';
    try { localStorage.setItem(D.STORAGE_KEY, JSON.stringify(candidate)); }
    catch (error) {
      lastSaved = false; renderStorageStatus();
      const message = storageLocked ? '替换保存失败，原数据仍受保护，尚未解除暂停写入。' : '保存失败，请先导出备份；当前更改仍保留在本页。';
      notify(message); return message;
    }
    lastSaved = true;
    if (replaceProtectedData) { storageLocked = false; protectedRaw = null; storageReadError = false; }
    renderStorageStatus(); return '';
  }
  function commit(candidate, options) {
    const replaceProtectedData = !!(options && options.replaceProtectedData);
    if (storageLocked && !replaceProtectedData) return '本地数据保护中，暂停修改。请先导出原始数据，或明确选择清空、导入替换。';
    const checked = D.validateState(candidate);
    if (!checked.ok) return checked.errors.join(' ');
    checked.value.logs = D.pruneLogs(checked.value.logs, P.localDate()).logs;
    const wasLocked = storageLocked, error = save(checked.value, replaceProtectedData);
    if (wasLocked && error) return error;
    if (replaceProtectedData) { tableDrafts.clear(); tableErrors.clear(); $('task-table-error').textContent = ''; $('task-table-status').textContent = ''; }
    state = checked.value; render(options); return error;
  }
  function mutate(fn, options) {
    const next = JSON.parse(JSON.stringify(state)); fn(next);
    const error = commit(next, options); if (error) notify(error); return !error;
  }
  function ask(title, message, accept, callback) {
    $('confirm-title').textContent = title; $('confirm-message').textContent = message;
    $('confirm-accept').textContent = accept; confirmCallback = callback; $('confirm-dialog').showModal();
  }
  function go(view) {
    currentView = ['live', 'tasks', 'logs', 'courses', 'settings'].includes(view) ? view : 'live';
    document.querySelectorAll('.view').forEach(node => { const active = node.id === 'view-' + currentView; node.hidden = !active; node.classList.toggle('active', active); });
    document.querySelectorAll('[data-view]').forEach(node => { const active = node.dataset.view === currentView; node.classList.toggle('active', active); if (active) node.setAttribute('aria-current', 'page'); else node.removeAttribute('aria-current'); });
    history.replaceState(null, '', '#' + currentView); if (currentView === 'settings') renderSettings();
  }
  function dueText(task) {
    if (D.isEvent(task)) return eventTimeText(task);
    if (!task.due) return '暂无 DDL';
    if (task.due.length === 10) {
      const today = P.localDate(), label = task.due.slice(5).replace('-', '/');
      return (task.due < today && !D.taskMetrics(task).done ? '已过截止日 · ' : task.due === today ? '今天截止 · ' : 'DDL ') + label + '（时刻待确认）';
    }
    const due = new Date(task.due), diff = due - new Date();
    const dateLabel = task.due.slice(5, 10).replace('-', '/') + ' ' + task.due.slice(11);
    if (diff < 0 && task.progress < 100) return '已逾期 · ' + dateLabel;
    if (diff >= 0 && diff < 86400000) return '距 DDL ' + P.formatMinutes(Math.ceil(diff / 60000));
    return 'DDL ' + dateLabel;
  }
  function eventTimeText(event) {
    if (!event.due) return '发生日期 / 时刻待填写';
    const label = event.due.slice(5, 10).replace('-', '/');
    if (event.due.length === 10) return label + ' · 具体时刻待确认';
    return label + ' ' + event.due.slice(11) + (event.eventEnd ? '—' + (event.eventEnd.slice(0, 10) === event.due.slice(0, 10) ? '' : event.eventEnd.slice(5, 10).replace('-', '/') + ' ') + event.eventEnd.slice(11) : ' · 结束时刻待确认');
  }
  function eventHasOccurred(event) {
    return !!event.due && (event.due.length === 10 ? event.due <= P.localDate() : new Date(event.due).getTime() <= Date.now());
  }
  function eventStateText(event) {
    if (event.eventStatus === 'attended') return '已参加';
    if (event.eventStatus === 'missed') return '未参加';
    return eventHasOccurred(event) ? '待确认参加状态' : '待发生';
  }
  function attendanceLog(event) {
    const date = event.due ? event.due.slice(0, 10) : P.localDate();
    if (date < D.pruneLogs([], P.localDate()).cutoff) return null;
    const checked = validateWorkLog({ id: D.id(), taskId: event.id, taskTitle: event.title, date, minutes: null, at: new Date().toISOString(), fromProgress: null, toProgress: null, status: 'completed', note: '已确认参加该固定事件。', startedAt: '', endedAt: '' });
    return checked.ok ? checked.value : null;
  }
  function eventActions(event) {
    return '<button class="text-button" data-action="edit-task" data-id="' + esc(event.id) + '">编辑时间 / 地点</button>' + (event.eventStatus === 'pending' ? '<button class="text-button" data-action="attend-event" data-id="' + esc(event.id) + '"' + (eventHasOccurred(event) ? '' : ' disabled') + '>' + (eventHasOccurred(event) ? '确认已参加' : '等待发生') + '</button>' : '');
  }
  function renderEvents() {
    const pending = state.tasks.filter(task => D.isEvent(task) && task.eventStatus === 'pending').sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    $('event-reminders').hidden = !pending.length;
    $('event-reminder-list').innerHTML = pending.map(event => '<article class="event-card"><div class="event-date">' + (event.due ? event.due.slice(5, 10).replace('-', '/') : '时间待定') + '</div><h3>' + (event.flagged ? '🔴 ' : '') + esc(event.title) + '</h3><p class="event-meta">' + esc(eventTimeText(event)) + (event.eventLocation ? ' · ' + esc(event.eventLocation) : '') + '</p><span class="tag">' + eventStateText(event) + '</span><div class="event-actions">' + eventActions(event) + '</div></article>').join('');
  }
  function progressMarkup(task) {
    const known = task.progress != null;
    return '<div class="progress-track"' + (known ? ' role="progressbar" aria-label="' + esc(task.title) + '整体完成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + task.progress + '"' : ' aria-label="整体进度尚未填写"') + '><span class="progress-fill" style="width:' + (known ? task.progress : 0) + '%"></span>' + (task.target != null ? '<span class="target-marker" style="left:' + Math.min(99.5, task.target) + '%" aria-hidden="true"></span>' : '') + '</div><div class="progress-legend"><span>' + (known ? '已完成 <b>' + percent(task.progress) + '</b>' : '进度待填写') + '</span><span>' + (task.target != null ? '本轮目标 ' + percent(task.target) : '本轮目标待设置') + '</span></div>';
  }
  function riskMarkup(priority) {
    if (!priority || priority.risk === 'normal') return '';
    return '<span class="risk-tag ' + priority.risk + '">' + (priority.risk === 'overdue' ? '已逾期' : '截止风险') + '</span>';
  }
  function emptyMarkup(title, detail, action, button) {
    return '<div class="empty-state"><span class="empty-symbol" aria-hidden="true">↗</span><h3>' + esc(title) + '</h3><p>' + esc(detail) + '</p>' + (action ? '<button class="button secondary" data-action="' + action + '">' + esc(button) + '</button>' : '') + '</div>';
  }
  function renderLive() {
    const spentMinutes = state.logs.filter(log => log.date === selectedDate).reduce((sum, log) => sum + (log.minutes || 0), 0);
    const plan = P.planDay({ tasks: state.tasks, courses: state.courses, settings: state.settings, date: selectedDate, now: new Date(), spentMinutes });
    lastPlan = plan;
    const today = selectedDate === P.localDate();
    $('plan-date').value = selectedDate;
    $('free-value').textContent = P.formatMinutes(spentMinutes);
    const nearestDue = state.tasks.filter(task => !D.isEvent(task) && !D.taskMetrics(task).done && task.due).sort((a, b) => a.due.localeCompare(b.due))[0];
    $('planned-value').textContent = nearestDue ? nearestDue.due.slice(5, 10).replace('-', '/') : '暂无';
    $('budget-label').textContent = nearestDue ? '按已填写的截止日期提醒' : '填写 DDL 后显示';
    $('active-value').textContent = plan.ranked.length + ' 件';
    const reached = state.tasks.filter(task => !D.isEvent(task) && D.taskMetrics(task).stageReached && !D.taskMetrics(task).done);
    $('stages-label').textContent = reached.length ? reached.length + ' 件本轮已达标' : '阶段目标可编辑';
    $('ranking-update').textContent = today ? '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '预览 ' + selectedDate.slice(5).replace('-', '/');
    $('ranking-title').textContent = today ? '任务实时榜' : '当天任务榜 · 预览';
    $('schedule-title').textContent = today ? '今天的时间安排' : selectedDate.slice(5).replace('-', '/') + ' 的时间安排';
    const week = P.getWeek(selectedDate, state.settings.semesterStart);
    $('week-label').textContent = week >= 1 && week <= state.settings.semesterWeeks ? '第 ' + week + ' 周' : '学期外';
    const first = plan.ranked[0];
    if (first) {
      const slot = plan.blocks.find(b => b.kind === 'task' && b.taskId === first.id);
      const workloadKnown = first.remaining != null;
      $('next-recommendation').innerHTML = '<div class="recommendation"><div class="recommendation-kicker"><span class="live-dot"></span>' + (today ? '当前优先任务' : '当天优先任务') + riskMarkup(first.priority) + (first.flagged ? '<span class="risk-tag overdue">重点标记</span>' : '') + '</div><h3 class="recommendation-title">' + esc(first.title) + '</h3><p class="recommendation-action">' + esc(first.nextAction || (workloadKnown ? '按建议时间块执行，并记录实际进度。' : '补充预计用时和阶段目标后生成时间安排。')) + '</p><div class="recommendation-meta"><span>' + stageText(first) + ' · ' + (workloadKnown ? '本轮约 ' + durationText(first.remaining) : '预计时长待补充') + '</span><span>' + (slot ? '建议 ' + time(slot.start) + ' 开始' : workloadKnown ? '当天暂无可安排空档' : '暂按 DDL 排序') + '</span></div><button class="button primary" data-action="' + (workloadKnown ? 'progress' : 'edit-task') + '" data-id="' + esc(first.id) + '">' + (workloadKnown ? '更新进度 ↗' : '补充任务参数 ↗') + '</button></div>';
    } else $('next-recommendation').innerHTML = '';
    $('ranking-list').innerHTML = plan.ranked.length ? plan.ranked.map((task, index) => {
      const priority = task.priority, allocated = plan.allocations[task.id] || 0;
      const missing = missingFields(task), workloadKnown = task.remaining != null;
      return '<article class="rank-card"><div class="rank-top"><span class="rank-number">' + String(index + 1).padStart(2, '0') + '</span><div class="task-main"><div class="task-title">' + esc(task.title) + '</div><div class="task-meta"><span class="task-category">' + esc(task.category) + '</span><span>' + esc(dueText(task)) + '</span>' + riskMarkup(priority) + (task.flagged ? '<span class="risk-tag overdue">重点标记</span>' : '') + '</div></div><span class="score-pill">' + (priority.provisional ? '≈' : '') + Number(priority.score).toFixed(1) + '<small>' + (priority.provisional ? '暂定优先分' : '优先分') + '</small></span></div>' + progressMarkup(task) + '<div class="rank-bottom"><div><p class="rank-reason">' + esc(priority.reason) + '</p><span class="muted small">自动紧急 ' + Number(priority.urgency).toFixed(1) + '/5 · ' + (workloadKnown ? '本轮约 ' + durationText(task.remaining) + ' · 当天安排 ' + P.formatMinutes(allocated) : '待补充：' + esc(missing.join('、'))) + '</span></div><div class="rank-actions"><button class="text-button" data-action="' + (workloadKnown ? 'progress' : 'edit-task') + '" data-id="' + esc(task.id) + '">' + (workloadKnown ? '更新进度' : '补充参数') + '</button><button class="icon-button" data-action="edit-task" data-id="' + esc(task.id) + '" aria-label="编辑' + esc(task.title) + '">⋯</button></div></div></article>';
    }).join('') : emptyMarkup(state.tasks.some(task => !D.isEvent(task)) ? '本轮无待推进任务。' : '没有可推进任务。', state.tasks.some(task => !D.isEvent(task)) ? '当前阶段目标已完成。提高目标可重新加入排序。' : '固定事件按发生时间提醒。备考或准备任务可单独添加。', 'new-task', '添加可推进任务');
    $('stage-reached-list').innerHTML = reached.length ? '<div class="stage-heading">本轮已达标 · ' + reached.length + '</div>' + reached.map(task => '<div class="stage-card"><div><strong>' + esc(task.title) + '</strong><span class="muted small">已到 ' + percent(task.progress) + ' · 整体尚未完成</span></div><button class="text-button" data-action="progress" data-id="' + esc(task.id) + '">设置下一目标 ↗</button></div>').join('') : '';
    const unknownCount = plan.ranked.filter(task => task.remaining == null).length;
    const dateOnlyCount = plan.ranked.filter(task => task.due && task.due.length === 10).length;
    $('plan-warnings').innerHTML = (unknownCount ? '<div class="warning">' + unknownCount + ' 件任务尚未填写估时、进度或本轮目标，已参与 DDL 排名，暂未安排时间块。</div>' : '') + (dateOnlyCount ? '<div class="warning">仅日期的 DDL 暂按当天结束估算。具体提交或考试时刻尚待确认，可在编辑任务中补充。</div>' : '') + plan.warnings.map(w => '<div class="warning">' + esc(w) + '</div>').join('');
    $('schedule-list').innerHTML = plan.blocks.length ? plan.blocks.map(block => '<div class="schedule-block ' + block.kind + '"><div class="schedule-time">' + time(block.start) + '<span>' + time(block.end) + '</span></div><div class="schedule-content"><div class="schedule-title">' + esc(block.title) + '</div><div class="schedule-meta">' + (block.kind === 'course' || block.kind === 'event' ? (block.kind === 'event' ? '固定事件' : '固定安排') + (block.location ? ' · ' + esc(block.location) : '') : block.kind === 'break' ? '段间休息' : P.formatMinutes(block.end - block.start) + (block.nextAction ? ' · ' + esc(block.nextAction) : '')) + '</div>' + (block.kind === 'task' ? '<button class="text-button schedule-action" data-action="progress" data-id="' + esc(block.taskId) + '" data-minutes="' + (block.end - block.start) + '">记录这一段 ↗</button>' : '') + '</div></div>').join('') : emptyMarkup('暂时没有时间块', '添加任务和课表，或换一天查看安排。');
    renderEvents();
  }
  function filteredTasks() {
    const mode = $('task-filter').value;
    return state.tasks.filter(task => { const m = D.taskMetrics(task); return mode === 'all' || (mode === 'events' ? D.isEvent(task) : mode === 'done' ? m.done : mode === 'reached' ? m.stageReached && !m.done : !m.done); });
  }
  function renderTasks(options) {
    if (!storageLocked) taskListView = state.settings.taskView;
    $('task-table-panel').hidden = taskListView !== 'table'; $('task-list').hidden = taskListView !== 'cards';
    $('task-table-toggle').setAttribute('aria-pressed', taskListView === 'table' ? 'true' : 'false');
    $('task-cards-toggle').setAttribute('aria-pressed', taskListView === 'cards' ? 'true' : 'false');
    const tasks = filteredTasks();
    tasks.sort((a, b) => P.getTaskPriority(b, state.settings, new Date()).score - P.getTaskPriority(a, state.settings, new Date()).score);
    $('task-list').innerHTML = tasks.length ? tasks.map(task => {
      const m = D.taskMetrics(task);
      if (D.isEvent(task)) return '<article class="task-card event-card"><div class="task-card-top"><span class="task-category">固定事件 · ' + esc(task.category) + '</span><span class="tag">' + eventStateText(task) + '</span></div><h3>' + (task.flagged ? '🔴 ' : '') + esc(task.title) + '</h3><p class="event-meta">' + esc(eventTimeText(task)) + (task.eventLocation ? ' · ' + esc(task.eventLocation) : '') + '</p>' + (task.nextAction ? '<p class="task-next">' + esc(task.nextAction) + '</p>' : '') + '<p class="muted small">按固定时间参加；备考或准备工作可另外创建任务。</p><div class="task-actions">' + eventActions(task) + '<button class="text-button danger-text" data-action="delete-task" data-id="' + esc(task.id) + '">删除</button></div></article>';
      return '<article class="task-card"><div class="task-card-top"><span class="task-category">' + esc(task.category) + '</span><span class="tag">' + (m.done ? '全部完成' : m.stageReached ? '本轮已达标' : m.remaining == null ? '待补充参数' : '进行中') + '</span></div><h3>' + (task.flagged ? '🔴 ' : '') + esc(task.title) + '</h3><p class="task-meta">' + esc(dueText(task)) + '</p>' + progressMarkup(task) + '<p class="task-next">' + esc(task.nextAction || '未设置下一步行动。') + '</p><div class="muted small">整体预计 ' + durationText(task.totalMinutes) + ' · 本轮 ' + durationText(m.remaining) + (task.sourceGroup ? ' · ' + esc(taskSourceLabel(task)) : '') + '</div><div class="task-actions"><button class="button secondary" data-action="' + (m.remaining == null ? 'edit-task' : 'progress') + '" data-id="' + esc(task.id) + '">' + (m.remaining == null ? '补充参数' : m.stageReached && !m.done ? '设置下一目标' : '更新进度') + '</button><button class="text-button" data-action="edit-task" data-id="' + esc(task.id) + '">编辑</button><button class="text-button danger-text" data-action="delete-task" data-id="' + esc(task.id) + '">删除</button></div></article>';
    }).join('') : emptyMarkup('当前筛选无任务', '更换筛选条件或添加任务。', 'new-task', '添加任务');
    if (!options || options.taskTable !== false) renderTaskTable(!!(options && options.forceTable));
  }
  function setTaskListView(view) {
    if (storageLocked) { taskListView = view; renderTasks({ forceTable: true }); return; }
    if (state.settings.taskView === view) { renderTasks({ forceTable: true }); return; }
    mutate(next => { next.settings.taskView = view; }, { forceTable: true });
  }
  function tableIsEditing() { return !!(document.activeElement && $('task-table-body').contains(document.activeElement)); }
  function tableValue(task, field) {
    const draft = tableDrafts.get(task.id);
    if (draft && Object.hasOwn(draft, field)) return draft[field].value;
    if (field === 'dueDate') return task.due.slice(0, 10);
    if (field === 'dueTime') return task.due.length > 10 ? task.due.slice(11) : '';
    return task[field] == null ? '' : task[field];
  }
  function tableAttributes(task, field) {
    const error = tableErrors.get(task.id);
    return ' id="' + esc('grid-' + field + '-' + task.id) + '" data-table-field="' + field + '" data-id="' + esc(task.id) + '" aria-label="' + esc(task.title + ' · ' + tableLabels[field]) + '"' + (error && error.invalid && error.field === field ? ' aria-invalid="true"' : '') + (storageLocked ? ' disabled' : '');
  }
  function tableInput(task, field, type, extra) {
    return '<input type="' + type + '"' + tableAttributes(task, field) + ' value="' + esc(tableValue(task, field)) + '"' + (extra || '') + '>';
  }
  function tableRating(task, field) {
    const value = String(tableValue(task, field));
    return '<select class="table-rating"' + tableAttributes(task, field) + '>' + ['', '1', '2', '3', '4', '5'].map(n => '<option value="' + n + '"' + (value === n ? ' selected' : '') + '>' + (n || '未评') + '</option>').join('') + '</select>';
  }
  function estimateReferenceText(suggestion) {
    return (suggestion.exact ? '同名' : '相似') + (suggestion.source === 'actual' ? '实际用时' : '历史估时') + '参考：约 ' + suggestion.minutes + ' 分钟（' + suggestion.sampleCount + ' 项）';
  }
  function tableEstimateButton(task) {
    const suggestion = D.getEstimateSuggestion(state, task.title, task.id);
    return '<button type="button" id="' + esc('grid-estimate-use-' + task.id) + '" class="table-estimate-use" data-action="use-table-estimate" data-id="' + esc(task.id) + '"' + (!suggestion || storageLocked ? ' hidden' : '') + '>' + (suggestion ? esc(estimateReferenceText(suggestion) + ' · 采用') : '') + '</button>';
  }
  function refreshTableEstimates() {
    for (const id of tableRowIds) {
      const task = state.tasks.find(item => item.id === id); if (!task || D.isEvent(task)) continue;
      const button = $('grid-estimate-use-' + id); if (!button) continue;
      const suggestion = D.getEstimateSuggestion(state, task.title, id);
      button.hidden = !suggestion || storageLocked;
      button.textContent = suggestion ? estimateReferenceText(suggestion) + ' · 采用' : '';
    }
  }
  function renderTaskTable(force) {
    if (taskListView !== 'table' || (!force && tableIsEditing())) return;
    for (const id of tableDrafts.keys()) if (!state.tasks.some(task => task.id === id)) { tableDrafts.delete(id); tableErrors.delete(id); }
    const tasks = filteredTasks().sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999'));
    tableRowIds = tasks.map(task => task.id);
    $('task-table-empty').hidden = !!tasks.length;
    $('task-table-body').innerHTML = tasks.map(task => {
      const event = D.isEvent(task), m = D.taskMetrics(task), label = event ? '固定事件 · ' + eventStateText(task) : m.done ? '全部完成' : m.stageReached ? '本轮已达标' : '可推进任务';
      const dates = '<div class="table-date-fields"><label><small>' + (event ? '发生日期' : '截止日期') + '</small>' + tableInput(task, 'dueDate', 'date') + '</label><label><small>' + (event ? '开始时刻（选填）' : '截止时刻（选填）') + '</small>' + tableInput(task, 'dueTime', 'time') + '</label>' + (event ? '<label><small>结束时刻（选填）</small>' + tableInput(task, 'eventEnd', 'datetime-local') + '</label>' : '') + '</div>';
      const work = event ? '<td colspan="5" class="table-readonly">固定活动只设置发生时间，<br>不使用预计工作量或进度百分比。</td>' : '<td>' + tableInput(task, 'totalMinutes', 'number', ' class="table-number" min="5" max="60000" step="1" placeholder="待估时"') + tableEstimateButton(task) + '</td><td>' + tableInput(task, 'progress', 'number', ' class="table-number" min="0" max="100" step="0.1" placeholder="0"') + '</td><td>' + tableInput(task, 'target', 'number', ' class="table-number" min="1" max="100" step="0.1" placeholder="100"') + '</td><td>' + tableRating(task, 'importance') + '</td><td>' + tableRating(task, 'enjoyment') + '</td>';
      return '<tr' + (event ? ' class="event-table-row"' : '') + '><th scope="row"><span class="table-name">' + (task.flagged ? '🔴 ' : '') + esc(task.title) + '</span><span class="table-task-meta">' + esc(task.category + ' · ' + label) + (task.sourceGroup ? ' · ' + esc(taskSourceLabel(task)) : '') + '</span></th><td>' + dates + '</td>' + work + '<td><button id="' + esc('grid-details-' + task.id) + '" class="text-button" data-action="edit-task" data-id="' + esc(task.id) + '" aria-label="' + esc('查看' + task.title + '详情') + '">详情</button></td></tr>';
    }).join('');
    refreshTableError();
  }
  function refreshTableError() {
    const first = tableErrors.entries().next();
    if (first.done) { $('task-table-error').textContent = ''; return; }
    const [id, error] = first.value, task = state.tasks.find(item => item.id === id);
    $('task-table-error').textContent = (task ? task.title + '：' : '') + error.message;
  }
  function tableControl(event) { return event.target && event.target.closest('[data-table-field]'); }
  function rememberTableDraft(control) {
    const task = state.tasks.find(item => item.id === control.dataset.id), field = control.dataset.tableField;
    const allowed = task && (D.isEvent(task) ? ['dueDate', 'dueTime', 'eventEnd'] : ['dueDate', 'dueTime', 'totalMinutes', 'progress', 'target', 'importance', 'enjoyment']);
    if (!allowed || !allowed.includes(field)) return null;
    const draft = tableDrafts.get(task.id) || {};
    draft[field] = { value: control.value, invalid: !!(control.validity && !control.validity.valid), message: control.validationMessage || '请填写有效的' + tableLabels[field] + '。' };
    tableDrafts.set(task.id, draft); return task;
  }
  function tableError(task, field, message, invalid = true) {
    tableErrors.set(task.id, { field, message, invalid });
    const control = $( 'grid-' + field + '-' + task.id );
    if (control && invalid) control.setAttribute('aria-invalid', 'true');
    $('task-table-status').textContent = ''; refreshTableError(); return false;
  }
  function saveTableRow(control) {
    const before = rememberTableDraft(control); if (!before) return false;
    const draft = tableDrafts.get(before.id), field = control.dataset.tableField;
    for (const [key, entry] of Object.entries(draft)) if (entry.invalid) return tableError(before, key, entry.message);
    const next = JSON.parse(JSON.stringify(state)), task = next.tasks.find(item => item.id === before.id);
    if (Object.hasOwn(draft, 'dueDate') || Object.hasOwn(draft, 'dueTime')) {
      const date = Object.hasOwn(draft, 'dueDate') ? draft.dueDate.value : before.due.slice(0, 10);
      const clock = Object.hasOwn(draft, 'dueTime') ? draft.dueTime.value : before.due.length > 10 ? before.due.slice(11) : '';
      if (clock && !date) return tableError(before, 'dueDate', '填写时刻前，请先填写日期。');
      task.due = date ? date + (clock ? 'T' + clock : '') : '';
    }
    for (const key of ['totalMinutes', 'progress', 'target', 'importance', 'enjoyment']) if (Object.hasOwn(draft, key)) task[key] = optionalNumber(draft[key].value) ?? (key === 'progress' ? 0 : key === 'target' ? 100 : null);
    if (Object.hasOwn(draft, 'eventEnd')) task.eventEnd = draft.eventEnd.value;
    const checked = D.validateState(next);
    if (!checked.ok) return tableError(before, field, '未保存，请修正：' + checked.errors.join(' '));
    for (const key of Object.keys(draft)) { const input = $('grid-' + key + '-' + before.id); if (input) input.removeAttribute('aria-invalid'); }
    const after = checked.value.tasks.find(item => item.id === before.id);
    const changed = ['due', 'eventEnd', 'totalMinutes', 'progress', 'target', 'importance', 'enjoyment'].some(key => before[key] !== after[key]);
    if (changed || !lastSaved) {
      const entry = progressLog(before, after, {});
      if (!entry.ok) return tableError(before, field, entry.errors.join(' '));
      if (entry.value) checked.value.logs.push(entry.value);
      const error = commit(checked.value, { taskTable: false });
      if (error) return tableError(before, field, error, false);
    }
    tableDrafts.delete(before.id); tableErrors.delete(before.id); refreshTableError();
    for (const key of Object.keys(draft)) { const input = $('grid-' + key + '-' + before.id); if (input) input.value = tableValue(after, key); }
    $('task-table-status').textContent = '已保存 · ' + after.title;
    refreshTableEstimates();
    return true;
  }
  function renderCourses() {
    const s = state.settings;
    $('semester-description').textContent = '学期第 1 周：' + s.semesterStart + ' 起 · 共 ' + s.semesterWeeks + ' 周';
    const columns = weekdayOrder.map(day => state.courses.filter(c => c.daily || c.day === day));
    const starts = Array.from(new Set(state.courses.map(c => c.start))).sort();
    const card = c => {
      const rule = c.weekMode === 'all' ? c.daily ? '每天' : '每周' : (c.weekMode === 'odd' ? '单周' : '双周') + (c.daily ? '每天' : '');
      return '<button class="course-entry" data-action="edit-course" data-id="' + esc(c.id) + '"><span class="course-time">' + c.start + '–' + c.end + '</span><strong>' + esc(c.title) + '</strong><span class="course-location">' + esc(c.location || '地点未设') + '</span><span class="course-rule">' + c.startWeek + '–' + c.endWeek + ' 周 · ' + rule + '</span></button>';
    };
    const heading = '<thead><tr><th scope="col" class="course-slot-time">开始</th>' + weekdayOrder.map((day, index) => '<th scope="col"><div class="course-day-heading">' + days[day] + '<small>' + columns[index].length + ' 个安排</small></div></th>').join('') + '</tr></thead>';
    const rows = starts.map(start => '<tr><th scope="row" class="course-slot-time">' + esc(start) + '</th>' + columns.map(courses => '<td>' + (courses.filter(c => c.start === start).sort((a, b) => a.end.localeCompare(b.end)).map(card).join('') || '<span class="course-slot-empty" aria-hidden="true">—</span>') + '</td>').join('') + '</tr>').join('');
    $('course-week').innerHTML = '<table class="course-timetable"><caption class="course-timetable-caption">按开始时刻对齐的每周固定安排</caption>' + heading + '<tbody>' + (rows || '<tr><td colspan="8" class="course-empty">添加课程或固定安排，相同开始时刻会显示在同一行。</td></tr>') + '</tbody></table>';
  }
  function renderSettings() {
    const f = $('settings-form'), s = state.settings;
    ['dayStart', 'dayEnd', 'dailyBudget', 'blockMinutes', 'breakMinutes', 'courseBuffer', 'semesterStart', 'semesterWeeks', 'taskView'].forEach(key => { f.elements[key].value = s[key]; });
    f.elements.useDailyBudget.checked = s.useDailyBudget; f.elements.dailyBudget.disabled = !s.useDailyBudget;
    ['importance', 'urgency', 'enjoyment'].forEach(key => { $('weight-' + key).value = s.weights[key]; }); updateWeightLabels();
  }
  function renderLogs() {
    const today = P.localDate(), cutoff = D.pruneLogs([], today).cutoff;
    if (logDate < cutoff) logDate = cutoff;
    if (logDate > today) logDate = today;
    $('log-date').value = logDate; $('log-date').min = cutoff; $('log-date').max = today;
    $('next-log-day').disabled = logDate >= today;
    $('logs-retention-label').textContent = '保留 ' + cutoff.slice(5).replace('-', '/') + '—' + today.slice(5).replace('-', '/') + ' · 更早日志自动清理';
    const summary = D.summarizeLogs(state.logs, logDate);
    $('logs-summary').innerHTML = '<div><span>当天记录</span><strong>' + summary.entries.length + ' 条</strong></div><div><span>完成记录 / 推进记录</span><strong>' + summary.completedCount + ' / ' + summary.partialCount + '</strong></div><div><span>已记录用时</span><strong>' + P.formatMinutes(summary.totalMinutes) + '</strong>' + (summary.unknownDurationCount ? '<small>另有 ' + summary.unknownDurationCount + ' 条未填时长</small>' : '') + '</div>';
    $('log-list').innerHTML = summary.entries.length ? summary.entries.map(log => {
      const interval = log.startedAt && log.endedAt ? log.startedAt.slice(11) + '—' + (log.endedAt.slice(0, 10) === log.date ? '' : log.endedAt.slice(5, 10).replace('-', '/') + ' ') + log.endedAt.slice(11) : '工作时刻未填写';
      const progress = log.fromProgress != null && log.toProgress != null ? percent(log.fromProgress) + ' → ' + percent(log.toProgress) : log.toProgress != null ? '完成到 ' + percent(log.toProgress) : '';
      return '<article class="log-card"><div class="log-card-heading"><div><h3>' + esc(log.taskTitle) + '</h3><span class="log-clock">' + esc(interval) + ' · ' + (log.minutes == null ? '用时未填写' : P.formatMinutes(log.minutes)) + '</span></div><span class="tag">' + ({ completed: '全部完成', partial: '部分推进', activity: '活动记录' }[log.status]) + '</span></div>' + (progress ? '<span class="log-progress">' + progress + '</span>' : '') + (log.note ? '<p class="log-content">' + esc(log.note) + '</p>' : '') + '<div class="log-card-actions"><span class="muted small">记录于 ' + esc(new Date(log.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })) + '</span><button class="text-button" data-action="edit-log" data-id="' + esc(log.id) + '">编辑</button><button class="text-button danger-text" data-action="delete-log" data-id="' + esc(log.id) + '">删除</button></div></article>';
    }).join('') : emptyMarkup('当天无记录。', '更新任务进度会自动记录，也可手动补记。', 'new-log', '补记记录');
  }
  function runLogRetention() {
    if (storageLocked) return false;
    const pruned = D.pruneLogs(state.logs, P.localDate());
    if (!pruned.removed) return false;
    const next = JSON.parse(JSON.stringify(state)); next.logs = pruned.logs;
    const error = commit(next, { settings: false }); if (error) notify(error);
    return true;
  }
  function validateWorkLog(entry) {
    const today = P.localDate(), cutoff = D.pruneLogs([], today).cutoff;
    if (entry.date < cutoff || entry.date > today) return { ok: false, errors: ['只能记录最近 14 天内已经做过的事情。'] };
    if (entry.endedAt && new Date(entry.endedAt).getTime() > Date.now() + 60000) return { ok: false, errors: ['实际结束时间不能在未来。'] };
    return D.normalizeLog(entry);
  }
  function progressLog(before, after, values) {
    if (D.isEvent(before) || D.isEvent(after)) return { ok: true, value: null };
    const advanced = after.progress != null && (before.progress == null ? after.progress > 0 : after.progress > before.progress);
    const startedAt = values.startedAt || '', endedAt = values.endedAt || '', note = (values.note || '').trim(), minutes = optionalNumber(values.minutes);
    if (!advanced && !startedAt && !endedAt && !note && minutes == null) return { ok: true, value: null };
    return validateWorkLog({ id: D.id(), taskId: after.id, taskTitle: after.title, date: startedAt ? startedAt.slice(0, 10) : P.localDate(), minutes, at: new Date().toISOString(), startedAt, endedAt, note, fromProgress: before.progress, toProgress: after.progress });
  }
  function syncLogInterval(form) {
    const a = form.elements.startedAt.value, b = form.elements.endedAt.value;
    if (a && form.elements.date) form.elements.date.value = a.slice(0, 10);
    const duration = a && b ? (new Date(b) - new Date(a)) / 60000 : NaN;
    form.elements.minutes.readOnly = Number.isInteger(duration) && duration > 0 && duration <= 1440;
    if (form.elements.minutes.readOnly) form.elements.minutes.value = duration;
  }
  function openLog(id) {
    const log = state.logs.find(item => item.id === id), f = $('log-form'); f.reset(); $('log-error').textContent = '';
    $('log-dialog-title').textContent = log ? '编辑记录' : '补记记录';
    const missingTask = log && log.taskId && !state.tasks.some(task => task.id === log.taskId);
    f.elements.taskId.innerHTML = '<option value="">不关联任务</option>' + (missingTask ? '<option value="' + esc(log.taskId) + '">原任务已删除 · ' + esc(log.taskTitle) + '</option>' : '') + state.tasks.map(task => '<option value="' + esc(task.id) + '">' + esc(task.title) + '</option>').join('');
    f.elements.id.value = log ? log.id : ''; f.elements.date.value = log ? log.date : logDate;
    f.elements.date.min = D.pruneLogs([], P.localDate()).cutoff; f.elements.date.max = P.localDate();
    if (log) ['taskId', 'taskTitle', 'status', 'startedAt', 'endedAt', 'minutes', 'fromProgress', 'toProgress', 'note'].forEach(key => { f.elements[key].value = log[key] == null ? '' : log[key]; });
    syncLogInterval(f); $('log-dialog').showModal();
  }
  function updateWeightLabels() {
    ['importance', 'urgency', 'enjoyment'].forEach(key => { const n = Number($('weight-' + key).value); $('weight-' + key + '-value').textContent = n > 0 ? '+' + n : String(n); });
    const n = Number($('weight-enjoyment').value);
    $('weight-description').textContent = n < 0 ? '低愉悦优先：同等条件下，愉悦评分越低的任务越靠前。' : n > 0 ? '高愉悦优先：愉悦评分越高的任务获得更多分数。' : '愉悦性不参与本次排序。';
  }
  function render(options) {
    $('demo-banner').hidden = storageLocked || !state.demo;
    $('data-protection-banner').hidden = !storageLocked; renderStorageStatus(); renderLive(); renderTasks(options); renderCourses(); renderLogs();
    if (!options || options.settings !== false) renderSettings();
  }
  function formValues(form) { return Object.fromEntries(new FormData(form)); }
  function openTask(id) {
    const task = state.tasks.find(t => t.id === id), f = $('task-form'); f.reset(); $('task-error').textContent = '';
    $('task-dialog-title').textContent = task ? '编辑事项' : '添加事项';
    f.elements.id.value = task ? task.id : '';
    f.elements.kind.value = task && D.isEvent(task) ? 'event' : 'task';
    f.elements.duePrecision.value = task && task.due.length > 10 ? 'time' : 'date';
    f.elements.due.type = f.elements.duePrecision.value === 'date' ? 'date' : 'datetime-local';
    if (task) ['title', 'category', 'due', 'importance', 'enjoyment', 'totalMinutes', 'progress', 'target', 'nextAction'].forEach(key => { f.elements[key].value = task[key] == null ? '' : task[key]; });
    f.elements.flagged.checked = !!(task && task.flagged);
    ['eventEnd', 'eventLocation'].forEach(key => { f.elements[key].value = task && task[key] || ''; });
    f.elements.eventStatus.value = task && task.eventStatus || 'pending';
    syncTaskKind(); updateEstimate(); $('task-dialog').showModal();
  }
  function syncTaskKind() {
    const f = $('task-form'), event = f.elements.kind.value === 'event';
    if (!event) {
      if (f.elements.progress.value === '') f.elements.progress.value = 0;
      if (f.elements.target.value === '') f.elements.target.value = 100;
    }
    $('task-work-fields').hidden = event; $('event-fields').hidden = !event;
    $('task-date-label').textContent = event ? '发生日期 / 时刻' : '截止日期 / 时刻';
    $('task-next-label').textContent = event ? '备注 / 参加提醒' : '下一步行动';
    f.elements.nextAction.placeholder = event ? '例如：携带证件，考场以通知为准' : '例如：先列提纲，再整理第一部分数据';
    ['importance', 'enjoyment', 'totalMinutes', 'progress', 'target'].forEach(key => { f.elements[key].disabled = event; });
    ['eventEnd', 'eventLocation', 'eventStatus'].forEach(key => { f.elements[key].disabled = !event; });
    updateTaskExtras();
  }
  function updateTaskExtras() {
    const f = $('task-form'), event = f.elements.kind.value === 'event', eligible = !event && !f.elements.id.value;
    $('task-repeat-fields').hidden = !eligible; f.elements.repeatEnabled.disabled = !eligible;
    if (!eligible) f.elements.repeatEnabled.checked = false;
    const enabled = eligible && f.elements.repeatEnabled.checked;
    $('task-repeat-options').hidden = !enabled;
    ['repeatFrequency', 'repeatInterval', 'repeatCount'].forEach(key => { f.elements[key].disabled = !enabled; });
    const suggestion = event ? null : D.getEstimateSuggestion(state, f.elements.title.value, f.elements.id.value || undefined);
    $('task-estimate-memory').hidden = !suggestion;
    $('task-estimate-memory-text').textContent = suggestion ? estimateReferenceText(suggestion) + '。采用后仍可自行调整。' : '';
    if (!enabled) return;
    if (!f.elements.title.value.trim() || !f.elements.due.value) { $('task-repeat-preview').textContent = '填写任务名称和首次 DDL 后显示日期预览。'; return; }
    const sample = { id: 'repeat-preview', title: f.elements.title.value, kind: 'task', category: f.elements.category.value, due: f.elements.due.value, totalMinutes: optionalNumber(f.elements.totalMinutes.value), importance: optionalNumber(f.elements.importance.value), enjoyment: optionalNumber(f.elements.enjoyment.value), progress: optionalNumber(f.elements.progress.value) ?? 0, target: optionalNumber(f.elements.target.value) ?? 100, nextAction: f.elements.nextAction.value };
    const repeated = D.createRecurringTaskBatch(sample, { frequency: f.elements.repeatFrequency.value, interval: Number(f.elements.repeatInterval.value), count: Number(f.elements.repeatCount.value) });
    $('task-repeat-preview').textContent = repeated.ok ? '共 ' + repeated.value.tasks.length + ' 项，首次 ' + repeated.value.tasks[0].due.replace('T', ' ') + '，最后一次 ' + repeated.value.tasks[repeated.value.tasks.length - 1].due.replace('T', ' ') + '；重复项会跳过。' : repeated.errors[0];
  }
  function clearAIPlan() {
    aiPending = null; $('ai-preview').hidden = true; $('ai-apply').disabled = true; $('ai-apply').textContent = '应用到任务';
    $('ai-summary').textContent = ''; $('ai-change-list').innerHTML = '';
  }
  function cancelAIRequest() {
    const running = !!aiController; aiRequestVersion += 1;
    if (aiController) aiController.abort(); aiController = null;
    $('ai-generate').disabled = false; $('ai-cancel-request').hidden = true;
    if (running) $('ai-status').textContent = '已取消生成，任务未修改。';
  }
  function openAI() {
    if (storageLocked) { notify('请先恢复本地数据，再使用 AI 修改任务。'); return; }
    if (tableDrafts.size) { notify('表格中还有未保存的编辑，请先修正或保存后再使用 AI。'); return; }
    clearAIPlan(); $('ai-error').textContent = ''; $('ai-status').textContent = '';
    const provider = A.PROVIDERS[$('ai-provider').value];
    $('ai-endpoint').textContent = provider.url;
    $('ai-scope').textContent = '将发送当前筛选中的 ' + filteredTasks().length + ' 件事项及你的指令，不包含每日记录、课表或偏好。每次最多 200 件。';
    $('ai-dialog').showModal();
  }
  function aiFieldText(key, value) {
    if (value == null || value === '') return '未填写';
    if (key === 'kind') return value === 'event' ? '固定事件' : '可推进任务';
    if (key === 'flagged') return value ? '重点' : '普通';
    if (key === 'eventStatus') return { pending: '待发生 / 待确认', attended: '已参加', missed: '未参加' }[value];
    if (key === 'totalMinutes') return value + ' 分钟';
    if (key === 'progress' || key === 'target') return percent(value);
    return String(value).replace('T', ' ');
  }
  function renderAIPlan(checked) {
    const labels = { title: '名称', kind: '类型', category: '分类', due: '日期 / 时刻', totalMinutes: '预计总用时', progress: '进度', target: '本轮目标', importance: '重要性', enjoyment: '愉悦性', nextAction: '下一步 / 备注', flagged: '重点标记', eventEnd: '结束时刻', eventLocation: '地点', eventStatus: '参加状态' };
    $('ai-summary').textContent = checked.summary || (checked.changes.length ? '请核对以下 ' + checked.changes.length + ' 项修改。' : '本次不需要修改任务。');
    $('ai-change-list').innerHTML = checked.changes.map(change => {
      const fields = Object.keys(labels).filter(key => change.type === 'delete' ? ['due', 'kind'].includes(key) : change.type === 'create' ? change.after[key] != null && change.after[key] !== '' : change.before[key] !== change.after[key]);
      return '<article class="ai-change-card"><span class="ai-change-type">' + ({ create: '新增', update: '修改', delete: '删除' }[change.type]) + '</span><h4>' + esc(change.title) + '</h4><div class="ai-change-fields">' + fields.map(key => '<p>' + esc(labels[key]) + '：' + esc(change.type === 'update' ? aiFieldText(key, change.before[key]) + ' → ' + aiFieldText(key, change.after[key]) : aiFieldText(key, (change.after || change.before)[key])) + '</p>').join('') + '</div></article>';
    }).join('');
    $('ai-preview').hidden = false; $('ai-apply').disabled = !checked.changes.length;
  }
  async function generateAIPlan(event) {
    event.preventDefault(); const f = event.currentTarget; if (!f.reportValidity()) return;
    if (storageLocked) { $('ai-error').textContent = '本地数据受保护，暂不能生成修改方案。'; return; }
    cancelAIRequest(); clearAIPlan(); $('ai-error').textContent = '';
    const version = aiRequestVersion, baseTasks = JSON.stringify(state.tasks), tasks = JSON.parse(JSON.stringify(filteredTasks())), allowedIds = tasks.map(task => task.id);
    aiController = new AbortController(); $('ai-generate').disabled = true; $('ai-cancel-request').hidden = false;
    $('ai-status').textContent = '正在生成修改方案，当前任务尚未改变…';
    try {
      const proxy = location.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(location.hostname) && location.port === '4173';
      const plan = await A.requestPlan({ provider: f.elements.provider.value, model: f.elements.model.value, apiKey: f.elements.apiKey.value, instruction: f.elements.instruction.value, tasks, dateString: P.localDate(), signal: aiController.signal, ...(proxy ? { proxyUrl: '/api/ai' } : {}) });
      if (version !== aiRequestVersion) return;
      if (JSON.stringify(state.tasks) !== baseTasks) throw new Error('任务在生成期间已有更新，请重新生成方案。');
      const checked = A.validatePlan(state, plan, { allowedIds, dateString: P.localDate(), now: new Date() });
      if (!checked.ok) throw new Error(checked.errors.join(' '));
      aiPending = { checked, baseTasks, appliedInMemory: false }; renderAIPlan(checked);
      $('ai-status').textContent = '修改方案已生成，核对后点击“应用到任务”保存。';
    } catch (error) {
      if (version === aiRequestVersion) { $('ai-error').textContent = error.message || '生成失败，请重试。'; $('ai-status').textContent = '任务未修改。'; }
    } finally {
      if (version === aiRequestVersion) { aiController = null; $('ai-generate').disabled = false; $('ai-cancel-request').hidden = true; }
    }
  }
  function applyAIPlan() {
    if (!aiPending) return;
    if (storageLocked) { $('ai-error').textContent = '本地数据受保护，方案尚未应用。'; return; }
    if (JSON.stringify(state.tasks) !== aiPending.baseTasks) { clearAIPlan(); $('ai-error').textContent = '任务已有更新，请重新生成方案，避免覆盖新进度。'; return; }
    const next = JSON.parse(JSON.stringify(state));
    if (!aiPending.appliedInMemory) {
      next.tasks = JSON.parse(JSON.stringify(aiPending.checked.value.tasks));
      for (const change of aiPending.checked.changes) {
        if (!change.after) continue;
        if (D.isEvent(change.after) && change.after.eventStatus === 'attended' && (!change.before || change.before.eventStatus !== 'attended')) {
          const entry = attendanceLog(change.after); if (entry) next.logs.push(entry);
        } else if (change.before) {
          const entry = progressLog(change.before, change.after, {});
          if (!entry.ok) { $('ai-error').textContent = entry.errors.join(' '); return; }
          if (entry.value) next.logs.push(entry.value);
        }
      }
    }
    const count = aiPending.checked.changes.length, error = commit(next, { forceTable: true });
    if (error) {
      aiPending.appliedInMemory = JSON.stringify(state.tasks) === JSON.stringify(next.tasks); aiPending.baseTasks = JSON.stringify(state.tasks);
      $('ai-error').textContent = error; $('ai-apply').textContent = aiPending.appliedInMemory ? '重试保存' : '应用到任务'; return;
    }
    clearAIPlan(); $('ai-error').textContent = ''; $('ai-status').textContent = '已应用并保存 ' + count + ' 项修改。';
    notify('AI 修改已保存，排行榜已更新。');
  }
  function clearPKUPlan() {
    pkuPending = null; $('pku-preview').hidden = true; $('pku-item-list').innerHTML = '';
    $('pku-summary').textContent = ''; $('pku-warnings').textContent = ''; $('pku-apply').disabled = true;
    $('pku-apply').textContent = '确认合并到任务';
  }
  function cancelPKURequest() {
    pkuRequestVersion += 1; if (pkuController) pkuController.abort(); pkuController = null;
    ['pku-read', 'pku-check', 'pku-forget', 'pku-send-sms'].forEach(id => { $(id).disabled = false; });
    $('pku-cancel').hidden = true;
  }
  function clearPKUVerification() {
    pkuChallenge = null; $('pku-verification').hidden = true;
    ['pku-captcha', 'pku-sms-code', 'pku-otp-code'].forEach(id => { $(id).value = ''; });
    $('pku-captcha-image').hidden = true; $('pku-captcha-image').removeAttribute('src');
  }
  function renderPKUChallenge(challenge) {
    clearPKUVerification(); pkuChallenge = challenge; $('pku-verification').hidden = false;
    $('pku-captcha-group').hidden = !challenge.captchaRequired;
    $('pku-sms-group').hidden = challenge.mode !== 'sms'; $('pku-otp-group').hidden = challenge.mode !== 'otp';
    if (challenge.captchaImage) { $('pku-captcha-image').src = challenge.captchaImage; $('pku-captcha-image').hidden = false; }
  }
  function openPKU() {
    if (storageLocked) { notify('请先恢复本地数据，再同步教学网。'); return; }
    if (tableDrafts.size) { notify('表格中还有未保存的编辑，请先保存或修正后再同步。'); return; }
    cancelPKURequest(); clearPKUPlan(); clearPKUVerification();
    pkuRememberKnown = false; pkuRememberTouched = false; pkuRememberKey = $('pku-pairing').value.trim();
    $('pku-error').textContent = ''; $('pku-status').textContent = '首次使用先启动本机连接器并填写配对码。';
    $('pku-dialog').showModal();
  }
  function acceptPKUStatus(result, form) {
    if (typeof result.remembered !== 'boolean' || typeof result.connected !== 'boolean') throw new Error('连接器状态响应无效，请更新连接器。');
    if (!pkuRememberTouched && !form.elements.username.value && !form.elements.password.value) {
      form.elements.remember.checked = result.remembered; pkuRememberKnown = true;
    } else pkuRememberKnown = pkuRememberTouched;
  }
  function renderPKUPlan(plan) {
    $('pku-item-list').innerHTML = plan.rows.map((row, index) => {
      const unchanged = row.type === 'unchanged', candidates = row.candidates.length > 0;
      const label = unchanged ? 'DDL 未变' : row.type === 'update' ? '更新 DDL' : candidates ? '发现同名任务' : '新增任务';
      return '<article class="pku-item"><label class="pku-item-heading"><input id="pku-select-' + index + '" type="checkbox"' + (unchanged ? ' disabled' : !candidates ? ' checked' : '') + '><span><strong>' + esc(row.item.displayTitle) + '</strong><small>' + esc(label) + '</small></span></label>' +
        '<p class="pku-item-date">' + (row.type === 'update' ? esc(row.beforeDue.replace('T', ' ') || '未设 DDL') + ' → ' : '') + esc(row.item.due.replace('T', ' ')) + '</p>' +
        (candidates ? '<label class="pku-match-label" for="pku-target-' + index + '">处理方式<select id="pku-target-' + index + '" data-pku-index="' + index + '"><option value="" selected>请选择关联或另建</option><option value="new">另建为新任务</option>' + row.candidates.map(task => '<option value="' + esc(task.id) + '">关联：' + esc(task.title) + '（' + esc(task.due.replace('T', ' ') || '未设 DDL') + '）</option>').join('') + '</select></label>' : '') + '</article>';
    }).join('');
    const changed = plan.rows.filter(row => row.type !== 'unchanged').length;
    $('pku-summary').textContent = '读取到 ' + plan.rows.length + ' 件事项，其中 ' + changed + ' 件可新增、关联或更新。';
    $('pku-preview').hidden = false; $('pku-apply').disabled = !changed;
  }
  async function runPKUOperation(operation, event) {
    if (event) event.preventDefault();
    if (storageLocked || tableDrafts.size) { $('pku-error').textContent = '请先恢复本地数据并保存表格编辑，再同步教学网。'; return; }
    const form = $('pku-form'); if (!form.reportValidity()) return;
    cancelPKURequest(); clearPKUPlan(); $('pku-error').textContent = '';
    const version = pkuRequestVersion; pkuController = new AbortController();
    ['pku-read', 'pku-check', 'pku-forget', 'pku-send-sms'].forEach(id => { $(id).disabled = true; });
    $('pku-cancel').hidden = false;
    $('pku-status').textContent = operation === 'sync' ? '正在登录教学网并读取 DDL…' : operation === 'sms' ? '正在请求短信验证码…' : operation === 'forget' ? '正在清除本机登录…' : '正在检查本机连接…';
    const timeout = setTimeout(() => { if (version === pkuRequestVersion && pkuController) pkuController.abort(); }, 90000);
    try {
      const options = { key: form.elements.pairing.value, signal: pkuController.signal };
      if (options.key.trim() !== pkuRememberKey) { pkuRememberKnown = false; pkuRememberKey = options.key.trim(); }
      if (operation === 'sync') {
        const username = form.elements.username.value.trim(), password = form.elements.password.value;
        if (!!username !== !!password) throw new Error('首次登录请同时填写校园卡账号和密码；使用已记住的登录时两项留空。');
        if (!username && !pkuRememberKnown && !pkuRememberTouched) {
          const status = await K.request({ ...options, path: '/api/pku/status' });
          if (version !== pkuRequestVersion) return;
          acceptPKUStatus(status, form);
        }
        options.path = '/api/pku/sync'; options.method = 'POST'; options.body = { remember: form.elements.remember.checked };
        if (username) Object.assign(options.body, { username, password, remember: form.elements.remember.checked });
        if (pkuChallenge) {
          const verification = {};
          if (pkuChallenge.captchaRequired) verification.captcha = form.elements.captcha.value.trim();
          if (pkuChallenge.mode === 'sms') verification.sms = form.elements.sms.value.trim();
          if (pkuChallenge.mode === 'otp') verification.otp = form.elements.otp.value.trim();
          options.body.verification = verification;
        }
      } else if (operation === 'forget') { options.path = '/api/pku/credentials'; options.method = 'DELETE'; }
      else if (operation === 'sms') { options.path = '/api/pku/sms'; options.method = 'POST'; options.body = {}; }
      else options.path = '/api/pku/status';
      const result = await K.request(options); if (version !== pkuRequestVersion) return;
      if (operation === 'sync') {
        const plan = K.createPlan(state, result.items); if (!plan.ok) throw new Error(plan.errors.join(' '));
        pkuPending = { plan, appliedInMemory: false }; renderPKUPlan(plan);
        $('pku-warnings').textContent = Array.isArray(result.warnings) ? result.warnings.filter(value => typeof value === 'string').slice(0, 10).join(' ') : '';
        $('pku-status').textContent = 'DDL 已读取，请选择要合并的事项。';
        pkuRememberKnown = true;
        form.elements.password.value = ''; form.elements.username.value = ''; clearPKUVerification();
      } else if (operation === 'forget') {
        form.elements.password.value = ''; form.elements.username.value = ''; form.elements.remember.checked = false; clearPKUVerification();
        pkuRememberKnown = true; pkuRememberTouched = false;
        $('pku-status').textContent = '本机保存的登录信息及当前教学网会话已清除。';
      } else if (operation === 'sms') $('pku-status').textContent = '短信请求已发送，请填写收到的验证码后再次读取 DDL。';
      else {
        acceptPKUStatus(result, form);
        $('pku-status').textContent = '连接成功。' + (result.remembered ? '本机已加密记住登录，可留空账号密码直接读取。' : '请填写校园卡账号和密码。') + (result.connected ? '当前教学网会话有效。' : '');
      }
    } catch (error) {
      if (version !== pkuRequestVersion) return;
      if (error.challenge) { renderPKUChallenge(error.challenge); $('pku-status').textContent = '统一认证需要验证，请填写后再次读取 DDL。'; }
      else $('pku-status').textContent = '当前任务保持原样。';
      $('pku-error').textContent = error.message || '教学网同步失败，请重试。';
    } finally {
      clearTimeout(timeout);
      if (version === pkuRequestVersion) { pkuController = null; ['pku-read', 'pku-check', 'pku-forget', 'pku-send-sms'].forEach(id => { $(id).disabled = false; }); $('pku-cancel').hidden = true; }
    }
  }
  function applyPKUPlan() {
    if (!pkuPending) return;
    if (storageLocked || tableDrafts.size) { $('pku-error').textContent = '请先恢复本地数据并保存表格编辑，再合并。'; return; }
    let checked;
    if (pkuPending.appliedInMemory) {
      if (JSON.stringify(state.tasks) !== pkuPending.plan.baseTasks) { clearPKUPlan(); $('pku-error').textContent = '任务已有更新，请重新读取 DDL。'; return; }
      checked = { ok: true, value: JSON.parse(JSON.stringify(state)) };
    } else {
      const selections = [];
      for (let index = 0; index < pkuPending.plan.rows.length; index++) {
        const row = pkuPending.plan.rows[index]; if (!$('pku-select-' + index).checked || row.type === 'unchanged') continue;
        let targetId = row.taskId || null;
        if (row.candidates.length) {
          const choice = $('pku-target-' + index).value;
          if (!choice) { $('pku-error').textContent = '请为所选同名事项选择“关联”或“另建”。'; return; }
          targetId = choice === 'new' ? null : choice;
        }
        selections.push({ sourceId: row.item.sourceId, targetId });
      }
      if (!selections.length) { $('pku-error').textContent = '请至少勾选一件需要合并的事项。'; return; }
      checked = K.applyPlan(state, pkuPending.plan, selections);
      if (!checked.ok) { $('pku-error').textContent = checked.errors.join(' '); return; }
    }
    const error = commit(checked.value, { forceTable: true });
    if (error) {
      pkuPending.appliedInMemory = JSON.stringify(state.tasks) === JSON.stringify(checked.value.tasks); pkuPending.plan.baseTasks = JSON.stringify(state.tasks);
      $('pku-error').textContent = error; $('pku-apply').textContent = pkuPending.appliedInMemory ? '重试保存' : '确认合并到任务'; return;
    }
    clearPKUPlan(); $('pku-error').textContent = ''; $('pku-status').textContent = '教学网事项已合并并保存在当前浏览器。';
    notify('教学网 DDL 已同步，排行榜已更新。');
  }
  function updateEstimate() {
    const f = $('task-form'), task = { totalMinutes: optionalNumber(f.elements.totalMinutes.value), progress: optionalNumber(f.elements.progress.value) ?? 0, target: optionalNumber(f.elements.target.value) ?? 100 };
    const m = D.taskMetrics(task); $('stage-estimate').textContent = m.remaining != null && Number.isFinite(m.remaining) ? P.formatMinutes(m.remaining) : '待补充参数';
  }
  function openProgress(id, minutes) {
    const task = state.tasks.find(t => t.id === id); if (!task) return;
    if (D.isEvent(task)) { openTask(id); return; }
    const f = $('progress-form'); f.reset(); f.elements.id.value = id; f.elements.progress.value = task.progress ?? 0; f.elements.target.value = task.target ?? 100;
    f.elements.minutes.value = minutes || ''; $('progress-task-name').textContent = task.title;
    $('progress-error').textContent = ''; syncLogInterval(f); updateProgressLabels(); $('progress-dialog').showModal();
  }
  function updateProgressLabels(fromRange) {
    const f = $('progress-form'); if (fromRange) f.elements.progress.value = $('progress-range').value;
    const progress = optionalNumber(f.elements.progress.value) ?? 0, target = optionalNumber(f.elements.target.value) ?? 100;
    $('progress-range').value = progress == null ? 0 : progress; $('progress-value').textContent = progress == null ? '待填写' : percent(progress);
    $('progress-stage-note').textContent = progress == null || target == null ? '设置阶段目标和预计用时后生成时间安排。' : progress >= 100 ? '已全部完成。保存后从待办榜移出。' : progress >= target ? '本轮已达标。提高目标可重新加入排序。' : '本轮还需推进 ' + percent(Math.round((target - progress) * 10) / 10) + '。';
  }
  function openCourse(id) {
    const course = state.courses.find(c => c.id === id), f = $('course-form'); f.reset(); $('course-error').textContent = '';
    f.elements.id.value = course ? course.id : ''; f.elements.endWeek.value = state.settings.semesterWeeks;
    $('course-dialog-title').textContent = course ? '编辑固定安排' : '添加固定安排'; $('delete-course').hidden = !course;
    if (course) ['title', 'day', 'location', 'start', 'end', 'startWeek', 'endWeek', 'weekMode'].forEach(key => { f.elements[key].value = course[key]; });
    if (course && course.daily) f.elements.day.value = 'daily';
    $('course-dialog').showModal();
  }
  function download(name, contents, type) {
    const url = URL.createObjectURL(new Blob([contents], { type })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  document.addEventListener('click', event => {
    const close = event.target.closest('[data-close]'); if (close) { $(close.dataset.close).close(); return; }
    const nav = event.target.closest('[data-view]'); if (nav) { go(nav.dataset.view); return; }
    const preset = event.target.closest('[data-preset]');
    if (preset) { const weights = { bitter: { importance: 60, urgency: 35, enjoyment: -20 }, balanced: { importance: 60, urgency: 35, enjoyment: 5 }, deadline: { importance: 35, urgency: 65, enjoyment: 0 } }[preset.dataset.preset]; if (mutate(next => { next.settings.weights = weights; })) notify('偏好已更新，任务顺序已重算。'); return; }
    const button = event.target.closest('[data-action]'); if (!button) return;
    const id = button.dataset.id;
    switch (button.dataset.action) {
      case 'task-table-view': setTaskListView('table'); break;
      case 'task-cards-view': setTaskListView('cards'); break;
      case 'open-ai': openAI(); break;
      case 'open-pku': openPKU(); break;
      case 'pku-check': return runPKUOperation('status');
      case 'pku-forget': return runPKUOperation('forget');
      case 'pku-sms': return runPKUOperation('sms');
      case 'pku-apply': applyPKUPlan(); break;
      case 'pku-cancel': cancelPKURequest(); clearPKUPlan(); $('pku-status').textContent = '已取消读取。'; break;
      case 'apply-ai': applyAIPlan(); break;
      case 'cancel-ai': cancelAIRequest(); break;
      case 'clear-ai-key': cancelAIRequest(); clearAIPlan(); $('ai-api-key').value = ''; $('ai-status').textContent = '本页的 API Key 已清除。'; break;
      case 'use-estimate': {
        const f = $('task-form'), suggestion = D.getEstimateSuggestion(state, f.elements.title.value, f.elements.id.value || undefined);
        if (suggestion && f.elements.kind.value !== 'event') { f.elements.totalMinutes.value = suggestion.minutes; updateEstimate(); updateTaskExtras(); }
        break;
      }
      case 'use-table-estimate': {
        const task = state.tasks.find(item => item.id === id); if (!task || D.isEvent(task)) break;
        const suggestion = D.getEstimateSuggestion(state, task.title, id), input = $('grid-totalMinutes-' + id);
        if (suggestion && input) { input.value = suggestion.minutes; saveTableRow(input); }
        break;
      }
      case 'new-task': openTask(); break;
      case 'edit-task': openTask(id); break;
      case 'attend-event': {
        const event = state.tasks.find(task => task.id === id);
        if (!event || !D.isEvent(event) || event.eventStatus !== 'pending') break;
        if (!eventHasOccurred(event)) { notify('固定事件尚未到发生时间，暂不能标记已参加。'); break; }
        ask('确认已参加？', '确认你已参加“' + event.title + '”。会保存参加状态，并在保留期内留一条记录；实际用时可随后补记。', '确认已参加', () => mutate(next => {
          const target = next.tasks.find(task => task.id === id); target.eventStatus = 'attended';
          const log = attendanceLog(target); if (log) next.logs.push(log);
        }));
        break;
      }
      case 'progress': openProgress(id, button.dataset.minutes); break;
      case 'delete-task': { const task = state.tasks.find(t => t.id === id); if (task) ask('删除这件事？', task.title + ' 将从清单中移除，已记录的投入历史会保留。', '删除任务', () => mutate(next => { next.tasks = next.tasks.filter(t => t.id !== id); })); break; }
      case 'new-course': openCourse(); break;
      case 'new-log': openLog(); break;
      case 'edit-log': openLog(id); break;
      case 'delete-log': { const log = state.logs.find(item => item.id === id); if (log) ask('删除这条记录？', '将删除“' + log.taskTitle + '”这条历史记录。任务当前进度不会回退。', '删除记录', () => mutate(next => { next.logs = next.logs.filter(item => item.id !== id); })); break; }
      case 'previous-log-day': logDate = P.addDays(logDate, -1); renderLogs(); break;
      case 'next-log-day': logDate = P.addDays(logDate, 1); renderLogs(); break;
      case 'logs-today': logDate = P.localDate(); renderLogs(); break;
      case 'edit-course': openCourse(id); break;
      case 'delete-course': { const courseId = $('course-form').elements.id.value; ask('删除固定安排？', '之后的任务排程会重新使用这段空闲时间。', '删除安排', () => { mutate(next => { next.courses = next.courses.filter(c => c.id !== courseId); }); $('course-dialog').close(); }); break; }
      case 'previous-day': selectedDate = P.addDays(selectedDate, -1); renderLive(); break;
      case 'next-day': selectedDate = P.addDays(selectedDate, 1); renderLive(); break;
      case 'today': selectedDate = P.localDate(); renderLive(); break;
      case 'fresh-start': ask('清空当前计划？', '将清空当前浏览器中的任务、课表和投入记录。需要保留时，请先在参数偏好中导出备份。', '清空计划', () => { const error = commit(rememberImportHistory(D.emptyState(P.localDate())), { replaceProtectedData: true }); if (error) { notify(error); return; } go('tasks'); notify('当前计划已清空。'); }); break;
      case 'load-demo': ask('载入演示数据？', '当前数据会被替换。需要保留时，请先导出备份。', '载入演示', () => {
        const demo = D.applyTaskProgressDefaults(D.createDemo(P.localDate()));
        if (!demo.ok) { notify(demo.errors.join(' ')); return; }
        const error = commit(rememberImportHistory(demo.value), { replaceProtectedData: true });
        if (error) { notify(error); return; } go('live');
      }); break;
      case 'export-backup':
        if (storageLocked) {
          if (protectedRaw === null) { notify('尚未读取到原始数据，无法导出。请恢复浏览器存储权限后重新打开。'); break; }
          download('有序-原始数据恢复-' + P.localDate() + '.json', protectedRaw, 'application/json'); notify('原始数据已原样导出。'); break;
        }
        download('有序-完整备份-' + P.localDate() + '.json', JSON.stringify(state, null, 2), 'application/json'); notify('完整备份已导出。'); break;
      case 'export-courses': download('有序-课程-' + P.localDate() + '.csv', D.exportCoursesCSV(state.courses), 'text/csv;charset=utf-8'); break;
    }
  });
  $('confirm-accept').addEventListener('click', () => { const fn = confirmCallback; confirmCallback = null; $('confirm-dialog').close(); if (fn) fn(); });
  $('task-form').addEventListener('submit', event => {
    event.preventDefault(); const f = event.currentTarget; if (!f.reportValidity()) return;
    const values = formValues(f), previous = state.tasks.find(t => t.id === values.id), task = { ...previous, ...values, id: values.id || D.id(), flagged: !!f.elements.flagged.checked };
    ['importance', 'enjoyment', 'totalMinutes', 'progress', 'target'].forEach(key => { task[key] = task.kind === 'event' ? previous && previous[key] != null ? previous[key] : null : optionalNumber(values[key]); });
    if (!D.isEvent(task)) { task.progress ??= 0; task.target ??= 100; }
    if (!previous && f.elements.repeatEnabled.checked) {
      const repeated = D.createRecurringTaskBatch(task, { frequency: f.elements.repeatFrequency.value, interval: Number(f.elements.repeatInterval.value), count: Number(f.elements.repeatCount.value) });
      if (!repeated.ok) { $('task-error').textContent = repeated.errors.join(' '); return; }
      const merged = D.mergeTaskBatch(state, repeated.value);
      if (!merged.ok) { $('task-error').textContent = merged.errors.join(' '); return; }
      const error = commit(merged.value, { forceTable: true }); $('task-error').textContent = error;
      if (!error) { $('task-dialog').close(); notify('已创建 ' + merged.added + ' 项周期任务，跳过 ' + merged.skipped + ' 项重复。'); }
      return;
    }
    if (D.isEvent(task) && task.eventStatus !== 'pending' && (!previous || !D.isEvent(previous) || previous.eventStatus !== task.eventStatus) && task.due && !eventHasOccurred(task)) {
      $('task-error').textContent = '固定事件尚未发生，请保留“待发生 / 待确认”状态。'; return;
    }
    const next = JSON.parse(JSON.stringify(state)), index = next.tasks.findIndex(t => t.id === task.id);
    if (index >= 0) next.tasks[index] = task; else next.tasks.push(task);
    if (D.isEvent(task) && task.eventStatus === 'attended' && (!previous || previous.eventStatus !== 'attended')) {
      const log = attendanceLog(task); if (log) next.logs.push(log);
    } else if (previous) {
      const entry = progressLog(previous, task, {});
      if (!entry.ok) { $('task-error').textContent = entry.errors.join(' '); return; }
      if (entry.value) next.logs.push(entry.value);
    }
    const error = commit(next); $('task-error').textContent = error;
    if (!error) { $('task-dialog').close(); notify('任务已保存，排行榜已更新。'); }
  });
  $('task-form').addEventListener('input', () => { updateEstimate(); updateTaskExtras(); });
  $('task-form').addEventListener('change', () => { updateEstimate(); updateTaskExtras(); });
  $('task-kind').addEventListener('change', syncTaskKind);
  $('task-due-precision').addEventListener('change', event => {
    const field = $('task-form').elements.due, current = field.value;
    if (event.currentTarget.value === 'date') { field.type = 'date'; field.value = current ? current.slice(0, 10) : ''; $('task-form').elements.eventEnd.value = ''; }
    else { field.type = 'datetime-local'; field.value = ''; notify('请补充具体截止时刻；原日期为 ' + (current ? current.slice(0, 10) : '未设置') + '。'); }
  });
  $('progress-range').addEventListener('input', () => updateProgressLabels(true));
  $('progress-form').addEventListener('input', event => {
    if (['startedAt', 'endedAt'].includes(event.target.name)) syncLogInterval(event.currentTarget);
    if (event.target.id !== 'progress-range') updateProgressLabels(false);
  });
  $('progress-form').addEventListener('submit', event => {
    event.preventDefault(); const f = event.currentTarget; if (!f.reportValidity()) return;
    const values = formValues(f), next = JSON.parse(JSON.stringify(state)), task = next.tasks.find(t => t.id === values.id); if (!task) return;
    const before = { ...task }; task.progress = optionalNumber(values.progress) ?? 0; task.target = optionalNumber(values.target) ?? 100;
    const entry = progressLog(before, task, values);
    if (!entry.ok) { $('progress-error').textContent = entry.errors.join(' '); return; }
    if (entry.value) next.logs.push(entry.value);
    const error = commit(next); $('progress-error').textContent = error;
    if (!error) { const metrics = D.taskMetrics(task); $('progress-dialog').close(); notify(metrics.done ? '任务已完成。' : metrics.stageReached ? '本轮目标已达成。' : '进度已更新，排行榜已重排。'); }
  });
  $('course-form').addEventListener('submit', event => {
    event.preventDefault(); const f = event.currentTarget; if (!f.reportValidity()) return;
    const values = formValues(f), course = { ...values, id: values.id || D.id(), daily: values.day === 'daily' };
    ['startWeek', 'endWeek'].forEach(key => { course[key] = Number(values[key]); }); course.day = course.daily ? 0 : Number(values.day);
    const next = JSON.parse(JSON.stringify(state)), index = next.courses.findIndex(c => c.id === course.id);
    if (index >= 0) next.courses[index] = course; else next.courses.push(course);
    const error = commit(next); $('course-error').textContent = error;
    if (!error) { $('course-dialog').close(); notify('固定安排已保存，时间安排已更新。'); }
  });
  $('log-date').addEventListener('change', event => { if (event.currentTarget.value) { logDate = event.currentTarget.value; renderLogs(); } });
  $('log-task-select').addEventListener('change', event => {
    const task = state.tasks.find(item => item.id === event.currentTarget.value);
    if (task) $('log-form').elements.taskTitle.value = task.title;
  });
  $('log-form').addEventListener('input', event => { if (['startedAt', 'endedAt'].includes(event.target.name)) syncLogInterval(event.currentTarget); });
  $('log-form').addEventListener('submit', event => {
    event.preventDefault(); const f = event.currentTarget; if (!f.reportValidity()) return;
    const values = formValues(f), previous = state.logs.find(log => log.id === values.id);
    if (values.id && !previous) { $('log-error').textContent = '这条记录已被清理，请重新补记。'; return; }
    const checked = validateWorkLog({ ...values, id: values.id || D.id(), at: previous ? previous.at : new Date().toISOString(), minutes: optionalNumber(values.minutes), fromProgress: optionalNumber(values.fromProgress), toProgress: optionalNumber(values.toProgress) });
    if (!checked.ok) { $('log-error').textContent = checked.errors.join(' '); return; }
    const next = JSON.parse(JSON.stringify(state)), index = next.logs.findIndex(log => log.id === checked.value.id);
    if (index >= 0) next.logs[index] = checked.value; else next.logs.push(checked.value);
    logDate = checked.value.date;
    const error = commit(next); $('log-error').textContent = error;
    if (!error) { $('log-dialog').close(); notify('每日记录已保存到本地。'); }
  });
  $('settings-form').addEventListener('submit', event => event.preventDefault());
  $('ai-form').addEventListener('submit', generateAIPlan);
  $('ai-form').addEventListener('input', () => { cancelAIRequest(); clearAIPlan(); $('ai-error').textContent = ''; });
  $('ai-provider').addEventListener('change', () => {
    cancelAIRequest(); clearAIPlan(); $('ai-error').textContent = '';
    const provider = A.PROVIDERS[$('ai-provider').value];
    if (provider) { $('ai-endpoint').textContent = provider.url; $('ai-model').value = provider.defaultModel; }
    $('ai-api-key').value = '';
  });
  $('ai-dialog').addEventListener('close', cancelAIRequest);
  $('pku-form').addEventListener('submit', event => runPKUOperation('sync', event));
  $('pku-form').addEventListener('input', event => {
    cancelPKURequest(); clearPKUPlan(); $('pku-error').textContent = '';
    if (event.target.name === 'remember') pkuRememberTouched = true;
    if (event.target.name === 'pairing') { pkuRememberKnown = false; pkuRememberKey = event.target.value.trim(); }
    if (['username', 'password', 'pairing'].includes(event.target.name)) clearPKUVerification();
  });
  $('pku-remember').addEventListener('change', () => { pkuRememberTouched = true; });
  $('pku-item-list').addEventListener('change', event => {
    if (event.target.dataset.pkuIndex !== undefined) $('pku-select-' + event.target.dataset.pkuIndex).checked = !!event.target.value;
  });
  $('pku-dialog').addEventListener('close', () => {
    cancelPKURequest(); clearPKUPlan(); clearPKUVerification(); $('pku-password').value = ''; $('pku-username').value = '';
    pkuRememberKnown = false; pkuRememberTouched = false;
    $('pku-error').textContent = ''; $('pku-status').textContent = '';
  });
  $('settings-form').addEventListener('input', event => {
    if (!event.target.id.startsWith('weight-')) return; updateWeightLabels();
    const next = JSON.parse(JSON.stringify(state)); ['importance', 'urgency', 'enjoyment'].forEach(key => { next.settings.weights[key] = Number($('weight-' + key).value); });
    $('settings-error').textContent = commit(next, { settings: false });
  });
  $('settings-form').addEventListener('change', event => {
    if (!event.target.name || ['importance', 'urgency', 'enjoyment'].includes(event.target.name)) return;
    const f = event.currentTarget, next = JSON.parse(JSON.stringify(state));
    ['dayStart', 'dayEnd', 'semesterStart', 'taskView'].forEach(key => { next.settings[key] = f.elements[key].value; });
    ['dailyBudget', 'blockMinutes', 'breakMinutes', 'courseBuffer', 'semesterWeeks'].forEach(key => { next.settings[key] = Number(f.elements[key].value); });
    next.settings.useDailyBudget = !!f.elements.useDailyBudget.checked; f.elements.dailyBudget.disabled = !next.settings.useDailyBudget;
    $('settings-error').textContent = commit(next, { settings: false });
  });
  $('task-filter').addEventListener('change', () => renderTasks({ forceTable: true }));
  $('task-table-body').addEventListener('input', event => {
    const control = tableControl(event); if (!control) return;
    if (rememberTableDraft(control)) $('task-table-status').textContent = '正在编辑，离开输入框或按 Enter 保存。';
  });
  $('task-table-body').addEventListener('change', event => { const control = tableControl(event); if (control) saveTableRow(control); });
  $('task-table-body').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    const control = tableControl(event); if (!control) return;
    event.preventDefault();
    if (!saveTableRow(control)) return;
    for (const id of tableRowIds.slice(tableRowIds.indexOf(control.dataset.id) + 1)) {
      const next = $('grid-' + control.dataset.tableField + '-' + id);
      if (next && !next.disabled) { next.focus(); if (next.select && next.type === 'number') next.select(); break; }
    }
  });
  $('task-table-body').addEventListener('focusout', () => { setTimeout(() => { if (!tableIsEditing()) renderTaskTable(); }, 0); });
  $('plan-date').addEventListener('change', event => { if (event.target.value && /^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) { selectedDate = event.target.value; renderLive(); } });
  $('backup-import').addEventListener('change', async event => {
    const input = event.currentTarget, file = input.files[0]; if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('备份文件过大，请选择 5 MB 以内的 JSON。');
      const result = D.validateState(JSON.parse(await file.text())); if (!result.ok) throw new Error(result.errors.slice(0, 3).join(' '));
      ask('导入这份备份？', '包含 ' + result.value.tasks.length + ' 件任务、' + result.value.courses.length + ' 个固定安排，将替换当前数据。', '替换并导入', () => { const error = commit(rememberImportHistory(result.value), { replaceProtectedData: true }); notify(error || '备份已导入。'); });
    } catch (error) { notify('导入失败：' + error.message); } finally { input.value = ''; }
  });
  $('task-batch-import').addEventListener('change', async event => {
    const input = event.currentTarget, file = input.files[0]; if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('任务文件过大，请选择 5 MB 以内的 JSON。');
      const checked = D.validateTaskBatch(JSON.parse(await file.text()));
      if (!checked.ok) throw new Error(checked.errors.slice(0, 3).join(' '));
      const batch = checked.value;
      ask('追加这些任务？', '将合并 ' + batch.tasks.length + ' 件任务。保留已有真实任务、课表、参数和记录，并跳过重复项。', '追加任务', () => {
        const merged = D.mergeTaskBatch(state, batch);
        if (!merged.ok) { notify(merged.errors.join(' ')); return; }
        const error = commit(merged.value);
        notify(error || '新增 ' + merged.added + ' 件，跳过 ' + merged.skipped + ' 件重复或已导入事项。');
      });
    } catch (error) { notify('任务导入失败：' + error.message); } finally { input.value = ''; }
  });
  $('course-import').addEventListener('change', async event => {
    const input = event.currentTarget, file = input.files[0]; if (!file) return;
    try {
      if (file.size > 1024 * 1024) throw new Error('CSV 文件过大，请选择 1 MB 以内的文件。');
      const result = D.parseCoursesCSV(await file.text()); if (result.errors.length) throw new Error(result.errors.slice(0, 3).join(' '));
      if (!result.courses.length) throw new Error('没有找到课程行。表头请使用：课程,星期,开始,结束,地点,单双周,起始周,结束周。');
      ask('添加导入的课程？', '将添加 ' + result.courses.length + ' 个固定安排，现有课表会保留。重复导入会产生重复课程。', '添加课程', () => { if (mutate(next => { next.courses.push(...result.courses); })) notify('课程已导入，时间安排已重算。'); });
    } catch (error) { notify('导入失败：' + error.message); } finally { input.value = ''; }
  });
  $('timetable-image').addEventListener('change', event => {
    const file = event.currentTarget.files[0]; if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 15 * 1024 * 1024) { notify('请选择 15 MB 以内的课表图片。'); return; }
    if (imageURL) URL.revokeObjectURL(imageURL); imageURL = URL.createObjectURL(file);
    const img = document.createElement('img'); img.src = imageURL; img.alt = '用户选择的课表图片，仅作录入对照'; img.addEventListener('error', () => notify('此图片格式无法显示，请改用 PNG 或 JPG。'));
    $('image-preview').replaceChildren(img);
  });
  window.addEventListener('storage', event => {
    if (event.key !== D.STORAGE_KEY || event.newValue === null) return;
    if (storageLocked) { notify('另一标签页中的本地数据已变化。请重新打开以检查，当前仍暂停写入。'); return; }
    try {
      const result = D.validateState(JSON.parse(event.newValue));
      if (result.ok) { state = result.value; lastSaved = true; render(); notify('已同步此浏览器另一标签页的更改。'); return; }
    } catch (error) { /* Preserve an unreadable external update instead of overwriting it. */ }
    storageLocked = true; protectedRaw = event.newValue; storageReadError = false; lastSaved = false;
    render(); notify('另一标签页的数据格式无法读取，原数据已保留，当前暂停写入。可先导出原始数据。');
  });
  function tick() { $('clock').textContent = new Date().toLocaleString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { runLogRetention(); tick(); renderLive(); renderTasks(); renderLogs(); } });
  state = load();
  let processedBatch = false, processedDefaults = false, importedCount = 0, importError = '';
  if (!storageLocked && window.PlannerImports && Array.isArray(window.PlannerImports.batches)) {
    for (const batch of window.PlannerImports.batches) {
      if (batch.id && state.appliedBatches.includes(batch.id)) continue;
      const merged = D.mergeTaskBatch(state, batch);
      if (!merged.ok) { importError = merged.errors.join(' '); continue; }
      processedBatch = true;
      const error = commit(merged.value);
      if (error) importError = error; else importedCount += merged.added;
    }
  }
  if (!storageLocked) {
    const migrated = D.applyTaskProgressDefaults(state);
    if (!migrated.ok) importError = migrated.errors.join(' ');
    else if (migrated.changed) {
      processedDefaults = true;
      const error = commit(migrated.value);
      if (error) importError = error;
    }
  }
  if (!processedDefaults && ((initializeStorage && !processedBatch) || (persistEventMigration && !storageLocked))) save(state);
  runLogRetention(); render(); go(location.hash.slice(1) || 'live'); tick();
  if (importError) notify('更新未保存：' + importError);
  else if (importedCount) notify('已追加 ' + importedCount + ' 件待办。任务默认进度 0%、目标 100%；估时和评分保持留空。');
  else if (processedDefaults) notify('未填写的进度与目标已补齐默认值，已有进度保持不变。');
  setInterval(tick, 1000); setInterval(() => { runLogRetention(); renderLive(); renderTasks(); renderLogs(); }, 60000);
})();
