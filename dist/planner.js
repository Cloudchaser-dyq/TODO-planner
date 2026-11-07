(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Planner = factory();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var DEFAULTS = {
    weights: { importance: 60, urgency: 35, enjoyment: -10 },
    dayStart: '08:00', dayEnd: '22:00', dailyBudget: 240,
    blockMinutes: 45, breakMinutes: 10, courseBuffer: 10,
    semesterStart: '', semesterWeeks: 20
  };
  var DAY = 86400000;
  function number(value, fallback) {
    var n = Number(value);
    return value !== '' && value != null && Number.isFinite(n) ? n : fallback;
  }
  function clamp(n, low, high) { return Math.min(high, Math.max(low, n)); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function parseDay(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    }
    var match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    var date = new Date(+match[1], +match[2] - 1, +match[3]);
    return date.getFullYear() === +match[1] && date.getMonth() === +match[2] - 1 &&
      date.getDate() === +match[3] ? date : null;
  }
  function localDate(date) {
    var d = date == null ? new Date() : (date instanceof Date ? date : parseDay(date));
    if (!d || Number.isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(value, n) {
    var date = parseDay(value);
    if (!date) return '';
    date.setDate(date.getDate() + Math.trunc(number(n, 0)));
    return localDate(date);
  }
  function formatMinutes(value) {
    var n = Math.max(0, Math.round(number(value, 0)));
    if (n < 60) return n + ' 分钟';
    return Math.floor(n / 60) + ' 小时' + (n % 60 ? ' ' + (n % 60) + ' 分钟' : '');
  }
  function getWeek(value, semesterStart) {
    var date = parseDay(value), first = parseDay(semesterStart);
    if (!date || !first) return 0;
    var a = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    var b = Date.UTC(first.getFullYear(), first.getMonth(), first.getDate());
    return Math.floor((a - b) / (7 * DAY)) + 1;
  }
  function minute(value, fallback) {
    var m = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) return fallback;
    return +m[1] * 60 + +m[2];
  }
  function settingsWithDefaults(input) {
    var s = Object.assign({}, DEFAULTS, input || {});
    s.weights = Object.assign({}, DEFAULTS.weights, (input || {}).weights || {});
    // Legacy direct callers keep their numeric cap; the app can explicitly opt out.
    s.useDailyBudget = !input || input.useDailyBudget !== false;
    s.dailyBudget = Math.max(0, Math.floor(number(s.dailyBudget, 240)));
    s.blockMinutes = Math.max(1, Math.floor(number(s.blockMinutes, 45)));
    s.breakMinutes = Math.max(0, Math.floor(number(s.breakMinutes, 10)));
    s.courseBuffer = Math.max(0, Math.floor(number(s.courseBuffer, 10)));
    s.semesterWeeks = Math.max(1, Math.floor(number(s.semesterWeeks, 20)));
    return s;
  }
  function coursesForDate(courses, value, input) {
    var s = settingsWithDefaults(input), date = parseDay(value);
    if (!date) return [];
    var week = getWeek(date, s.semesterStart), hasSemester = !!parseDay(s.semesterStart);
    if (hasSemester && (week < 1 || week > s.semesterWeeks)) return [];
    return (courses || []).filter(function (c) {
      if (c.daily !== true && number(c.day, -1) !== date.getDay()) return false;
      var start = minute(c.start, -1), end = minute(c.end, -1);
      if (start < 0 || end <= start) return false;
      if (!hasSemester) return true;
      if (week < number(c.startWeek, 1) || week > number(c.endWeek, s.semesterWeeks)) return false;
      if (c.weekMode === 'odd' && week % 2 === 0) return false;
      if (c.weekMode === 'even' && week % 2 !== 0) return false;
      return true;
    }).map(function (c) {
      return Object.assign({}, c, { startMin: minute(c.start, 0), endMin: minute(c.end, 0) });
    }).sort(function (a, b) { return a.startMin - b.startMin || a.endMin - b.endMin; });
  }
  function deadline(value) {
    // A date-only deadline covers the entire named local day, exclusively ending at midnight.
    var dateOnly = parseDay(value);
    if (dateOnly) {
      dateOnly.setDate(dateOnly.getDate() + 1);
      return dateOnly;
    }
    var match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2})?$/);
    if (!match) return null;
    var date = parseDay(match[1]), min = minute(match[2], -1);
    if (!date || min < 0) return null;
    date.setHours(Math.floor(min / 60), min % 60, 0, 0);
    return date;
  }
  function isEvent(task) { return task.kind === 'event'; }
  function eventMoment(value) {
    return typeof value === 'string' && value.indexOf('T') !== -1 ? deadline(value) : null;
  }
  function eventOccurrence(event) { return eventMoment(event.due) || parseDay(event.due); }
  function eventStatus(event) { return event.eventStatus || 'pending'; }
  function eventSpan(event) {
    if (eventStatus(event) !== 'pending' && eventStatus(event) !== 'attended') return null;
    var start = eventMoment(event.due), end = eventMoment(event.eventEnd);
    return start && end && end > start ? { event: event, start: start, end: end } : null;
  }
  function relativeMinute(moment, day) {
    var days = (Date.UTC(moment.getFullYear(), moment.getMonth(), moment.getDate()) -
      Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())) / DAY;
    return days * 1440 + moment.getHours() * 60 + moment.getMinutes();
  }
  function eventIntervalsForDate(spans, value, buffer) {
    var day = parseDay(value);
    return spans.map(function (span) {
      return { event: span.event, start: relativeMinute(span.start, day), end: relativeMinute(span.end, day) };
    }).filter(function (span) { return span.end + buffer > 0 && span.start - buffer < 1440; });
  }
  function knownNumber(value) { return value != null && value !== '' && Number.isFinite(Number(value)); }
  function usesProgressModel(task) { return Object.prototype.hasOwnProperty.call(task, 'totalMinutes'); }
  function hasProgress(task) {
    return knownNumber(task.totalMinutes);
  }
  function hasKnownWorkload(task) {
    return usesProgressModel(task) ? hasProgress(task) && knownNumber(task.progress) && knownNumber(task.target) : knownNumber(task.remaining);
  }
  function progress(task) { return clamp(number(task.progress, 0), 0, 100); }
  function target(task) { return clamp(number(task.target, 100), 1, 100); }
  function phaseReached(task) {
    return knownNumber(task.progress) && knownNumber(task.target) &&
      Math.round(progress(task) * 10) >= Math.round(target(task) * 10);
  }
  function remaining(task) {
    if (isDone(task) || phaseReached(task)) return 0;
    if (!hasKnownWorkload(task)) return null;
    if (hasProgress(task)) {
      // Percentages are stored to one decimal place; subtract their integer tenths.
      var progressTenths = Math.round(progress(task) * 10), targetTenths = Math.round(target(task) * 10);
      return Math.ceil(Math.max(0, number(task.totalMinutes, 0)) * Math.max(0, targetTenths - progressTenths) / 1000);
    }
    return Math.max(0, Math.floor(number(task.remaining, 0)));
  }
  function overallRemaining(task) {
    if (isDone(task)) return 0;
    if (!hasKnownWorkload(task)) return null;
    if (hasProgress(task)) return Math.ceil(Math.max(0, number(task.totalMinutes, 0)) * (1000 - Math.round(progress(task) * 10)) / 1000);
    return remaining(task);
  }
  function isDone(task) {
    if (knownNumber(task.progress)) return Math.round(progress(task) * 10) >= 1000;
    return usesProgressModel(task) ? false : !!task.done;
  }
  function rating(value) { return clamp(number(value, 3), 1, 5); }
  function anchorDate(value, s) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return new Date(value);
    var d = parseDay(value) || parseDay(localDate());
    var m = minute(s.dayStart, 480);
    d.setHours(Math.floor(m / 60), m % 60, 0, 0);
    return d;
  }
  function getTaskPriority(task, input, value, capacityMinutes) {
    if (isEvent(task)) return {
      score: 0, urgency: 0, risk: 'normal', reason: '固定事件按发生时间提醒，不参与任务排名',
      event: true, provisional: false, workloadKnown: false
    };
    var s = settingsWithDefaults(input), anchor = anchorDate(value, s);
    var due = deadline(task.due), urgency = 1, overall = overallRemaining(task), done = isDone(task), workloadKnown = done || hasKnownWorkload(task);
    var provisional = !workloadKnown || !knownNumber(task.importance) || !knownNumber(task.enjoyment);
    var risk = 'normal', reason = done ? '整体任务已完成' : '未设截止时间，紧急程度为 1；按重要性和愉悦性排序';
    if (!done && due && (!workloadKnown || overall > 0)) {
      var hours = (due - anchor) / 3600000;
      var dayCapacity = Math.max(0, minute(s.dayEnd, 1320) - minute(s.dayStart, 480));
      var capacity = capacityMinutes == null ?
        Math.max(0, hours / 24 * (s.useDailyBudget ? Math.min(s.dailyBudget, dayCapacity) : dayCapacity)) :
        Math.max(0, number(capacityMinutes, 0));
      if (hours <= 0) {
        risk = 'overdue'; urgency = 5; reason = '已过截止时间，安排补做并提醒';
      } else {
        var pressure = workloadKnown ? (capacity > 0 ? overall / capacity : Infinity) : 0;
        urgency = Math.round(Math.max(1 + 4 * Math.exp(-hours / 72), workloadKnown ? 1 + 4 * clamp(pressure, 0, 1) : 1) * 10) / 10;
        if (hours <= 24 || (workloadKnown && pressure >= 0.8)) {
          risk = 'tight';
          reason = hours <= 24 ? '24 小时内截止，优先保障交付' : '截止前可用时间接近整体剩余工作量';
          if (workloadKnown) reason += '；整体尚需 ' + formatMinutes(overall);
        } else if (workloadKnown) {
          reason = '截止前约有 ' + formatMinutes(capacity) + ' 可用，整体尚需 ' + formatMinutes(overall);
        } else {
          reason = '根据距截止日期的时间自动计算紧急程度';
        }
      }
    }
    var wi = number(s.weights.importance, 0), wu = number(s.weights.urgency, 0), we = number(s.weights.enjoyment, 0);
    var divisor = Math.abs(wi) + Math.abs(wu) + Math.abs(we);
    var score = divisor ? 100 * (wi * rating(task.importance) + wu * urgency + we * rating(task.enjoyment)) / (5 * divisor) : 0;
    if (!divisor && risk === 'normal') reason = '权重均为 0，按重要性和截止时间排序';
    if (!workloadKnown) reason = '未估时或进度、目标待补充，仅按 DDL 推进紧急程度；' + reason;
    if (!knownNumber(task.importance) || !knownNumber(task.enjoyment)) reason += '；未填写的重要性、愉悦性暂用中性 3 分';
    return { score: Math.round(score * 10) / 10, urgency: urgency, risk: risk, reason: reason, provisional: provisional, workloadKnown: workloadKnown };
  }
  function mergeIntervals(intervals) {
    var sorted = intervals.filter(function (i) { return i.end > i.start; }).sort(function (a, b) { return a.start - b.start; });
    var merged = [];
    sorted.forEach(function (i) {
      var last = merged[merged.length - 1];
      if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
      else merged.push({ start: i.start, end: i.end });
    });
    return merged;
  }
  function intervalLength(intervals) {
    return intervals.reduce(function (sum, i) { return sum + i.end - i.start; }, 0);
  }
  function freeIntervals(start, end, occupied) {
    if (start >= end) return [];
    var result = [], cursor = start;
    mergeIntervals(occupied).forEach(function (i) {
      var a = Math.max(start, i.start), b = Math.min(end, i.end);
      if (b <= cursor || a >= end) return;
      if (a > cursor) result.push({ start: cursor, end: a });
      cursor = Math.max(cursor, b);
    });
    if (cursor < end) result.push({ start: cursor, end: end });
    return result;
  }
  function riskOrder(risk) { return risk === 'overdue' ? 0 : risk === 'tight' ? 1 : 2; }
  function compareTasks(a, b) {
    var r = riskOrder(a.priority.risk) - riskOrder(b.priority.risk);
    if (r) return r;
    var ad = deadline(a.due), bd = deadline(b.due);
    if (a.priority.risk !== 'normal' && ad && bd && +ad !== +bd) return ad - bd;
    return b.priority.score - a.priority.score || rating(b.importance) - rating(a.importance) ||
      (ad ? +ad : Infinity) - (bd ? +bd : Infinity) ||
      Number(!!b.flagged) - Number(!!a.flagged) || String(a.id).localeCompare(String(b.id));
  }
  function planDay(options) {
    options = options || {};
    var s = settingsWithDefaults(options.settings), date = localDate(parseDay(options.date) || new Date());
    var day = parseDay(date), now = options.now instanceof Date ? options.now : new Date();
    var spentMinutes = Math.max(0, Math.floor(number(options.spentMinutes, 0)));
    var remainingBudget = s.useDailyBudget ? Math.max(0, s.dailyBudget - spentMinutes) : Infinity;
    var dayStart = minute(s.dayStart, 480), dayEnd = minute(s.dayEnd, 1320);
    var isToday = date === localDate(now), currentMinute = Math.ceil(now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000);
    var start = Math.max(dayStart, isToday ? currentMinute : dayStart), end = dayEnd;
    var anchor = new Date(day); anchor.setHours(Math.floor(start / 60), start % 60, 0, 0);
    var classes = coursesForDate(options.courses, date, s), warnings = [], blocks = [], allocations = {};
    // Return the full event list so the UI can explicitly choose upcoming/history views.
    var events = (options.tasks || []).filter(isEvent).map(function (event) { return Object.assign({}, event); }).sort(function (a, b) {
      var ad = eventOccurrence(a), bd = eventOccurrence(b);
      return (ad ? +ad : Infinity) - (bd ? +bd : Infinity) || String(a.id).localeCompare(String(b.id));
    });
    var eventSpans = events.map(eventSpan).filter(Boolean);
    var fixedEvents = eventIntervalsForDate(eventSpans, date, s.courseBuffer);
    if (dayEnd <= dayStart) warnings.push('可安排时段的结束时间需晚于开始时间。');
    var fixedIntervals = classes.map(function (c) { return { start: c.startMin, end: c.endMin }; }).concat(fixedEvents);
    var occupied = fixedIntervals.map(function (interval) { return { start: interval.start - s.courseBuffer, end: interval.end + s.courseBuffer }; });
    var slots = freeIntervals(start, end, occupied), freeMinutes = intervalLength(slots);
    if (!s.useDailyBudget) remainingBudget = freeMinutes;
    var unbufferedFree = intervalLength(freeIntervals(start, end, fixedIntervals));
    var bufferMinutes = Math.max(0, unbufferedFree - freeMinutes);
    classes.forEach(function (c) {
      if (c.endMin > dayStart && c.startMin < dayEnd) blocks.push({
        id: 'course-' + c.id + '-' + date, kind: 'course', title: c.title,
        start: Math.max(c.startMin, dayStart), end: Math.min(c.endMin, dayEnd), location: c.location || ''
      });
    });
    fixedEvents.forEach(function (span) {
      if (span.end <= 0 || span.start >= 1440) return;
      blocks.push({
        id: 'event-' + span.event.id + '-' + date, kind: 'event', eventId: span.event.id,
        title: span.event.title, start: Math.max(0, span.start), end: Math.min(1440, span.end),
        location: span.event.eventLocation || span.event.location || ''
      });
    });
    events.forEach(function (event) {
      var occurrence = eventMoment(event.due);
      if (eventStatus(event) === 'pending' && occurrence && localDate(occurrence) === date && !eventSpan(event)) {
        warnings.push('「' + event.title + '」结束时间待补充，目前无法保证避开整个事件时段。');
      }
    });
    for (var ci = 1; ci < classes.length; ci++) {
      if (classes[ci].startMin < classes[ci - 1].endMin) {
        warnings.push('课表存在重叠课程，请核对上课时间。'); break;
      }
    }
    var eventsOnDay = fixedEvents.filter(function (span) { return span.end > 0 && span.start < 1440; });
    eventsOnDay.forEach(function (span, index) {
      classes.forEach(function (course) {
        if (span.start < course.endMin && span.end > course.startMin) {
          warnings.push('固定事件「' + span.event.title + '」与课程「' + course.title + '」时间重叠，请核对安排。');
        }
      });
      eventsOnDay.slice(index + 1).forEach(function (other) {
        if (Math.max(0, span.start, other.start) < Math.min(1440, span.end, other.end)) {
          warnings.push('固定事件「' + span.event.title + '」与「' + other.event.title + '」时间重叠，请核对安排。');
        }
      });
    });
    var capacityCache = {};
    function capacityUntil(due) {
      if (capacityCache[+due] != null) return capacityCache[+due];
      if (due <= anchor) return 0;
      var total = 0, dayKey = date, limitKey = localDate(due), guard = 0;
      while (dayKey <= limitKey && guard++ < 367) {
        var a = dayKey === date ? start : dayStart;
        var b = dayKey === limitKey ? Math.min(dayEnd, due.getHours() * 60 + due.getMinutes()) : dayEnd;
        var busy = coursesForDate(options.courses, dayKey, s).map(function (c) {
          return { start: c.startMin - s.courseBuffer, end: c.endMin + s.courseBuffer };
        });
        busy = busy.concat(eventIntervalsForDate(eventSpans, dayKey, s.courseBuffer).map(function (span) {
          return { start: span.start - s.courseBuffer, end: span.end + s.courseBuffer };
        }));
        var available = intervalLength(freeIntervals(a, b, busy));
        total += s.useDailyBudget ? Math.min(dayKey === date ? remainingBudget : s.dailyBudget, available) : available;
        dayKey = addDays(dayKey, 1);
      }
      capacityCache[+due] = total;
      return total;
    }
    var activeTasks = (options.tasks || []).filter(function (t) { return !isEvent(t) && !isDone(t); });
    activeTasks.forEach(function (t) {
      if (!phaseReached(t) && !(hasKnownWorkload(t) && hasProgress(t) && remaining(t) === 0 && overallRemaining(t) > 0)) return;
      var due = deadline(t.due);
      var priority = getTaskPriority(t, s, anchor, due ? capacityUntil(due) : undefined);
      if (priority.risk !== 'normal') warnings.push('「' + t.title + '」本轮目标已达成，但整体任务尚未完成且截止紧迫；请提高目标继续推进。');
    });
    var ranked = activeTasks.filter(function (t) { return remaining(t) == null || remaining(t) > 0; }).map(function (t) {
      var due = deadline(t.due);
      return Object.assign({}, t, {
        remaining: remaining(t), overallRemaining: overallRemaining(t), done: false, needsEstimate: !hasKnownWorkload(t),
        priority: getTaskPriority(t, s, anchor, due ? capacityUntil(due) : undefined)
      });
    }).sort(compareTasks);
    var left = {}, plannedMinutes = 0, lastTaskEnd = null, sessions = 0, sequence = 0, reserved = false;
    ranked.forEach(function (t) {
      left[t.id] = remaining(t); allocations[t.id] = 0;
      if (t.needsEstimate) warnings.push('「' + t.title + '」缺少整体估时、当前进度或本轮目标；补齐后才能安排时间。');
      if (t.priority.risk === 'overdue') warnings.push('「' + t.title + '」已逾期，' + (t.needsEstimate ? '请先补充估时和进度以便安排。' : '今天的安排属于补做。'));
    });
    function canStart(task, cursor) {
      if (task.needsEstimate || left[task.id] <= 0) return false;
      var due = deadline(task.due);
      return !due || task.priority.risk === 'overdue' || localDate(due) > date ||
        (localDate(due) === date && due.getHours() * 60 + due.getMinutes() > cursor);
    }
    slots.forEach(function (slot) {
      var cursor = slot.start;
      while (cursor < slot.end && plannedMinutes < remainingBudget) {
        var workStart = Math.max(cursor, lastTaskEnd == null ? cursor : lastTaskEnd + s.breakMinutes);
        if (workStart >= slot.end) break;
        var candidates = ranked.filter(function (t) { return canStart(t, workStart); });
        if (!candidates.length) break;
        var chosen = candidates[0], budget = remainingBudget - plannedMinutes;
        // A single protected session keeps important long-term work moving when urgent work still fits.
        if (!reserved && sessions >= 2 && budget >= Math.min(s.blockMinutes, 15)) {
          var longTerm = candidates.find(function (t) {
            var due = deadline(t.due);
            return rating(t.importance) >= 4 && t.priority.risk === 'normal' && !allocations[t.id] &&
              (!due || due - anchor > 48 * 3600000);
          });
          var criticalLeft = candidates.reduce(function (sum, t) { return sum + (t.priority.risk !== 'normal' ? left[t.id] : 0); }, 0);
          var criticalToday = candidates.some(function (t) {
            var due = deadline(t.due);
            return t.priority.risk !== 'normal' && due && localDate(due) <= date;
          });
          if (longTerm && !criticalToday && criticalLeft + Math.min(s.blockMinutes, left[longTerm.id]) <= budget) {
            chosen = longTerm; reserved = true;
          }
        }
        var due = deadline(chosen.due), dueMinute = slot.end;
        if (due && chosen.priority.risk !== 'overdue' && localDate(due) === date) dueMinute = due.getHours() * 60 + due.getMinutes();
        var length = Math.floor(Math.min(s.blockMinutes, budget, left[chosen.id], slot.end - workStart, dueMinute - workStart));
        if (length <= 0) break;
        if (workStart > cursor) blocks.push({ id: 'break-' + (++sequence), kind: 'break', title: '段间休息', start: cursor, end: workStart });
        blocks.push({
          id: 'task-' + chosen.id + '-' + (++sequence), kind: 'task', taskId: chosen.id,
          title: chosen.title, start: workStart, end: workStart + length,
          nextAction: chosen.nextAction || '', score: chosen.priority.score, risk: chosen.priority.risk
        });
        allocations[chosen.id] += length; left[chosen.id] -= length; plannedMinutes += length;
        cursor = workStart + length; lastTaskEnd = cursor; sessions++;
      }
    });
    ranked.forEach(function (t) {
      var due = deadline(t.due);
      var nextMidnight = parseDay(addDays(date, 1));
      if (due && due > anchor && due <= nextMidnight && left[t.id] > 0) {
        warnings.push('「' + t.title + '」在今天截止，截止前仍有 ' + formatMinutes(left[t.id]) + ' 未排入；请缩减范围或调整安排。');
      }
    });
    if (ranked.length && !freeMinutes) warnings.push('这天已没有可用时段，请调整可安排时段或选择其他日期。');
    if (s.useDailyBudget && ranked.length && !s.dailyBudget) warnings.push('每日任务预算为 0 分钟，暂不安排任务。');
    else if (s.useDailyBudget && ranked.length && !remainingBudget) warnings.push('已记录的实际用时已达到每日预算，暂不安排新任务。');
    blocks.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return {
      blocks: blocks, ranked: ranked, events: events, freeMinutes: freeMinutes, plannedMinutes: plannedMinutes,
      bufferMinutes: bufferMinutes, warnings: warnings, allocations: allocations,
      spentMinutes: spentMinutes, remainingBudget: remainingBudget
    };
  }
  return {
    localDate: localDate, addDays: addDays, formatMinutes: formatMinutes, getWeek: getWeek,
    coursesForDate: coursesForDate, getTaskPriority: getTaskPriority, planDay: planDay
  };
});
