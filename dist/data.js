(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PlannerData = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var STORAGE_KEY = 'student-planner:v1';
  var TASK_PROGRESS_DEFAULTS_MIGRATION_ID = 'task-progress-defaults-0-100-v1';
  var CATEGORIES = ['实习', '课业', '课余', '生活'];
  var MODES = ['all', 'odd', 'even'];
  var MAX_ITEMS = 2000;
  var counter = 0;
  var own = function (object, key) { return Object.prototype.hasOwnProperty.call(object, key); };
  var pad = function (value) { return String(value).padStart(2, '0'); };

  function id() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    counter += 1;
    return 'p-' + Date.now().toString(36) + '-' + counter.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function localDate(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }
  function isDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    var parts = value.split('-').map(Number);
    if (parts[0] < 1900 || parts[0] > 2200) return false;
    var date = new Date(parts[0], parts[1] - 1, parts[2], 12);
    return date.getFullYear() === parts[0] && date.getMonth() === parts[1] - 1 && date.getDate() === parts[2];
  }
  function isTime(value) {
    return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
  }
  function isDue(value) {
    return typeof value === 'string' && (value === '' || isDate(value) || (value.length === 16 && value[10] === 'T' && isDate(value.slice(0, 10)) && isTime(value.slice(11))));
  }
  function isISO(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) return false;
    return isDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
  }
  function parseDate(dateString) {
    var source = isDate(dateString) ? dateString : localDate(new Date());
    var parts = source.split('-').map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2], 12);
  }
  function defaultSettings(dateString) {
    var semester = parseDate(dateString);
    semester.setDate(semester.getDate() - (semester.getDay() + 6) % 7 - 56);
    return {
      weights: { importance: 60, urgency: 35, enjoyment: -10 },
      taskView: 'table',
      dayStart: '08:00', dayEnd: '22:00', dailyBudget: 240, useDailyBudget: false,
      blockMinutes: 45, breakMinutes: 10, courseBuffer: 10,
      semesterStart: localDate(semester), semesterWeeks: 20
    };
  }
  function emptyState(dateString) {
    return { version: 1, demo: false, tasks: [], courses: [], settings: defaultSettings(dateString), logs: [], appliedBatches: [], appliedMigrations: [] };
  }
  function isEvent(task) { return !!task && task.kind === 'event'; }
  function taskMetrics(task) {
    if (isEvent(task)) return { remaining: 0, overallRemaining: 0, stageReached: false, done: task.eventStatus === 'attended' || task.eventStatus === 'missed', needsEstimate: false };
    var hasTotal = typeof task.totalMinutes === 'number' && Number.isFinite(task.totalMinutes);
    var hasProgress = typeof task.progress === 'number' && Number.isFinite(task.progress);
    var hasTarget = typeof task.target === 'number' && Number.isFinite(task.target);
    // Work in tenths of a percent so floating-point subtraction cannot add a minute.
    var progress = hasProgress ? Math.round(task.progress * 10) : null;
    var target = hasTarget ? Math.round(task.target * 10) : null;
    var done = hasProgress && progress >= 1000;
    var stageReached = done || (hasProgress && hasTarget && progress >= target);
    var remaining = stageReached ? 0 : hasTotal && hasProgress && hasTarget ? Math.ceil(task.totalMinutes * Math.max(0, target - progress) / 1000) : null;
    var overallRemaining = done ? 0 : hasTotal && hasProgress ? Math.ceil(task.totalMinutes * Math.max(0, 1000 - progress) / 1000) : null;
    return {
      remaining: remaining,
      overallRemaining: overallRemaining,
      stageReached: stageReached,
      done: done,
      needsEstimate: remaining === null || task.importance === null || task.enjoyment === null
    };
  }
  function createDemo(dateString) {
    var state = emptyState(dateString);
    state.demo = true;
    function dueAfter(days, time) {
      var date = parseDate(dateString);
      date.setDate(date.getDate() + days);
      return localDate(date) + 'T' + time;
    }
    state.tasks = [
      { id: id(), title: '【示例】完成实习周报', category: '实习', importance: 5, enjoyment: 2, totalMinutes: 300, progress: 20, target: 50, due: dueAfter(1, '18:00'), nextAction: '整理本周完成的三项工作，先写完周报初稿' },
      { id: id(), title: '【示例】高等数学作业', category: '课业', importance: 5, enjoyment: 1, totalMinutes: 240, progress: 25, target: 75, due: dueAfter(2, '23:00'), nextAction: '先完成第一组习题，标记不会的题目' },
      { id: id(), title: '【示例】社团活动海报', category: '课余', importance: 3, enjoyment: 5, totalMinutes: 120, progress: 0, target: 50, due: dueAfter(4, '20:00'), nextAction: '收集两张参考图，确定版式和主标题' },
      { id: id(), title: '【示例】整理宿舍与洗衣', category: '生活', importance: 2, enjoyment: 3, totalMinutes: 30, progress: 0, target: 100, due: '', nextAction: '收好桌面，开始洗一桶衣服' }
    ].map(function (task) {
      var metrics = taskMetrics(task);
      task.remaining = metrics.remaining;
      task.done = metrics.done;
      return task;
    });
    state.courses = [
      { id: id(), title: '【示例】高等数学', day: 1, daily: false, start: '08:00', end: '09:35', location: '教学楼 A201', weekMode: 'all', startWeek: 1, endWeek: 20 },
      { id: id(), title: '【示例】大学英语', day: 3, daily: false, start: '10:00', end: '11:35', location: '教学楼 B302', weekMode: 'all', startWeek: 1, endWeek: 20 },
      { id: id(), title: '【示例】体育', day: 5, daily: false, start: '14:00', end: '15:35', location: '体育馆', weekMode: 'odd', startWeek: 1, endWeek: 20 }
    ];
    return state;
  }

  function isObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function prohibitedKey(value, seen, depth) {
    if (!value || typeof value !== 'object') return false;
    if (depth > 20 || seen.has(value)) return true;
    seen.add(value);
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i] === '__proto__' || keys[i] === 'constructor' || keys[i] === 'prototype' || prohibitedKey(value[keys[i]], seen, depth + 1)) return true;
    }
    seen.delete(value);
    return false;
  }
  function normalizeLog(input) {
    if (!isObject(input) || prohibitedKey(input, new Set(), 0)) return { ok: false, errors: ['记录必须是安全的对象。'] };
    var errors = [];
    function text(value, name, max, empty) {
      if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
        errors.push(name + '必须是' + (empty ? '不超过' : '非空且不超过') + max + '字的文本。'); return '';
      }
      return value.trim();
    }
    function progress(value, name) {
      if (value === null) return null;
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100 || Math.abs(value * 10 - Math.round(value * 10)) > 1e-7) {
        errors.push(name + '必须为空或0至100之间、最多一位小数的百分比。'); return null;
      }
      return Math.round(value * 10) / 10;
    }
    var log = {
      id: text(input.id, '记录id', 100, false),
      taskId: text(own(input, 'taskId') ? input.taskId : '', '关联任务id', 100, true),
      taskTitle: text(input.taskTitle, '事项标题', 200, false),
      date: input.date,
      minutes: own(input, 'minutes') ? input.minutes : null,
      at: input.at,
      note: text(own(input, 'note') ? input.note : '', '记录内容', 2000, true),
      fromProgress: progress(own(input, 'fromProgress') ? input.fromProgress : null, '原进度'),
      toProgress: progress(own(input, 'toProgress') ? input.toProgress : null, '新进度'),
      status: own(input, 'status') ? input.status : 'activity',
      startedAt: own(input, 'startedAt') ? input.startedAt : '',
      endedAt: own(input, 'endedAt') ? input.endedAt : ''
    };
    if (!isDate(log.date)) errors.push('记录日期无效，应为 YYYY-MM-DD。');
    if (!isISO(log.at)) errors.push('创建时间必须是有效 ISO 时间。');
    if (['partial', 'completed', 'activity'].indexOf(log.status) === -1) errors.push('记录状态必须是 partial、completed 或 activity。');
    var validStart = log.startedAt === '' || typeof log.startedAt === 'string' && log.startedAt.length === 16 && isDue(log.startedAt);
    var validEnd = log.endedAt === '' || typeof log.endedAt === 'string' && log.endedAt.length === 16 && isDue(log.endedAt);
    if (!validStart || !validEnd) errors.push('起止时刻应为空或 YYYY-MM-DDTHH:mm。');
    if (validStart && validEnd && ((log.startedAt === '') !== (log.endedAt === ''))) errors.push('开始和结束时刻必须同时填写。');
    if (validStart && validEnd && log.startedAt && log.endedAt) {
      var duration = (new Date(log.endedAt).getTime() - new Date(log.startedAt).getTime()) / 60000;
      if (!Number.isInteger(duration) || duration < 1 || duration > 1440) errors.push('结束时刻必须晚于开始时刻，单条记录最长24小时。');
      else log.minutes = duration;
      if (log.date !== log.startedAt.slice(0, 10)) errors.push('记录日期必须与开始时刻的日期一致。');
    } else if (log.minutes !== null && (typeof log.minutes !== 'number' || !Number.isInteger(log.minutes) || log.minutes < 1 || log.minutes > 1440)) {
      errors.push('实际分钟必须为空或1至1440之间的整数。');
    }
    if (log.toProgress !== null) log.status = log.toProgress >= 100 ? 'completed' : 'partial';
    else if (log.fromProgress !== null) log.status = 'partial';
    return errors.length ? { ok: false, errors: errors } : { ok: true, value: log, errors: [] };
  }
  function summarizeLogs(logs, dateString) {
    var entries = (Array.isArray(logs) ? logs : []).map(normalizeLog).filter(function (checked) {
      return checked.ok && checked.value.date === dateString;
    }).map(function (checked) { return checked.value; });
    function instant(log) { return Date.parse(log.startedAt || log.at); }
    entries.sort(function (a, b) { return instant(b) - instant(a) || Date.parse(b.at) - Date.parse(a.at) || a.id.localeCompare(b.id); });
    return {
      entries: entries,
      totalMinutes: entries.reduce(function (total, log) { return total + (log.minutes === null ? 0 : log.minutes); }, 0),
      completedCount: entries.filter(function (log) { return log.status === 'completed'; }).length,
      partialCount: entries.filter(function (log) { return log.status === 'partial'; }).length,
      unknownDurationCount: entries.filter(function (log) { return log.minutes === null; }).length
    };
  }
  function pruneLogs(logs, today) {
    var date = parseDate(today); date.setDate(date.getDate() - 13);
    var cutoff = localDate(date), source = Array.isArray(logs) ? logs : [];
    var retained = source.filter(function (log) {
      // Retention removes only dates we can positively identify as expired.
      // Future entries remain available for normal validation/UI handling.
      return !log || !isDate(log.date) || log.date >= cutoff;
    });
    return { logs: retained, removed: source.length - retained.length, cutoff: cutoff };
  }
  function validateState(input) {
    var errors = [];
    if (!isObject(input)) return { ok: false, errors: ['备份必须是一个 JSON 对象。'] };
    if (prohibitedKey(input, new Set(), 0)) return { ok: false, errors: ['备份包含不安全的对象字段或过深、循环结构。'] };
    function object(value, path) {
      if (!isObject(value)) { errors.push(path + '必须是对象。'); return {}; }
      return value;
    }
    function string(value, path, max, allowEmpty) {
      if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) {
        errors.push(path + '必须是' + (allowEmpty ? '不超过' : '非空且不超过') + max + '字的文本。');
        return '';
      }
      return value.trim();
    }
    function integer(value, path, min, max) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
        errors.push(path + '必须是' + min + '至' + max + '之间的整数。');
        return min;
      }
      return value;
    }
    function percentage(value, path, min) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > 100 || Math.abs(value * 10 - Math.round(value * 10)) > 1e-7) {
        errors.push(path + '必须是' + min + '至100之间、最多一位小数的百分比。');
        return min;
      }
      return Math.round(value * 10) / 10;
    }
    function boolean(value, path) {
      if (typeof value !== 'boolean') { errors.push(path + '必须是布尔值。'); return false; }
      return value;
    }
    function date(value, path) {
      if (!isDate(value)) { errors.push(path + '日期无效，应为 YYYY-MM-DD。'); return ''; }
      return value;
    }
    function time(value, path) {
      if (!isTime(value)) { errors.push(path + '时间无效，应为 HH:mm。'); return ''; }
      return value;
    }
    function list(value, path) {
      if (!Array.isArray(value) || value.length > MAX_ITEMS) { errors.push(path + '必须是最多' + MAX_ITEMS + '项的数组。'); return []; }
      return value;
    }
    function unique(items, path) {
      var seen = new Set();
      items.forEach(function (item) {
        if (seen.has(item.id)) errors.push(path + '包含重复的 id。');
        seen.add(item.id);
      });
      return items;
    }
    if (input.version !== 1) errors.push('备份版本不支持，当前支持 version: 1。');
    var state = { version: 1, demo: boolean(input.demo, 'demo'), tasks: [], courses: [], settings: {}, logs: [], appliedBatches: [], appliedMigrations: [] };
    if (own(input, 'appliedBatches')) {
      state.appliedBatches = list(input.appliedBatches, '已导入批次').map(function (value, index) { return string(value, '已导入批次' + (index + 1), 100, false); });
      if (new Set(state.appliedBatches).size !== state.appliedBatches.length) errors.push('已导入批次不能重复。');
    }
    if (own(input, 'appliedMigrations')) {
      state.appliedMigrations = list(input.appliedMigrations, '已应用迁移').map(function (value, index) { return string(value, '已应用迁移' + (index + 1), 100, false); });
      if (new Set(state.appliedMigrations).size !== state.appliedMigrations.length) errors.push('已应用迁移不能重复。');
    }
    state.tasks = unique(list(input.tasks, '任务列表').map(function (item, index) {
      var path = '任务' + (index + 1) + '：';
      item = object(item, path);
      var kind = own(item, 'kind') ? item.kind : 'task';
      var legacy = !own(item, 'totalMinutes') && !own(item, 'progress') && !own(item, 'target') && own(item, 'remaining');
      var total = item.totalMinutes;
      var progress = item.progress;
      var target = item.target;
      var importance = item.importance, enjoyment = item.enjoyment;
      if (legacy) {
        var oldRemaining = integer(item.remaining, path + '旧版剩余分钟', 0, 60000);
        var oldDone = boolean(item.done, path + '旧版完成状态');
        if (!oldDone && oldRemaining < 5) errors.push(path + '旧版未完成任务至少需要5分钟。');
        total = Math.max(5, oldRemaining);
        progress = oldDone ? 100 : 0;
        target = 100;
      }
      if (kind === 'event') {
        if (!own(item, 'totalMinutes') && !legacy) total = null;
        if (!own(item, 'progress') && !legacy) progress = null;
        if (!own(item, 'target') && !legacy) target = null;
        if (!own(item, 'importance')) importance = null;
        if (!own(item, 'enjoyment')) enjoyment = null;
      }
      var task = {
        id: string(item.id, path + 'id', 100, false),
        title: string(item.title, path + '标题', 200, false),
        kind: kind,
        eventStatus: own(item, 'eventStatus') ? item.eventStatus : 'pending',
        eventEnd: own(item, 'eventEnd') ? item.eventEnd : '',
        eventLocation: own(item, 'eventLocation') ? string(item.eventLocation, path + '活动地点', 200, true) : '',
        category: item.category,
        importance: importance === null ? null : integer(importance, path + '重要性', 1, 5),
        enjoyment: enjoyment === null ? null : integer(enjoyment, path + '愉悦性', 1, 5),
        totalMinutes: total === null ? null : integer(total, path + '整体预计分钟', 5, 60000),
        progress: progress === null ? null : percentage(progress, path + '当前进度', 0),
        target: target === null ? null : percentage(target, path + '本轮目标', 1),
        due: item.due,
        nextAction: string(item.nextAction, path + '下一步', 1000, true),
        flagged: own(item, 'flagged') ? boolean(item.flagged, path + '标记') : false,
        sourceGroup: own(item, 'sourceGroup') ? string(item.sourceGroup, path + '来源分组', 100, true) : ''
      };
      var metrics = taskMetrics(task);
      task.remaining = metrics.remaining;
      task.done = metrics.done;
      task.duePrecision = task.due === '' ? 'none' : typeof task.due === 'string' && task.due.length === 10 ? 'date' : 'time';
      if (['task', 'event'].indexOf(task.kind) === -1) errors.push(path + '事项类型必须是 task 或 event。');
      if (['pending', 'attended', 'missed'].indexOf(task.eventStatus) === -1) errors.push(path + '活动状态必须是 pending、attended 或 missed。');
      if (task.eventEnd !== '' && !(typeof task.eventEnd === 'string' && task.eventEnd.length === 16 && isDue(task.eventEnd))) errors.push(path + '活动结束时刻必须为空或 YYYY-MM-DDTHH:mm。');
      if (isEvent(task) && task.eventEnd !== '') {
        if (!(typeof task.due === 'string' && task.due.length === 16 && isDue(task.due))) errors.push(path + '填写结束时刻前，请先填写精确的活动开始时刻。');
        else if (typeof task.eventEnd === 'string' && task.eventEnd.length === 16 && isDue(task.eventEnd)) {
          var eventDuration = (new Date(task.eventEnd).getTime() - new Date(task.due).getTime()) / 60000;
          if (eventDuration <= 0 || eventDuration > 10080) errors.push(path + '活动结束必须晚于开始，且跨度不超过7天。');
        }
      }
      if (CATEGORIES.indexOf(task.category) === -1) errors.push(path + '分类必须是实习、课业、课余或生活。');
      if (!isDue(task.due)) errors.push(path + '截止时间无效，应为空、YYYY-MM-DD 或 YYYY-MM-DDTHH:mm。');
      return task;
    }), '任务列表');
    state.courses = unique(list(input.courses, '课程列表').map(function (item, index) {
      var path = '课程' + (index + 1) + '：';
      item = object(item, path);
      var course = {
        id: string(item.id, path + 'id', 100, false),
        title: string(item.title, path + '名称', 200, false),
        day: integer(item.day, path + '星期', 0, 6),
        daily: own(item, 'daily') ? boolean(item.daily, path + '每天重复') : false,
        start: time(item.start, path + '开始'),
        end: time(item.end, path + '结束'),
        location: string(item.location, path + '地点', 200, true),
        weekMode: item.weekMode,
        startWeek: integer(item.startWeek, path + '起始周', 1, 52),
        endWeek: integer(item.endWeek, path + '结束周', 1, 52)
      };
      if (course.start && course.end && course.start >= course.end) errors.push(path + '结束时间必须晚于开始时间。');
      if (MODES.indexOf(course.weekMode) === -1) errors.push(path + '单双周必须是 all、odd 或 even。');
      if (course.startWeek > course.endWeek) errors.push(path + '结束周不能早于起始周。');
      return course;
    }), '课程列表');
    var settings = object(input.settings, '设置');
    var weights = object(settings.weights, '权重');
    state.settings = {
      weights: {
        importance: integer(weights.importance, '重要性权重', 0, 100),
        urgency: integer(weights.urgency, '紧急性权重', 0, 100),
        enjoyment: integer(weights.enjoyment, '愉悦性权重', -100, 100)
      },
      taskView: own(settings, 'taskView') ? settings.taskView : 'table',
      dayStart: time(settings.dayStart, '每日开始'), dayEnd: time(settings.dayEnd, '每日结束'),
      dailyBudget: integer(settings.dailyBudget, '每日任务分钟', 15, 840),
      useDailyBudget: own(settings, 'useDailyBudget') ? boolean(settings.useDailyBudget, '启用每日任务上限') : false,
      blockMinutes: integer(settings.blockMinutes, '专注时长', 5, 180),
      breakMinutes: integer(settings.breakMinutes, '休息时长', 0, 60),
      courseBuffer: integer(settings.courseBuffer, '课程缓冲分钟', 0, 60),
      semesterStart: date(settings.semesterStart, '学期开始'),
      semesterWeeks: integer(settings.semesterWeeks, '学期周数', 1, 52)
    };
    if (['table', 'cards'].indexOf(state.settings.taskView) === -1) errors.push('任务视图必须是 table 或 cards。');
    if (state.settings.dayStart && state.settings.dayEnd && state.settings.dayStart >= state.settings.dayEnd) errors.push('每日结束时间必须晚于开始时间。');
    state.logs = unique(list(input.logs, '记录列表').map(function (item, index) {
      var checked = normalizeLog(item);
      if (!checked.ok) { checked.errors.forEach(function (error) { errors.push('记录' + (index + 1) + '：' + error); }); return { id: '' }; }
      return checked.value;
    }), '记录列表');
    return errors.length ? { ok: false, errors: errors } : { ok: true, value: state, errors: [] };
  }

  function validateTaskBatch(input) {
    if (!isObject(input) || prohibitedKey(input, new Set(), 0)) return { ok: false, errors: ['任务批次必须是安全的 JSON 对象。'] };
    if (input.type !== 'youxu-task-batch' || input.version !== 1) return { ok: false, errors: ['任务批次需使用 type: youxu-task-batch、version: 1。'] };
    if (own(input, 'id') && (typeof input.id !== 'string' || !input.id.trim() || input.id.length > 100)) return { ok: false, errors: ['批次 id 必须是1至100字的文本。'] };
    if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_ITEMS) return { ok: false, errors: ['任务批次必须包含1至2000条任务。'] };
    var errors = [];
    var tasks = input.tasks.map(function (item, index) {
      if (!isObject(item)) { errors.push('任务' + (index + 1) + '必须是对象。'); return {}; }
      var task = {
        id: own(item, 'id') ? item.id : id(), title: item.title,
        category: own(item, 'category') ? item.category : '课业',
        due: own(item, 'due') ? item.due : '',
        nextAction: own(item, 'nextAction') ? item.nextAction : '',
        flagged: own(item, 'flagged') ? item.flagged : false,
        sourceGroup: own(item, 'sourceGroup') ? item.sourceGroup : ''
      };
      ['totalMinutes', 'importance', 'enjoyment', 'progress', 'target'].forEach(function (key) {
        task[key] = own(item, key) ? item[key] : null;
      });
      ['kind', 'eventStatus', 'eventEnd', 'eventLocation'].forEach(function (key) { if (own(item, key)) task[key] = item[key]; });
      if (own(item, 'done')) task.done = item.done;
      return task;
    });
    if (errors.length) return { ok: false, errors: errors };
    var probe = emptyState(); probe.tasks = tasks;
    var checked = validateState(probe);
    if (!checked.ok) return checked;
    // Complete-backup validation remains lossless; only new batch entries gain
    // the requested 0% -> 100% defaults, with their derived fields recomputed.
    checked.value.tasks.forEach(function (task) {
      if (isEvent(task)) return;
      if (task.progress === null) task.progress = 0;
      if (task.target === null) task.target = 100;
    });
    checked = validateState(checked.value);
    if (!checked.ok) return checked;
    var value = { type: 'youxu-task-batch', version: 1, tasks: checked.value.tasks };
    if (own(input, 'id')) value.id = input.id.trim();
    return { ok: true, value: value, errors: [] };
  }
  function applyTaskProgressDefaults(input) {
    var checked = validateState(input);
    if (!checked.ok) return { ok: false, changed: false, errors: checked.errors };
    var state = checked.value;
    if (state.appliedMigrations.indexOf(TASK_PROGRESS_DEFAULTS_MIGRATION_ID) !== -1) return { ok: true, value: state, changed: false, errors: [] };
    if (state.appliedMigrations.length >= MAX_ITEMS) return { ok: false, changed: false, errors: ['已应用迁移超过2000项，未执行进度默认值迁移。'] };
    state.tasks.forEach(function (task) {
      if (isEvent(task)) return;
      if (task.progress === null) task.progress = 0;
      if (task.target === null) task.target = 100;
      var metrics = taskMetrics(task); task.remaining = metrics.remaining; task.done = metrics.done;
    });
    state.appliedMigrations.push(TASK_PROGRESS_DEFAULTS_MIGRATION_ID);
    return { ok: true, value: state, changed: true, errors: [] };
  }
  function removeUntouchedDemo(state) {
    var offsets = { '【示例】完成实习周报': 1, '【示例】高等数学作业': 2, '【示例】社团活动海报': 4 };
    var votes = {}, baseDate = '', voteCount = 0;
    state.tasks.forEach(function (task) {
      if (!own(offsets, task.title) || task.due.length !== 16) return;
      var date = parseDate(task.due.slice(0, 10)); date.setDate(date.getDate() - offsets[task.title]);
      var candidate = localDate(date); votes[candidate] = (votes[candidate] || 0) + 1;
      if (votes[candidate] > voteCount) { voteCount = votes[candidate]; baseDate = candidate; }
    });
    // Require agreement between two sample deadlines before removing dated
    // demos. A user-edited deadline then remains conservatively untouched.
    if (voteCount < 2) baseDate = '';
    var demo = createDemo(baseDate), loggedIds = new Set(state.logs.map(function (log) { return log.taskId; }));
    var taskKeys = ['title', 'category', 'importance', 'enjoyment', 'totalMinutes', 'progress', 'target', 'nextAction'];
    var courseKeys = ['title', 'day', 'daily', 'start', 'end', 'location', 'weekMode', 'startWeek', 'endWeek'];
    var removed = new Set();
    state.tasks = state.tasks.filter(function (task) {
      if (loggedIds.has(task.id) || task.flagged || task.sourceGroup) return true;
      var template = demo.tasks.find(function (sample) { return taskKeys.every(function (key) { return task[key] === sample[key]; }); });
      if (!template) return true;
      if (template.due !== task.due || (template.due && !baseDate)) return true;
      removed.add(task.id); return false;
    });
    state.courses = state.courses.filter(function (course) {
      return !demo.courses.some(function (sample) { return courseKeys.every(function (key) { return course[key] === sample[key]; }); });
    });
    state.logs = state.logs.filter(function (log) { return !removed.has(log.taskId); });
  }
  function mergeTaskBatch(current, batch) {
    var checkedState = validateState(current), checkedBatch = validateTaskBatch(batch);
    if (!checkedState.ok) return { ok: false, added: 0, skipped: 0, errors: checkedState.errors };
    if (!checkedBatch.ok) return { ok: false, added: 0, skipped: 0, errors: checkedBatch.errors };
    var state = checkedState.value;
    if (checkedBatch.value.id && state.appliedBatches.indexOf(checkedBatch.value.id) !== -1) return { ok: true, value: state, added: 0, skipped: checkedBatch.value.tasks.length, errors: [] };
    if (checkedBatch.value.id && state.appliedBatches.length >= MAX_ITEMS) return { ok: false, added: 0, skipped: 0, errors: ['已导入批次超过2000项，未导入本批任务。'] };
    if (state.demo) removeUntouchedDemo(state);
    state.demo = false;
    function key(task) {
      return task.title.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() + '\u0000' + task.duePrecision + '\u0000' + task.due;
    }
    var keys = new Set(state.tasks.map(key)), ids = new Set(state.tasks.map(function (task) { return task.id; }));
    var added = 0, skipped = 0;
    checkedBatch.value.tasks.forEach(function (task) {
      var normalized = key(task);
      if (keys.has(normalized) || ids.has(task.id)) { skipped += 1; return; }
      state.tasks.push(task); keys.add(normalized); ids.add(task.id); added += 1;
    });
    if (state.tasks.length > MAX_ITEMS) return { ok: false, added: 0, skipped: 0, errors: ['合并后任务超过2000条，未导入本批任务。'] };
    if (checkedBatch.value.id) state.appliedBatches.push(checkedBatch.value.id);
    return { ok: true, value: state, added: added, skipped: skipped, errors: [] };
  }

  function createRecurringTaskBatch(input, options) {
    if (!isObject(options) || prohibitedKey(options, new Set(), 0)) return { ok: false, errors: ['周期参数必须是安全的对象。'] };
    if (['daily', 'weekly'].indexOf(options.frequency) === -1) return { ok: false, errors: ['周期频率必须是 daily 或 weekly。'] };
    if (!Number.isInteger(options.interval) || options.interval < 1 || options.interval > 12) return { ok: false, errors: ['周期间隔必须是1至12之间的整数。'] };
    if (!Number.isInteger(options.count) || options.count < 2 || options.count > 52) return { ok: false, errors: ['创建次数必须是2至52之间的整数，包含本次。'] };
    var checked = validateTaskBatch({ type: 'youxu-task-batch', version: 1, tasks: [input] });
    if (!checked.ok) return checked;
    var first = checked.value.tasks[0];
    if (isEvent(first)) return { ok: false, errors: ['固定事件不能按可推进任务的周期批量创建。'] };
    if (!first.due) return { ok: false, errors: ['按周期创建前，请填写首次截止日期。'] };
    // Explicit first-instance percentages remain meaningful, including unknowns.
    if (own(input, 'progress') && input.progress === null) first.progress = null;
    if (own(input, 'target') && input.target === null) first.target = null;
    var tasks = [first], date = parseDate(first.due.slice(0, 10));
    var days = options.interval * (options.frequency === 'weekly' ? 7 : 1);
    for (var index = 1; index < options.count; index += 1) {
      date.setDate(date.getDate() + days);
      var nextDate = localDate(date);
      if (!isDate(nextDate)) return { ok: false, errors: ['周期生成的日期超过支持范围1900至2200年。'] };
      var task = Object.assign({}, first, { id: id(), due: nextDate + first.due.slice(10), progress: 0, target: 100 });
      tasks.push(task);
    }
    var probe = emptyState(); probe.tasks = tasks;
    checked = validateState(probe);
    return checked.ok ? { ok: true, value: { type: 'youxu-task-batch', version: 1, tasks: checked.value.tasks }, errors: [] } : checked;
  }

  function normalizedTitle(title) {
    if (typeof title !== 'string') return '';
    return title.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, function (character) {
      return character === '+' || character === '#' ? character : '';
    });
  }
  function assignmentTitleKey(title) {
    var text = normalizedTitle(title);
    if (!text || /考试|测验|小测|期中|期末|笔试|上机|回课|测试|论文|视频|报告|exam|quiz|test/.test(text)) return '';
    var category = text.indexOf('lab') !== -1 ? 'lab' : /oj/.test(text) ? 'oj' : /作业|homework/.test(text) ? 'homework' : '';
    if (!category) return '';
    var numerals = '[零〇一二三四五六七八九十百千万两\\d]+';
    text = text.replace(new RegExp('第?' + numerals + '(?:章|节|单元|讲)', 'g'), '');
    text = text.replace(new RegExp('第?' + numerals + '(?:次|份)(?=作业|homework|lab|oj)', 'g'), '');
    text = text.replace(new RegExp('(作业|homework|lab|oj)(?:第)?' + numerals + '(?:次|份|题|号)?$'), '$1');
    text = text.replace(/homework/g, '作业');
    var subject = text.replace(/作业|lab|oj/g, '');
    if (!subject || !/[a-z\p{L}]/u.test(subject)) return '';
    return category + ':' + text;
  }
  function getEstimateSuggestion(input, title, excludeId) {
    var target = normalizedTitle(title), approximate = assignmentTitleKey(title);
    if (!target || target.length > 200) return null;
    var checked = validateState(input);
    if (!checked.ok) return null;
    var state = checked.value, today = localDate(new Date()), cutoff = pruneLogs([], today).cutoff;
    function match(candidate) {
      return normalizedTitle(candidate) === target ? 'exact' : approximate && assignmentTitleKey(candidate) === approximate ? 'approximate' : '';
    }
    var estimates = state.tasks.filter(function (task) {
      return !isEvent(task) && task.id !== excludeId && task.totalMinutes !== null && match(task.title);
    }).map(function (task) { return { minutes: task.totalMinutes, title: task.title, match: match(task.title) }; });
    var eventIds = new Set(state.tasks.filter(isEvent).map(function (task) { return task.id; }));
    var grouped = new Map();
    state.logs.forEach(function (log) {
      if (!log.taskId || log.taskId === excludeId || eventIds.has(log.taskId) || log.date < cutoff || log.date > today) return;
      if (!grouped.has(log.taskId)) grouped.set(log.taskId, []);
      grouped.get(log.taskId).push(log);
    });
    var actuals = [];
    grouped.forEach(function (logs) {
      if (logs.some(function (log) { return log.minutes === null || log.fromProgress === null || log.toProgress === null || log.toProgress <= log.fromProgress; })) return;
      logs = logs.slice().sort(function (a, b) { return a.fromProgress - b.fromProgress; });
      var cursor = 0, total = 0, lastAt = -Infinity, previousEnd = '';
      for (var index = 0; index < logs.length; index += 1) {
        var log = logs[index], from = Math.round(log.fromProgress * 10), to = Math.round(log.toProgress * 10), at = Date.parse(log.at);
        if (from !== cursor || at < lastAt || previousEnd && log.startedAt && new Date(log.startedAt) < new Date(previousEnd)) return;
        cursor = to; total += log.minutes; lastAt = at; previousEnd = log.endedAt;
      }
      var final = logs[logs.length - 1];
      if (cursor !== 1000 || final.status !== 'completed' || total < 5 || total > 60000 || !match(final.taskTitle)) return;
      actuals.push({ minutes: total, title: final.taskTitle, match: match(final.taskTitle) });
    });
    function result(samples, source, exact) {
      var values = samples.map(function (sample) { return sample.minutes; }).sort(function (a, b) { return a - b; });
      var middle = Math.floor(values.length / 2), median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      return { minutes: Math.round(median), sampleCount: samples.length, source: source, matchedTitles: Array.from(new Set(samples.map(function (sample) { return sample.title; }))), exact: exact };
    }
    for (var tier of ['exact', 'approximate']) {
      var matches = actuals.filter(function (sample) { return sample.match === tier; });
      if (matches.length) return result(matches, 'actual', tier === 'exact');
      matches = estimates.filter(function (sample) { return sample.match === tier; });
      if (matches.length) return result(matches, 'estimated', tier === 'exact');
    }
    return null;
  }

  // Numeric CSV weekdays follow ISO convention: 1 = Monday, 7 = Sunday.
  function parseWeekday(value) {
    var text = String(value).trim();
    if (/^[1-7]$/.test(text)) return Number(text) % 7;
    var match = /^(?:星期|礼拜|周)([一二三四五六日天])$/.exec(text);
    if (!match) return null;
    var position = '日一二三四五六天'.indexOf(match[1]);
    return position === 7 ? 0 : position;
  }
  function parseCSV(text) {
    var rows = [], row = [], field = '', quoted = false, afterQuote = false;
    for (var i = 0; i < text.length; i += 1) {
      var char = text[i];
      if (quoted) {
        if (char === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 1; }
          else { quoted = false; afterQuote = true; }
        } else field += char;
      } else if (char === ',' || char === '\n' || char === '\r') {
        row.push(field); field = ''; afterQuote = false;
        if (char !== ',') {
          if (char === '\r' && text[i + 1] === '\n') i += 1;
          rows.push(row); row = [];
        }
      } else if (char === '"') {
        if (field !== '' || afterQuote) throw new Error('引号必须从单元格开头开始。');
        quoted = true;
      } else {
        if (afterQuote) throw new Error('引号结束后只能接逗号或换行。');
        field += char;
      }
    }
    if (quoted) throw new Error('CSV 中存在未闭合的引号。');
    if (field !== '' || row.length || afterQuote) { row.push(field); rows.push(row); }
    return rows;
  }
  function parseCoursesCSV(source) {
    var errors = [], courses = [];
    if (typeof source !== 'string' || source.length > 2000000) return { courses: [], errors: ['CSV 必须是小于2MB的文本。'] };
    var rows;
    try { rows = parseCSV(source.replace(/^\uFEFF/, '')); }
    catch (error) { return { courses: [], errors: [error.message] }; }
    rows = rows.filter(function (row) { return row.some(function (cell) { return cell.trim() !== ''; }); });
    if (!rows.length) return { courses: [], errors: ['CSV 为空，请保留表头。'] };
    if (rows.length > MAX_ITEMS + 1) return { courses: [], errors: ['一次最多导入2000条课程。'] };
    var header = rows[0].map(function (cell) { return cell.trim(); });
    var names = ['课程', '星期', '开始', '结束', '地点', '单双周', '起始周', '结束周'];
    var columns = {};
    names.forEach(function (name, index) {
      columns[name] = header.indexOf(name);
      if (index < 4 && columns[name] === -1) errors.push('缺少表头：' + name + '。');
      if (columns[name] !== -1 && header.lastIndexOf(name) !== columns[name]) errors.push('表头重复：' + name + '。');
    });
    if (errors.length) return { courses: [], errors: errors };
    rows.slice(1).forEach(function (row, index) {
      var line = '第' + (index + 2) + '行：';
      function cell(name, fallback) {
        return columns[name] < 0 || row[columns[name]] === undefined || row[columns[name]].trim() === '' ? fallback : row[columns[name]].trim();
      }
      var modeValue = cell('单双周', 'all');
      var mode = ({ '每周': 'all', '全部': 'all', '单双周': 'all', '单周': 'odd', '双周': 'even', all: 'all', odd: 'odd', even: 'even' })[modeValue];
      var weekday = cell('星期', ''), daily = ['每天', '每日', 'daily'].indexOf(weekday.toLowerCase()) !== -1;
      var course = { id: id(), title: cell('课程', ''), day: daily ? 0 : parseWeekday(weekday), daily: daily, start: cell('开始', ''), end: cell('结束', ''), location: cell('地点', ''), weekMode: mode || '', startWeek: Number(cell('起始周', '1')), endWeek: Number(cell('结束周', '20')) };
      if (row.length !== header.length) { errors.push(line + '列数与表头不一致。'); return; }
      var probe = emptyState('2026-11-01');
      probe.courses = [course];
      var validation = validateState(probe);
      if (!validation.ok) errors.push(line + validation.errors.join(' '));
      else courses.push(validation.value.courses[0]);
    });
    return { courses: courses, errors: errors };
  }
  function exportCoursesCSV(courses) {
    if (!Array.isArray(courses)) throw new TypeError('课程必须是数组。');
    var header = ['课程', '星期', '开始', '结束', '地点', '单双周', '起始周', '结束周'];
    function escape(value) {
      var text = String(value == null ? '' : value);
      return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
    }
    var rows = courses.map(function (course) {
      return [course.title, course.daily === true ? '每天' : course.day === 0 ? 7 : course.day, course.start, course.end, course.location, course.weekMode, course.startWeek, course.endWeek].map(escape).join(',');
    });
    return '\uFEFF' + header.join(',') + '\r\n' + rows.join('\r\n');
  }
  return {
    STORAGE_KEY: STORAGE_KEY, TASK_PROGRESS_DEFAULTS_MIGRATION_ID: TASK_PROGRESS_DEFAULTS_MIGRATION_ID, CATEGORIES: CATEGORIES.slice(),
    id: id, defaultSettings: defaultSettings, createDemo: createDemo, emptyState: emptyState, taskMetrics: taskMetrics, isEvent: isEvent,
    validateState: validateState, normalizeLog: normalizeLog, summarizeLogs: summarizeLogs, pruneLogs: pruneLogs,
    validateTaskBatch: validateTaskBatch, mergeTaskBatch: mergeTaskBatch, applyTaskProgressDefaults: applyTaskProgressDefaults,
    createRecurringTaskBatch: createRecurringTaskBatch, getEstimateSuggestion: getEstimateSuggestion,
    parseCoursesCSV: parseCoursesCSV, exportCoursesCSV: exportCoursesCSV,
    parseCourseCSV: parseCoursesCSV, exportCourseCSV: exportCoursesCSV
  };
});
