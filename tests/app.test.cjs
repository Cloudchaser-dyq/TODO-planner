'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// This is a deliberately small DOM emulator, not a browser/layout test. Controls,
// names, defaults and static buttons come from the delivered index.html. The
// actual app, data validator and scheduling engine run without being stubbed.
const dist = path.resolve(__dirname, '../dist');
const sourceHtml = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
function attributes(source) {
  const result = {};
  const pattern = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) result[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  return result;
}
function boot(options = {}) {
  if (typeof options === 'boolean') options = { standalone: options };
  const standalone = !!options.standalone;
  const html = standalone ? fs.readFileSync(path.resolve(dist, '../有序.html'), 'utf8') : sourceHtml;
  const nodes = [], byId = new Map(), timers = [], storage = options.storage || new Map(), writes = [], downloads = [], windowListeners = new Map();
  if (Object.hasOwn(options, 'raw')) storage.set('student-planner:v1', options.raw);
  let now = new Date(2026, 10, 2, 9, 0).getTime();
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  class Element {
    constructor(tag, attrs = {}) {
      this.tagName = tag.toUpperCase(); this.attrs = attrs; this.id = attrs.id || ''; this.name = attrs.name || '';
      this.dataset = {}; this.listeners = new Map(); this.innerHTML = ''; this.textContent = '';
      this.hidden = Object.hasOwn(attrs, 'hidden'); this.open = false; this.files = []; this.elements = {};
      this.type = attrs.type || ''; this.checked = Object.hasOwn(attrs, 'checked'); this.defaultChecked = this.checked;
      this.disabled = Object.hasOwn(attrs, 'disabled');
      this.validity = { badInput: false, valid: true };
      this.value = attrs.value || ''; this.defaultValue = this.value;
      for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      const classes = new Set((attrs.class || '').split(/\s+/).filter(Boolean));
      this.classList = { contains: c => classes.has(c), toggle: (c, active) => { if (active) classes.add(c); else classes.delete(c); } };
      nodes.push(this); if (this.id) { assert.ok(!byId.has(this.id), 'duplicate HTML id: ' + this.id); byId.set(this.id, this); }
    }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    get innerHTML() { return this._innerHTML; }
    set innerHTML(value) { this._innerHTML = String(value); this.markupVersion = (this.markupVersion || 0) + 1; }
    setAttribute(key, value) { this.attrs[key] = String(value); }
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : null; }
    removeAttribute(key) { delete this.attrs[key]; }
    addEventListener(type, listener) { const list = this.listeners.get(type) || []; list.push(listener); this.listeners.set(type, list); }
    dispatch(type, extra = {}) {
      const event = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
      const pending = [];
      for (let current = this; current; current = current.parentNode) {
        event.currentTarget = current;
        for (const listener of current.listeners.get(type) || []) { const result = listener(event); if (result && typeof result.then === 'function') pending.push(result); }
      }
      event.settled = Promise.all(pending);
      return event;
    }
    closest(selector) {
      const match = /^\[([\w-]+)\]$/.exec(selector);
      if (match && Object.hasOwn(this.attrs, match[1])) return this;
      return this.parentNode ? this.parentNode.closest(selector) : null;
    }
    contains(element) { for (let node = element; node; node = node.parentNode) if (node === this) return true; return false; }
    focus() { document.activeElement = this; }
    select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
    reset() { for (const element of Object.values(this.elements)) { element.value = element.defaultValue; element.checked = element.defaultChecked; } }
    reportValidity() { return true; } // Native constraint rendering is outside this emulator's scope.
    showModal() { this.open = true; }
    close() { const wasOpen = this.open; this.open = false; if (wasOpen) this.dispatch('close'); }
    replaceChildren(...children) { this.children = children; }
    click() { this.focus(); this.dispatch('click'); document.dispatch('click', { target: this }); }
  }
  for (const match of html.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
    const attrs = attributes(match[2]);
    if (attrs.id || attrs['data-action'] || attrs['data-view'] || attrs['data-preset']) new Element(match[1], attrs);
  }
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const form = byId.get(attributes(match[1]).id);
    for (const control of match[2].matchAll(/<input\b([^>]*)>|<(select|textarea)\b([^>]*)>([\s\S]*?)<\/\2>/gi)) {
      const tag = control[2] || 'input';
      const attrs = attributes(control[1] ?? control[3]); if (!attrs.name) continue;
      const element = (attrs.id && byId.get(attrs.id)) || new Element(tag, attrs);
      if (tag.toLowerCase() === 'select') {
        const options = [...(control[4] || '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
        const selected = options.find(option => Object.hasOwn(attributes(option[1]), 'selected')) || options[0];
        if (selected) { const a = attributes(selected[1]); element.value = a.value ?? selected[2]; }
      } else if (tag.toLowerCase() === 'textarea') element.value = control[4] || '';
      element.defaultValue = element.value; element.parentNode = form; form.elements[attrs.name] = element;
    }
  }
  // The filter is intentionally outside a form and still needs its HTML default.
  const filter = html.match(/<select\b[^>]*id="task-filter"[^>]*>([\s\S]*?)<\/select>/);
  byId.get('task-filter').value = attributes(filter[1].match(/<option\b([^>]*)>/)[1]).value;
  const document = new Element('document');
  document.hidden = false;
  // Materialize a cell only from actual rendered markup. The host is its parent,
  // so delegated change/keydown handlers run against the delivered table body.
  function findElement(id) {
    const existing = byId.get(id);
    if (existing && !existing.dynamicHost) return existing;
    for (const host of nodes.filter(node => !node.dynamicHost && node.innerHTML)) {
      for (const match of host.innerHTML.matchAll(/<(input|select|textarea|button)\b([^>]*)>/gi)) {
        const attrs = attributes(match[2]);
        if (attrs.id !== id) continue;
        if (existing && existing.dynamicHost === host && existing.dynamicVersion === host.markupVersion) return existing;
        if (existing) byId.delete(id);
        const element = new Element(match[1], attrs);
        element.parentNode = host; element.dynamicHost = host; element.dynamicVersion = host.markupVersion;
        return element;
      }
    }
    if (existing && existing.dynamicHost) byId.delete(id);
    return undefined;
  }
  document.getElementById = id => {
    const element = findElement(id);
    if (!element && id.startsWith('grid-')) return null; // A fixed-event row intentionally has no percentage cells.
    assert.ok(element, 'app referenced missing HTML id: ' + id); return element;
  };
  document.createElement = tag => new Element(tag);
  document.querySelectorAll = selector => selector === '.view' ? nodes.filter(node => node.classList.contains('view')) : selector === '[data-view]' ? nodes.filter(node => Object.hasOwn(node.dataset, 'view')) : [];
  class FormData {
    constructor(form) {
      this.entries = Object.values(form.elements).filter(element => !element.disabled && (element.type !== 'checkbox' || element.checked)).map(element => [element.name, element.type === 'checkbox' ? element.value || 'on' : element.value]);
    }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  const context = vm.createContext({
    document, FormData, Date: Clock, console, AbortController, TextDecoder, TextEncoder,
    fetch: options.fetch || (() => { throw new Error('Unexpected network request in app test'); }),
    localStorage: {
      getItem: key => { if (options.readError) throw new Error('Injected storage read failure'); return storage.get(key) ?? null; },
      setItem: (key, value) => { writes.push({key, value: String(value)}); if (options.writeError) throw new Error('Injected storage write failure'); storage.set(key, String(value)); }
    },
    history: { replaceState() {} }, location: { hash: '', protocol: 'file:', hostname: '', port: '', ...(options.location || {}) },
    setTimeout: () => 1, clearTimeout() {}, setInterval: (fn, delay) => { timers.push({fn, delay}); return timers.length; },
    addEventListener: (type, callback) => { const listeners = windowListeners.get(type) || []; listeners.push(callback); windowListeners.set(type, listeners); },
    URL: { createObjectURL: blob => { downloads.push(blob); return 'blob:mock'; }, revokeObjectURL() {} },
    Blob: class Blob { constructor(parts, options) { this.parts = parts; this.type = options.type; } }
  });
  context.window = context;
  if (standalone) {
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+rel="stylesheet"/i);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.equal(scripts.length, 6);
    scripts.forEach((script, index) => vm.runInContext(script[1], context, { filename: 'standalone-' + index + '.js' }));
  } else {
    const files = ['planner.js', 'data.js']; if (options.bundleImports) files.push('imports.js');
    files.push('ai.js', 'pku.js');
    for (const file of files) vm.runInContext(fs.readFileSync(path.join(dist, file), 'utf8'), context, { filename: file });
    if (options.importBatches) vm.runInContext('globalThis.PlannerImports = JSON.parse(' + JSON.stringify(JSON.stringify({batches: options.importBatches})) + ')', context);
    vm.runInContext(fs.readFileSync(path.join(dist, 'app.js'), 'utf8'), context, { filename: 'app.js' });
  }
  function clickData(attribute, value, id) {
    let node = nodes.find(node => node.dataset[attribute] === value && (id === undefined || node.dataset.id === id));
    if (!node) {
      for (const source of nodes.map(node => node.innerHTML)) {
        for (const button of source.matchAll(/<button\b([^>]*)>/g)) {
          const attrs = attributes(button[1]);
          if (attrs['data-' + attribute] === value && (id === undefined || attrs['data-id'] === id)) { node = new Element('button', attrs); break; }
        }
        if (node) break;
      }
    }
    assert.ok(node, 'rendered button exists: ' + attribute + '=' + value + (id ? ':' + id : '')); node.click();
  }
  return {
    context, document, nodes, storage, writes, downloads, get: findElement, clickData,
    dispatchAction: (action, id) => new Element('button', {'data-action': action, 'data-id': id}).click(),
    raw: () => storage.get(context.PlannerData.STORAGE_KEY),
    storageEvent: raw => { storage.set(context.PlannerData.STORAGE_KEY, raw); for (const listener of windowListeners.get('storage') || []) listener({key: context.PlannerData.STORAGE_KEY, newValue: raw}); },
    fill: (id, values) => { const form = byId.get(id); for (const [key, value] of Object.entries(values)) { assert.ok(form.elements[key], 'HTML form control exists: ' + key); if (form.elements[key].type === 'checkbox') form.elements[key].checked = !!value; else form.elements[key].value = value; } return form; },
    submit: id => byId.get(id).dispatch('submit'),
    saved: () => { const raw = storage.get(context.PlannerData.STORAGE_KEY); assert.ok(raw, 'app wrote localStorage'); return JSON.parse(raw); },
    advance: minutes => { now += minutes * 60000; for (const timer of timers.filter(timer => timer.delay === 60000)) timer.fn(); }
  };
}
function addTask(app, overrides = {}) {
  app.clickData('action', 'new-task');
  assert.equal(app.get('task-dialog').open, true);
  const precision = app.get('task-due-precision'); precision.value = (overrides.due || '2026-11-02T10:00').length > 10 ? 'time' : 'date'; precision.dispatch('change');
  app.fill('task-form', { title: '测试：调研报告', category: '实习', importance: 5, enjoyment: 1, totalMinutes: 300, progress: 20, target: 50, due: '2026-11-02T10:00', nextAction: '列出调研结论', ...overrides });
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  assert.equal(app.get('task-dialog').open, false);
  return app.saved().tasks.find(task => task.title === (overrides.title || '测试：调研报告'));
}
function genericImportBatches() {
  const common = { category: '课业', importance: null, enjoyment: null, totalMinutes: null, progress: null, target: null,
    nextAction: '', flagged: false, sourceGroup: 'sample-group' };
  const first = { ...common, id: 'generic-task-a', title: '课程甲作业', kind: 'task', due: '2026-11-10' };
  return [
    { type: 'youxu-task-batch', version: 1, id: 'generic-test-batch-a', tasks: [first,
      { ...common, id: 'generic-event-a', title: '课程乙测验', kind: 'event', due: '2026-11-12', flagged: true }] },
    { type: 'youxu-task-batch', version: 1, id: 'generic-test-batch-b', tasks: [{ ...first },
      { ...common, id: 'generic-task-b', title: '课程乙作业', kind: 'task', due: '2026-11-15' },
      { ...common, id: 'generic-event-b', title: '公开讲座', kind: 'event', due: '2026-11-18' }] }
  ];
}
function tableCell(app, taskId, field) {
  const cell = app.get('grid-' + field + '-' + taskId);
  assert.ok(cell, 'cell exists in actual table markup: ' + field + ':' + taskId);
  assert.equal(cell.dataset.tableField, field);
  assert.equal(cell.dataset.id, taskId);
  return cell;
}
function changeCell(app, taskId, field, value, options = {}) {
  const cell = tableCell(app, taskId, field);
  cell.focus(); cell.value = value;
  cell.validity = { badInput: !!options.badInput, valid: !options.badInput };
  cell.dispatch('input');
  if (options.commit !== false) cell.dispatch('change');
  return cell;
}
function startTaskForm(app, values = {}) {
  app.clickData('action', 'new-task');
  const due = values.due ?? '2026-11-04', precision = app.get('task-due-precision');
  precision.value = due.length > 10 ? 'time' : 'date'; precision.dispatch('change');
  return app.fill('task-form', { title: '周期任务测试', category: '生活', importance: 3, enjoyment: 3,
    totalMinutes: 60, progress: 0, target: 100, due, nextAction: '', ...values });
}
function mockAIResponse(plan) {
  return { ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan) } }] }) };
}
function openAIForm(app, instruction, options = {}) {
  app.clickData('action', 'open-ai');
  assert.equal(app.get('ai-dialog').open, true);
  if (options.provider && app.get('ai-provider').value !== options.provider) {
    app.get('ai-provider').value = options.provider; app.get('ai-provider').dispatch('change');
  }
  return app.fill('ai-form', { instruction, apiKey: options.apiKey || 'test-only-key-never-real', ...(options.model ? { model: options.model } : {}) });
}

test('standalone HTML runs without external assets and preserves the task-progress workflow', () => {
  const app = boot(true);
  assert.equal(app.saved().tasks.length, 0);
  assert.equal(app.saved().demo, false);
  const task = addTask(app, { title: '独立 HTML 测试任务' });
  assert.equal(task.remaining, 90);
  app.clickData('action', 'progress', task.id);
  app.fill('progress-form', { progress: 50, target: 50, minutes: 45 });
  app.submit('progress-form');
  const saved = app.saved().tasks.find(item => item.id === task.id);
  assert.equal(saved.remaining, 0);
  assert.equal(saved.done, false);
  assert.match(app.get('stage-reached-list').innerHTML, /独立 HTML 测试任务/);
});

test('a new user starts with an empty plan and demo data appears only after an explicit request', () => {
  const app = boot();
  assert.deepEqual(app.saved().tasks, []);
  assert.deepEqual(app.saved().courses, []);
  assert.deepEqual(app.saved().logs, []);
  assert.equal(app.saved().demo, false);
  assert.equal(app.get('demo-banner').hidden, true);
  assert.doesNotMatch(app.get('ranking-list').innerHTML, /【示例】/);
  app.clickData('action', 'load-demo'); app.get('confirm-accept').click();
  assert.equal(app.get('demo-banner').hidden, false);
  const markup = app.get('ranking-list').innerHTML;
  assert.match(markup, /【示例】/);
  assert.doesNotMatch(markup, /undefined|NaN|data-id=""/);
  const ids = [...markup.matchAll(/data-id="([^"]+)"/g)].map(match => match[1]);
  assert.ok(ids.length >= 4);
  app.clickData('action', 'progress', ids[0]);
  assert.equal(app.get('progress-dialog').open, true);
  assert.equal(app.get('progress-form').elements.id.value, ids[0]);
  app.advance(60);
  assert.doesNotMatch(app.get('ranking-list').innerHTML, /undefined|NaN/);
});

test('task form persists canonical percentage fields and refreshes ranking', () => {
  const app = boot(), task = addTask(app);
  assert.ok(task.id);
  assert.deepEqual([task.totalMinutes, task.progress, task.target, task.remaining, task.done], [300, 20, 50, 90, false]);
  assert.equal(Object.hasOwn(task, 'urgency'), false);
  assert.match(app.get('ranking-list').innerHTML, /测试：调研报告/);
  assert.match(app.get('next-recommendation').innerHTML, /测试：调研报告/);
  assert.equal(app.context.PlannerData.validateState(vm.runInContext('JSON.parse(localStorage.getItem(PlannerData.STORAGE_KEY))', app.context)).ok, true);
});

test('progress submission records effort, reaches a stage without completing, and reranks', () => {
  const app = boot(), task = addTask(app);
  app.clickData('action', 'progress', task.id);
  app.fill('progress-form', {progress: 50, target: 50, minutes: 45}); app.submit('progress-form');
  assert.equal(app.get('progress-error').textContent, '');
  const state = app.saved(), updated = state.tasks.find(item => item.id === task.id);
  assert.deepEqual([updated.progress, updated.target, updated.remaining, updated.done], [50, 50, 0, false]);
  assert.equal(state.logs.at(-1).minutes, 45);
  assert.equal(state.logs.at(-1).taskId, task.id);
  assert.doesNotMatch(app.get('ranking-list').innerHTML, /测试：调研报告/);
  assert.match(app.get('stage-reached-list').innerHTML, /测试：调研报告/);
  app.clickData('action', 'progress', task.id);
  app.fill('progress-form', {progress: 50, target: 80, minutes: ''}); app.submit('progress-form');
  assert.equal(app.saved().tasks.find(item => item.id === task.id).remaining, 90);
  assert.match(app.get('ranking-list').innerHTML, /测试：调研报告/);
});

test('negative enjoyment preset saves and weight control updates ranking immediately', () => {
  const app = boot();
  app.clickData('preset', 'bitter');
  assert.equal(app.saved().settings.weights.enjoyment, -20);
  assert.match(app.get('weight-description').textContent, /低愉悦优先/);
  const enjoyment = app.get('weight-enjoyment'); enjoyment.value = -40;
  app.get('settings-form').dispatch('input', {target: enjoyment});
  assert.equal(app.saved().settings.weights.enjoyment, -40);
  assert.equal(app.get('weight-enjoyment-value').textContent, '-40');
  assert.doesNotMatch(app.get('ranking-list').innerHTML, /undefined|NaN/);
});

test('fixed course submission saves recurrence and updates course content and schedule', () => {
  const app = boot();
  app.clickData('action', 'new-course');
  app.fill('course-form', {title: '测试固定实习', day: 1, start: '13:00', end: '15:00', location: '办公室 A', weekMode: 'all', startWeek: 1, endWeek: 20});
  app.submit('course-form');
  assert.equal(app.get('course-error').textContent, '');
  assert.equal(app.get('course-dialog').open, false);
  const course = app.saved().courses.find(course => course.title === '测试固定实习');
  assert.deepEqual([course.day, course.start, course.end, course.weekMode], [1, '13:00', '15:00', 'all']);
  assert.match(app.get('course-week').innerHTML, /测试固定实习/);
  assert.match(app.get('schedule-list').innerHTML, /测试固定实习/);
});

test('malformed JSON and unsupported schema remain untouched after startup and attempted edits', () => {
  for (const raw of ['{"unfinished":', JSON.stringify({version: 99, personalData: 'must survive'})]) {
    const app = boot({raw});
    assert.equal(app.raw(), raw);
    assert.equal(app.writes.length, 0, 'startup cannot overwrite protected storage');
    assert.equal(app.get('data-protection-banner').hidden, false);
    assert.equal(app.get('demo-banner').hidden, true);
    assert.equal(app.get('storage-status').textContent, '原数据已保留，暂停写入');
    const ranking = app.get('ranking-list').innerHTML;
    app.clickData('preset', 'bitter');
    assert.match(app.get('toast').textContent, /保护/);
    app.clickData('action', 'new-task');
    app.fill('task-form', {title: '不得写入的预览任务', category: '实习', importance: 5, enjoyment: 1, totalMinutes: 300, progress: 20, target: 50, due: '', nextAction: ''});
    app.submit('task-form');
    assert.match(app.get('task-error').textContent, /保护/);
    assert.equal(app.get('task-dialog').open, true);
    assert.equal(app.get('ranking-list').innerHTML, ranking, 'rejected edits cannot mutate preview state');
    assert.equal(app.raw(), raw);
    assert.equal(app.writes.length, 0);
    assert.equal(app.get('storage-status').textContent, '原数据已保留，暂停写入');
    app.clickData('action', 'export-backup');
    assert.equal(app.downloads.length, 1);
    assert.equal(app.downloads[0].parts[0], raw, 'recovery export preserves original bytes, not preview demo');
  }
});

test('normal saved data survives a restart without an automatic rewrite', () => {
  const app = boot(), task = addTask(app, {title: '重启后仍存在'}), raw = app.raw();
  const restarted = boot({storage: app.storage});
  assert.equal(restarted.writes.length, 0);
  assert.equal(restarted.raw(), raw);
  assert.equal(restarted.saved().tasks.find(item => item.id === task.id).title, '重启后仍存在');
  assert.match(restarted.get('ranking-list').innerHTML, /重启后仍存在/);
  assert.equal(restarted.get('data-protection-banner').hidden, true);
});

test('only a confirmed fresh start replaces protected data and unlocks ordinary changes', () => {
  const raw = 'original malformed data', app = boot({raw});
  app.clickData('action', 'fresh-start');
  assert.equal(app.get('confirm-dialog').open, true);
  assert.equal(app.raw(), raw, 'opening confirmation never modifies data');
  app.get('confirm-accept').click();
  assert.equal(app.saved().demo, false);
  assert.deepEqual(app.saved().tasks, []);
  assert.equal(app.get('data-protection-banner').hidden, true);
  assert.equal(app.get('storage-status').textContent, '已保存在当前浏览器');
  addTask(app, {title: '确认新计划后可保存'});
  assert.ok(app.saved().tasks.some(task => task.title === '确认新计划后可保存'));
});

test('failed explicit replacement retains the original data, lock, and preview state', () => {
  const options = {raw: 'cannot replace me', writeError: true}, app = boot(options);
  const ranking = app.get('ranking-list').innerHTML;
  app.clickData('action', 'fresh-start'); app.get('confirm-accept').click();
  assert.equal(app.raw(), options.raw);
  assert.equal(app.get('ranking-list').innerHTML, ranking);
  assert.equal(app.get('data-protection-banner').hidden, false);
  assert.equal(app.get('storage-status').textContent, '原数据已保留，暂停写入');
  const writes = app.writes.length;
  options.writeError = false; app.clickData('preset', 'bitter');
  assert.equal(app.writes.length, writes, 'failed replacement must not unlock later mutations');
  assert.equal(app.raw(), options.raw);
});

test('storage read failure never writes primary storage or exports a misleading demo backup', () => {
  const options = {raw: 'unknown private data', readError: true}, app = boot(options);
  assert.equal(app.raw(), options.raw);
  assert.equal(app.writes.length, 0);
  assert.equal(app.get('storage-status').textContent, '读取异常，已暂停写入');
  assert.equal(app.get('data-protection-banner').hidden, false);
  app.clickData('preset', 'bitter'); app.clickData('action', 'export-backup');
  assert.equal(app.downloads.length, 0);
  assert.match(app.get('toast').textContent, /尚未读取到原始数据/);
  assert.equal(app.raw(), options.raw);
  assert.equal(app.writes.length, 0);
});

test('unreadable cross-tab updates enter protection and cannot be overwritten by later edits', () => {
  const app = boot(), raw = '{"newerVersion":';
  app.storageEvent(raw);
  assert.equal(app.get('data-protection-banner').hidden, false);
  assert.equal(app.get('storage-status').textContent, '原数据已保留，暂停写入');
  const writes = app.writes.length;
  app.clickData('preset', 'bitter');
  assert.equal(app.writes.length, writes);
  assert.equal(app.raw(), raw);
  app.clickData('action', 'export-backup');
  assert.equal(app.downloads.at(-1).parts[0], raw);
  const valid = JSON.stringify(require('../dist/data.js').emptyState('2026-11-02'));
  app.storageEvent(valid);
  assert.equal(app.get('data-protection-banner').hidden, false, 'external updates do not silently unlock a protected tab');
  assert.match(app.get('toast').textContent, /重新打开/);
});

test('canceling a validated import keeps protected data intact; confirming imports unlocks', async () => {
  const app = boot({raw: 'original that must survive cancellation'});
  const candidate = require('../dist/data.js').emptyState('2026-11-02');
  const raw = JSON.stringify(candidate);
  const input = app.get('backup-import');
  input.files = [{size: raw.length, text: async () => raw}];
  await input.dispatch('change').settled;
  assert.equal(app.get('confirm-dialog').open, true);
  assert.equal(app.raw(), 'original that must survive cancellation');
  app.get('confirm-dialog').close();
  assert.equal(app.get('data-protection-banner').hidden, false);
  assert.equal(app.writes.length, 0);
  await input.dispatch('change').settled;
  app.get('confirm-accept').click();
  assert.equal(app.get('data-protection-banner').hidden, true);
  assert.deepEqual(app.saved(), { ...candidate, appliedMigrations: [require('../dist/data.js').TASK_PROGRESS_DEFAULTS_MIGRATION_ID] });
});

test('manually supplied generic batches append date-only tasks and events without invented estimates', () => {
  const batches = genericImportBatches(), app = boot({importBatches: batches}), state = app.saved();
  assert.equal(state.demo, false);
  assert.equal(state.tasks.length, 4);
  assert.equal(state.courses.length, 0);
  assert.deepEqual(state.appliedBatches, batches.map(batch => batch.id));
  assert.deepEqual(state.tasks.map(task => task.id), ['generic-task-a', 'generic-event-a', 'generic-task-b', 'generic-event-b']);
  for (const task of state.tasks) {
    assert.deepEqual([task.importance, task.enjoyment, task.totalMinutes], [null, null, null]);
    assert.deepEqual([task.progress, task.target], task.kind === 'event' ? [null, null] : [0, 100]);
    assert.equal(task.remaining, task.kind === 'event' ? 0 : null);
    assert.equal(task.duePrecision, 'date'); assert.equal(task.done, false);
  }
  assert.equal(state.tasks.filter(task => task.kind === 'task').length, 2);
  assert.equal(state.tasks.filter(task => task.kind === 'event').length, 2);
  assert.match(app.get('ranking-list').innerHTML, /时刻待确认/);
  assert.doesNotMatch(app.get('ranking-list').innerHTML, /undefined|NaN/);
  assert.equal(app.get('planned-value').textContent, '11/10');
  assert.doesNotMatch(app.get('schedule-list').innerHTML, /schedule-block task/);
});

test('an explicitly supplied generic batch preserves existing tasks, courses, preferences and logged effort', () => {
  const D = require('../dist/data.js'), batches = genericImportBatches();
  let seed = logTestState({logs: [workLog()]});
  seed.courses = [{id: 'existing-course', title: '已有固定安排', day: 1, daily: false, start: '09:00', end: '10:00', location: 'A203', weekMode: 'all', startWeek: 1, endWeek: 20}];
  seed.settings.weights.enjoyment = -35;
  seed = D.validateState(seed).value;
  const app = boot({importBatches: batches, raw: JSON.stringify(seed)}), saved = app.saved();
  assert.equal(saved.tasks.length, seed.tasks.length + 4);
  assert.deepEqual(saved.tasks.find(task => task.id === 'work-task'), seed.tasks[0]);
  assert.deepEqual(saved.courses, seed.courses);
  assert.deepEqual(saved.settings, seed.settings);
  assert.deepEqual(saved.logs, seed.logs);
  const raw = app.raw(), reopened = boot({importBatches: batches, raw});
  assert.equal(reopened.raw(), raw);
  assert.equal(reopened.writes.length, 0);
});

test('explicit generic imports are not duplicated or resurrected after deletion and reopening', () => {
  const batches = genericImportBatches(), app = boot({importBatches: batches});
  app.clickData('action', 'delete-task', 'generic-task-a'); app.get('confirm-accept').click();
  assert.equal(app.saved().tasks.length, 3);
  const reopened = boot({importBatches: batches, raw: app.raw()});
  assert.equal(reopened.saved().tasks.length, 3);
  assert.equal(reopened.saved().tasks.some(task => task.id === 'generic-task-a'), false);
  assert.equal(reopened.writes.length, 0);
});

test('protected unreadable storage blocks a supplied generic import', () => {
  const raw = '{do not overwrite this older data';
  const app = boot({importBatches: genericImportBatches(), raw});
  assert.equal(app.raw(), raw);
  assert.equal(app.writes.length, 0);
  assert.equal(app.get('data-protection-banner').hidden, false);
  assert.doesNotMatch(app.get('ranking-list').innerHTML, /课程甲作业|课程乙测验/);
});

test('editing generic imported unknown fields preserves blanks, date precision, source group and flag', () => {
  const app = boot({importBatches: genericImportBatches()});
  const original = app.saved().tasks.find(task => task.id === 'generic-task-a');
  app.clickData('action', 'edit-task', original.id);
  const form = app.get('task-form');
  for (const key of ['totalMinutes', 'importance', 'enjoyment']) assert.equal(form.elements[key].value, '', key + ' stays blank');
  assert.equal(form.elements.progress.value, '0'); assert.equal(form.elements.target.value, '100');
  assert.equal(form.elements.due.value, '2026-11-10'); assert.equal(form.elements.due.type, 'date');
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  assert.deepEqual(app.saved().tasks.find(task => task.id === original.id), original);
  app.clickData('action', 'edit-task', original.id);
  app.fill('task-form', {totalMinutes: 300, importance: 5, enjoyment: 1, progress: 20, target: 50, flagged: true});
  form.dispatch('input'); app.submit('task-form');
  const estimated = app.saved().tasks.find(task => task.id === original.id);
  assert.deepEqual([estimated.totalMinutes, estimated.progress, estimated.target, estimated.remaining], [300, 20, 50, 90]);
  assert.equal(estimated.flagged, true); assert.equal(estimated.sourceGroup, 'sample-group');
  assert.equal(estimated.due, '2026-11-10'); assert.equal(estimated.duePrecision, 'date');
  assert.match(app.get('schedule-list').innerHTML, /课程甲作业/);
});

test('manual generic task append requires confirmation and skips duplicates', async () => {
  const app = boot({importBatches: genericImportBatches()}), before = app.raw();
  const batch = {type: 'youxu-task-batch', version: 1, id: 'manual-generic-test', tasks: [
    {title: '课程甲作业', due: '2026-11-10'}, {title: '手动追加课题', due: '2026-12-15'}]};
  const raw = JSON.stringify(batch), input = app.get('task-batch-import');
  input.files = [{size: raw.length, text: async () => raw}];
  await input.dispatch('change').settled;
  assert.equal(app.get('confirm-dialog').open, true); assert.equal(app.raw(), before);
  app.get('confirm-dialog').close(); assert.equal(app.raw(), before);
  await input.dispatch('change').settled; app.get('confirm-accept').click();
  assert.equal(app.saved().tasks.length, 5);
  assert.equal(app.saved().tasks.filter(task => task.title === '课程甲作业' && task.due === '2026-11-10').length, 1);
  assert.match(app.get('toast').textContent, /新增 1 件，跳过 1 件/);
  await input.dispatch('change').settled; app.get('confirm-accept').click();
  assert.equal(app.saved().tasks.length, 5);
  assert.match(app.get('toast').textContent, /新增 0 件，跳过 2 件/);
});

test('explicitly clearing an imported plan keeps it empty after reopening', () => {
  const batches = genericImportBatches(), app = boot({importBatches: batches});
  app.clickData('action', 'fresh-start'); app.get('confirm-accept').click();
  const cleared = app.saved();
  assert.equal(cleared.tasks.length, 0); assert.equal(cleared.demo, false);
  assert.ok(cleared.appliedBatches.includes(batches[0].id));
  const reopened = boot({importBatches: batches, raw: app.raw()});
  assert.equal(reopened.saved().tasks.length, 0); assert.equal(reopened.writes.length, 0);
});

test('explicitly loading demo data preserves that choice after reopening', () => {
  const app = boot();
  app.clickData('action', 'load-demo'); app.get('confirm-accept').click();
  assert.equal(app.saved().demo, true); assert.equal(app.saved().tasks.length, 4);
  const reopened = boot({raw: app.raw()});
  assert.equal(reopened.saved().demo, true);
  assert.ok(reopened.saved().tasks.every(task => task.title.startsWith('【示例】')));
  assert.equal(reopened.writes.length, 0);
});

function logTestState(overrides = {}) {
  const D = require('../dist/data.js'), state = D.emptyState('2026-11-02');
  state.appliedMigrations = [D.TASK_PROGRESS_DEFAULTS_MIGRATION_ID];
  state.tasks = [{id: 'work-task', title: '调研报告的真实进度', category: '实习', importance: 5, enjoyment: 2, totalMinutes: 300, progress: 20, target: 50, due: '2026-11-10T18:00', nextAction: '整理访谈成果'}];
  Object.assign(state, overrides);
  return D.validateState(state).value;
}
function tableTestState() {
  const D = require('../dist/data.js'), state = logTestState();
  Object.assign(state.tasks[0], { title: '集中填写任务', totalMinutes: null, progress: 0, target: 100,
    due: '2026-11-03T18:00', sourceGroup: '原始任务组', flagged: true, nextAction: '保留用户填写的下一步' });
  state.tasks.push({ ...state.tasks[0], id: 'second-task', title: '保留的另一个任务', category: '课余',
    totalMinutes: 200, progress: 10, target: 80, importance: 4, enjoyment: 2, due: '2026-11-11', flagged: false });
  state.tasks.push({ id: 'table-event', title: '固定小测', kind: 'event', category: '课业', due: '2026-11-02T16:00',
    eventEnd: '2026-11-02T17:00', eventStatus: 'pending', eventLocation: 'A201', nextAction: '',
    totalMinutes: null, progress: null, target: null, importance: null, enjoyment: null });
  return D.validateState(state).value;
}
function estimateTestState() {
  const D = require('../dist/data.js'), state = logTestState();
  state.tasks = [60, 120].map((minutes, index) => ({ ...state.tasks[0], id: 'estimate-reference-' + index,
    title: '实习周报', totalMinutes: minutes, progress: 0, target: 100, due: '2026-11-' + (10 + index) }));
  return D.validateState(state).value;
}
function aiTestState() {
  const D = require('../dist/data.js'), state = logTestState(), base = state.tasks[0];
  state.tasks = [
    { ...base, id: 'assignment-one', title: '课程甲作业一', totalMinutes: null, progress: 0, target: 100, due: '2026-11-08' },
    { ...base, id: 'assignment-two', title: '课程甲作业二', totalMinutes: null, progress: 0, target: 100, due: '2026-11-09' },
    { ...base, id: 'lab-one', title: '课程甲LAB', totalMinutes: 300, progress: 20, target: 50, due: '2026-11-10' },
    { ...base, id: 'lab-two', title: '课程乙LAB', totalMinutes: 180, progress: 10, target: 80, due: '2026-11-11' },
    { id: 'fixed-ai-event', title: '固定考试', kind: 'event', category: '课业', due: '2026-11-12', eventStatus: 'pending', eventEnd: '', eventLocation: '',
      totalMinutes: null, progress: null, target: null, importance: null, enjoyment: null, nextAction: '' }
  ];
  state.logs = [workLog({ taskId: 'lab-one', taskTitle: '课程甲LAB', note: '只在本地保留的工作记录' })];
  state.courses = [{ id: 'local-course', title: '不发送的课程', day: 1, start: '13:00', end: '14:00', location: 'A201', weekMode: 'all', startWeek: 1, endWeek: 20 }];
  const checked = D.validateState(state);
  assert.equal(checked.ok, true, checked.errors.join(' '));
  return checked.value;
}
function workLog(overrides = {}) {
  return {id: 'record-1', taskId: 'work-task', taskTitle: '调研报告的真实进度', date: '2026-11-02', minutes: 30, at: '2026-11-02T00:30:00.000Z', ...overrides};
}
function taskScheduledMinutes(app) {
  return [...app.get('schedule-list').innerHTML.matchAll(/data-minutes="(\d+)"/g)].reduce((sum, match) => sum + Number(match[1]), 0);
}

test('advancing progress without minutes automatically records a partial snapshot visible in daily logs', () => {
  const app = boot({raw: JSON.stringify(logTestState())});
  app.clickData('action', 'progress', 'work-task');
  app.fill('progress-form', {progress: 50, target: 50, minutes: ''}); app.submit('progress-form');
  assert.equal(app.get('progress-error').textContent, '');
  const log = app.saved().logs[0];
  assert.deepEqual([log.fromProgress, log.toProgress, log.status, log.minutes, log.date], [20, 50, 'partial', null, '2026-11-02']);
  assert.match(app.get('log-list').innerHTML, /20% → 50%/);
  assert.match(app.get('log-list').innerHTML, /用时未填写/);
  assert.match(app.get('logs-summary').innerHTML, /另有 1 条未填时长/);
  assert.equal(app.get('free-value').textContent, '0 分钟');
  app.clickData('action', 'progress', 'work-task');
  app.fill('progress-form', {progress: 50, target: 80, minutes: ''}); app.submit('progress-form');
  assert.equal(app.saved().logs.length, 1, 'target-only changes create no work record');
});

test('editing task progress also records advancement and completed status at 100 percent', () => {
  const app = boot({raw: JSON.stringify(logTestState())});
  app.clickData('action', 'edit-task', 'work-task');
  app.fill('task-form', {progress: 40}); app.submit('task-form');
  assert.equal(app.saved().logs[0].fromProgress, 20);
  assert.equal(app.saved().logs[0].toProgress, 40);
  assert.equal(app.saved().logs[0].minutes, null);
  app.clickData('action', 'progress', 'work-task');
  app.fill('progress-form', {progress: 100, target: 100, note: '调研报告已提交'}); app.submit('progress-form');
  assert.equal(app.saved().tasks[0].done, true);
  assert.equal(app.saved().logs.at(-1).status, 'completed');
  assert.equal(app.saved().logs.at(-1).note, '调研报告已提交');
  assert.match(app.get('log-list').innerHTML, /全部完成/);
});

test('progress interval automatically derives 45 minutes and preserves work notes', () => {
  const app = boot({raw: JSON.stringify(logTestState())});
  app.clickData('action', 'progress', 'work-task');
  const form = app.fill('progress-form', {progress: 40, target: 50, startedAt: '2026-11-02T08:00', endedAt: '2026-11-02T08:45', note: '整理了两份访谈'});
  form.dispatch('input', {target: form.elements.endedAt});
  assert.equal(form.elements.minutes.value, '45');
  assert.equal(form.elements.minutes.readOnly, true);
  form.elements.minutes.value = '999'; // Even stale programmatic values cannot override the interval.
  app.submit('progress-form');
  assert.equal(app.get('progress-error').textContent, '');
  const log = app.saved().logs[0];
  assert.deepEqual([log.minutes, log.startedAt, log.endedAt, log.note], [45, '2026-11-02T08:00', '2026-11-02T08:45', '整理了两份访谈']);
  assert.equal(app.get('free-value').textContent, '45 分钟');
  assert.match(app.get('log-list').innerHTML, /08:00—08:45/);
});

test('manual daily logs support standalone work and linked cross-midnight intervals', () => {
  const app = boot({raw: JSON.stringify(logTestState())});
  app.clickData('action', 'new-log');
  app.fill('log-form', {taskId: '', taskTitle: '整理宿舍书桌', date: '2026-11-02', status: 'completed', minutes: 20, note: '书桌收拾好了'});
  app.submit('log-form');
  assert.equal(app.get('log-error').textContent, '');
  assert.equal(app.saved().logs[0].taskId, '');
  assert.equal(app.saved().logs[0].status, 'completed');
  app.clickData('action', 'new-log');
  app.get('log-task-select').value = 'work-task'; app.get('log-task-select').dispatch('change');
  assert.equal(app.get('log-form').elements.taskTitle.value, '调研报告的真实进度');
  const form = app.fill('log-form', {date: '2026-11-01', startedAt: '2026-11-01T23:30', endedAt: '2026-11-02T00:15', fromProgress: 20, toProgress: 35, note: '完成调研资料第一轮归类'});
  form.dispatch('input', {target: form.elements.startedAt}); app.submit('log-form');
  assert.equal(app.get('log-error').textContent, '');
  const log = app.saved().logs.at(-1);
  assert.deepEqual([log.taskId, log.date, log.minutes, log.fromProgress, log.toProgress], ['work-task', '2026-11-01', 45, 20, 35]);
  assert.equal(app.saved().tasks[0].progress, 20, 'historical notes never alter current task progress');
  assert.equal(app.get('log-date').value, '2026-11-01');
  assert.match(app.get('log-list').innerHTML, /23:30—11\/02 00:15/);
});

test('editing and deleting log snapshots never rolls task progress backward', () => {
  const seed = logTestState({logs: [workLog({fromProgress: 20, toProgress: 50})]}); seed.tasks[0].progress = 50;
  const app = boot({raw: JSON.stringify(seed)});
  app.clickData('action', 'edit-log', 'record-1');
  app.fill('log-form', {toProgress: 60, minutes: 25, note: '校正历史记录'}); app.submit('log-form');
  assert.equal(app.get('log-error').textContent, '');
  assert.equal(app.saved().logs[0].toProgress, 60);
  assert.equal(app.saved().tasks[0].progress, 50);
  app.clickData('action', 'delete-log', 'record-1'); app.get('confirm-accept').click();
  assert.equal(app.saved().logs.length, 0);
  assert.equal(app.saved().tasks[0].progress, 50);
});

test('manual logs reject future dates, future end times and entries outside the 14-day window', () => {
  const app = boot({raw: JSON.stringify(logTestState())});
  for (const values of [{date: '2026-11-03'}, {date: '2026-10-19'}, {date: '2026-11-02', startedAt: '2026-11-02T08:00', endedAt: '2026-11-02T10:00'}]) {
    app.clickData('action', 'new-log');
    app.fill('log-form', {taskTitle: '不能保存的记录', ...values}); app.submit('log-form');
    assert.match(app.get('log-error').textContent, /14 天|未来/);
    assert.equal(app.saved().logs.length, 0);
    app.get('log-dialog').close();
  }
});

test('startup and midnight retention expire only old logs while preserving tasks, courses and settings', () => {
  const seed = logTestState({logs: [workLog({id: 'expired', date: '2026-10-19'}), workLog({id: 'boundary', date: '2026-10-20'}), workLog({id: 'today', minutes: 15})]});
  seed.courses = [{id: 'keep-course', title: '保留的课程', day: 2, daily: false, start: '10:00', end: '11:00', location: '', weekMode: 'all', startWeek: 1, endWeek: 20}];
  seed.settings.weights.enjoyment = -45;
  const app = boot({raw: JSON.stringify(seed)});
  assert.deepEqual(app.saved().logs.map(log => log.id), ['boundary', 'today']);
  assert.deepEqual(app.saved().tasks, seed.tasks);
  assert.deepEqual(app.saved().courses, seed.courses);
  assert.deepEqual(app.saved().settings, seed.settings);
  assert.equal(app.get('free-value').textContent, '15 分钟');
  assert.equal(app.get('log-date').min, '2026-10-20');
  app.advance(15 * 60); // 09:00 Nov 2 -> midnight Nov 3, without reloading.
  assert.deepEqual(app.saved().logs.map(log => log.id), ['today']);
  assert.equal(app.get('log-date').min, '2026-10-21');
  assert.deepEqual(app.saved().tasks, seed.tasks);
});

test('restoring a backup prunes expired logs and protected raw data is never pruned', async () => {
  const candidate = logTestState({logs: [workLog({id: 'expired', date: '2026-10-19'}), workLog({id: 'boundary', date: '2026-10-20'})]});
  const app = boot(), input = app.get('backup-import'), raw = JSON.stringify(candidate);
  input.files = [{size: raw.length, text: async () => raw}];
  await input.dispatch('change').settled; app.get('confirm-accept').click();
  assert.deepEqual(app.saved().logs.map(log => log.id), ['boundary']);
  assert.deepEqual(app.saved().tasks, candidate.tasks);
  const invalid = {...candidate, version: 99}, protectedRaw = JSON.stringify(invalid);
  const locked = boot({raw: protectedRaw}); locked.advance(15 * 60);
  assert.equal(locked.raw(), protectedRaw);
  assert.equal(locked.writes.length, 0);
});

test('homepage shows logged work and closest deadline; daily cap is disabled until explicitly enabled', () => {
  const seed = logTestState({logs: [workLog({minutes: 60})]});
  seed.tasks[0].totalMinutes = 600; seed.tasks[0].progress = 0; seed.tasks[0].target = 100;
  seed.settings.dailyBudget = 120;
  const app = boot({raw: JSON.stringify(seed)}), settings = app.get('settings-form');
  assert.equal(app.get('free-value').textContent, '1 小时');
  assert.equal(app.get('planned-value').textContent, '11/10');
  assert.equal(settings.elements.useDailyBudget.checked, false);
  assert.equal(settings.elements.dailyBudget.disabled, true);
  assert.equal(taskScheduledMinutes(app), 600, 'latent dailyBudget must not cap planning');
  settings.elements.useDailyBudget.checked = true;
  settings.dispatch('change', {target: settings.elements.useDailyBudget});
  assert.equal(app.get('settings-error').textContent, '');
  assert.equal(app.saved().settings.useDailyBudget, true);
  assert.equal(settings.elements.dailyBudget.disabled, false);
  assert.equal(taskScheduledMinutes(app), 60, 'enabled cap subtracts actual logged work for this date');
  settings.elements.useDailyBudget.checked = false;
  settings.dispatch('change', {target: settings.elements.useDailyBudget});
  assert.equal(app.saved().settings.useDailyBudget, false);
  assert.equal(taskScheduledMinutes(app), 600);
});

test('generic imported fixed events appear only as reminders without actionable ranking or progress controls', () => {
  const app = boot({importBatches: genericImportBatches()}), events = app.saved().tasks.filter(task => task.kind === 'event');
  assert.equal(events.length, 2); assert.equal(app.get('event-reminders').hidden, false);
  assert.equal(app.get('active-value').textContent, '2 件');
  for (const event of events) {
    assert.ok(app.get('event-reminder-list').innerHTML.includes(event.title));
    assert.ok(!app.get('ranking-list').innerHTML.includes('data-id="' + event.id + '"'));
    assert.ok(!app.get('next-recommendation').innerHTML.includes('data-id="' + event.id + '"'));
    assert.ok(!app.get('plan-warnings').innerHTML.includes('「' + event.title + '」'));
  }
  const cards = [...app.get('task-list').innerHTML.matchAll(/<article class="task-card event-card">([\s\S]*?)<\/article>/g)];
  assert.equal(cards.length, 2);
  for (const card of cards) assert.doesNotMatch(card[1], /progress-track|data-action="progress"|\d%/);
  app.get('task-filter').value = 'events'; app.get('task-filter').dispatch('change');
  assert.equal([...app.get('task-list').innerHTML.matchAll(/<article /g)].length, 2);
});

test('updating the public program preserves locally stored private data without importing anything', () => {
  const D = require('../dist/data.js');
  let seed = logTestState({logs: [workLog()]});
  seed.appliedMigrations = [];
  seed.tasks.push({id: 'private-event-fixture', title: '个人保留的固定安排', kind: 'event', category: '生活', due: '2026-11-20T15:00',
    eventEnd: '2026-11-20T16:00', eventLocation: '私有位置', eventStatus: 'pending', totalMinutes: null, progress: null, target: null,
    importance: null, enjoyment: null, nextAction: ''});
  seed = D.validateState(seed).value;
  const app = boot({bundleImports: true, raw: JSON.stringify(seed)}), saved = app.saved();
  assert.deepEqual(saved.tasks, seed.tasks);
  assert.deepEqual(saved.logs, seed.logs); assert.deepEqual(saved.settings, seed.settings); assert.deepEqual(saved.courses, seed.courses);
  const reopened = boot({bundleImports: true, raw: app.raw()});
  assert.deepEqual(reopened.saved().tasks, seed.tasks); assert.equal(reopened.writes.length, 0);
});

test('event form creates a date-only occurrence with no fabricated time, estimates or progress', () => {
  const app = boot({raw: JSON.stringify(require('../dist/data.js').emptyState('2026-11-02'))});
  app.clickData('action', 'new-task');
  app.get('task-kind').value = 'event'; app.get('task-kind').dispatch('change');
  const form = app.get('task-form');
  assert.equal(app.get('task-work-fields').hidden, true);
  assert.equal(app.get('event-fields').hidden, false);
  for (const key of ['importance', 'enjoyment', 'totalMinutes', 'progress', 'target']) assert.equal(form.elements[key].disabled, true);
  assert.equal(form.elements.eventStatus.disabled, false);
  app.fill('task-form', {title: '日期已定的考试', due: '2026-11-03', eventLocation: '考场待通知'}); app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  const event = app.saved().tasks[0];
  assert.deepEqual([event.kind, event.due, event.eventEnd, event.eventStatus], ['event', '2026-11-03', '', 'pending']);
  assert.deepEqual([event.totalMinutes, event.progress, event.target, event.importance, event.enjoyment], [null, null, null, null, null]);
  assert.equal(app.get('active-value').textContent, '0 件');
  assert.equal(app.get('planned-value').textContent, '暂无');
  assert.match(app.get('ranking-list').innerHTML, /固定事件按发生时间提醒/);
  assert.match(app.get('ranking-list').innerHTML, /备考或准备任务/);
  assert.doesNotMatch(app.get('ranking-list').innerHTML, /提高目标|百分比|阶段目标/);
  assert.doesNotMatch(app.get('schedule-list').innerHTML, /schedule-block event/);
  app.dispatchAction('progress', event.id);
  assert.equal(app.get('task-dialog').open, true, 'stale progress actions redirect to event editing');
  assert.equal(app.get('progress-dialog').open, false);
});

test('precise events reserve their fixed interval and attendance is guarded until occurrence', () => {
  const seed = logTestState();
  seed.tasks.push({id: 'exam-one', title: '当前日固定考试', kind: 'event', category: '课业', due: '2026-11-02T09:30', eventEnd: '2026-11-02T10:30', eventLocation: 'A201', eventStatus: 'pending', nextAction: ''});
  const app = boot({raw: JSON.stringify(seed)});
  assert.match(app.get('schedule-list').innerHTML, /schedule-block event/);
  assert.match(app.get('schedule-list').innerHTML, /当前日固定考试/);
  assert.match(app.get('event-reminder-list').innerHTML, /data-action="attend-event" data-id="exam-one" disabled/);
  assert.equal(app.get('active-value').textContent, '1 件');
  assert.equal(app.get('planned-value').textContent, '11/10');
  app.dispatchAction('attend-event', 'exam-one'); // Deliberately bypass the disabled UI to test the handler guard.
  assert.match(app.get('toast').textContent, /尚未到发生时间/);
  assert.equal(app.get('confirm-dialog').open, false);
  app.clickData('action', 'edit-task', 'exam-one');
  app.fill('task-form', {eventStatus: 'attended'}); app.submit('task-form');
  assert.match(app.get('task-error').textContent, /尚未发生/);
  assert.equal(app.saved().tasks.find(task => task.id === 'exam-one').eventStatus, 'pending');
  app.get('task-dialog').close();
  app.advance(31);
  assert.doesNotMatch(app.get('event-reminder-list').innerHTML, /data-action="attend-event" data-id="exam-one" disabled/);
  app.dispatchAction('attend-event', 'exam-one');
  assert.equal(app.get('confirm-dialog').open, true);
  assert.equal(app.saved().logs.length, 0, 'confirmation must occur before persisting attendance');
  app.get('confirm-accept').click();
  const saved = app.saved(), event = saved.tasks.find(task => task.id === 'exam-one');
  assert.equal(event.eventStatus, 'attended'); assert.equal(event.done, true);
  assert.equal(saved.logs.length, 1);
  const log = saved.logs[0];
  assert.deepEqual([log.taskId, log.status, log.minutes, log.startedAt, log.endedAt, log.fromProgress, log.toProgress], ['exam-one', 'completed', null, '', '', null, null]);
  app.dispatchAction('attend-event', 'exam-one');
  assert.equal(app.saved().logs.length, 1, 'repeat attendance cannot duplicate logs');
});

test('switching a task to an event and back preserves its original progress fields', () => {
  const app = boot({raw: JSON.stringify(logTestState())});
  app.clickData('action', 'edit-task', 'work-task');
  app.get('task-kind').value = 'event'; app.get('task-kind').dispatch('change');
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  let task = app.saved().tasks[0];
  assert.deepEqual([task.kind, task.totalMinutes, task.progress, task.target, task.remaining], ['event', 300, 20, 50, 0]);
  assert.equal(app.saved().logs.length, 0);
  app.get('task-filter').value = 'events'; app.get('task-filter').dispatch('change');
  assert.match(app.get('task-list').innerHTML, /event-card/);
  assert.doesNotMatch(app.get('task-list').innerHTML, /progress-track/);
  app.clickData('action', 'edit-task', 'work-task');
  app.get('task-kind').value = 'task'; app.get('task-kind').dispatch('change');
  for (const key of ['totalMinutes', 'progress', 'target']) assert.equal(app.get('task-form').elements[key].disabled, false);
  app.submit('task-form'); task = app.saved().tasks[0];
  assert.deepEqual([task.kind, task.totalMinutes, task.progress, task.target, task.remaining], ['task', 300, 20, 50, 90]);
  assert.equal(app.get('active-value').textContent, '1 件');
  assert.doesNotMatch(app.get('task-list').innerHTML, /event-card/);
});

test('an explicitly actionable preparation task is not inferred to be a fixed event from its title', () => {
  const seed = logTestState(); Object.assign(seed.tasks[0], {id: 'generic-preparation', title: '课程甲测验准备', kind: 'task'});
  const raw = JSON.stringify(seed), app = boot({raw});
  assert.equal(app.writes.length, 0); assert.equal(app.raw(), raw);
  assert.equal(app.saved().tasks[0].kind, 'task'); assert.match(app.get('ranking-list').innerHTML, /课程甲测验准备/);
  assert.equal(app.get('event-reminders').hidden, true);
});

test('the public bundle contains no preloaded task catalogue', () => {
  assert.deepEqual(require('../dist/imports.js').batches, []);
  const app = boot({bundleImports: true});
  assert.deepEqual(app.saved().tasks, []); assert.deepEqual(app.saved().courses, []); assert.deepEqual(app.saved().logs, []);
  assert.equal(app.saved().demo, false);
});



test('startup fills unknown percentages without resetting explicit progress or adding effort logs', () => {
  const D = require('../dist/data.js');
  let seed = logTestState({ logs: [workLog()] });
  seed.appliedMigrations = ['older-unrelated-migration'];
  seed.tasks.push({ ...seed.tasks[0], id: 'already-complete', title: '以前已完成的任务', totalMinutes: 400, progress: 100, target: 100 });
  seed.tasks.push({ ...seed.tasks[0], id: 'unknown-task', title: '尚未估时的任务', totalMinutes: null, progress: null, target: null });
  seed.tasks.push({ ...seed.tasks[0], id: 'unknown-target', title: '仅目标未填写', totalMinutes: 300, progress: 40, target: null });
  seed.tasks.push({ ...seed.tasks[0], id: 'fixed-event', title: '通用固定活动', kind: 'event', due: '2026-11-20', eventEnd: '', eventStatus: 'pending', eventLocation: 'A201' });
  seed = D.validateState(seed).value;
  const app = boot({ raw: JSON.stringify(seed) }), saved = app.saved();
  assert.deepEqual(saved.tasks.find(task => task.id === 'work-task'), seed.tasks.find(task => task.id === 'work-task'));
  assert.deepEqual(saved.tasks.find(task => task.id === 'already-complete'), seed.tasks.find(task => task.id === 'already-complete'));
  assert.deepEqual(saved.tasks.find(task => task.id === 'unknown-task'), { ...seed.tasks.find(task => task.id === 'unknown-task'), progress: 0, target: 100 });
  assert.deepEqual(saved.tasks.find(task => task.id === 'unknown-target'), { ...seed.tasks.find(task => task.id === 'unknown-target'), target: 100, remaining: 180 });
  assert.deepEqual(saved.tasks.find(task => task.id === 'fixed-event'), seed.tasks.find(task => task.id === 'fixed-event'));
  assert.deepEqual(saved.logs, seed.logs, 'filling defaults is not a work record');
  assert.deepEqual(saved.courses, seed.courses); assert.deepEqual(saved.settings, seed.settings);
  assert.ok(saved.appliedMigrations.includes('older-unrelated-migration'));
  assert.ok(saved.appliedMigrations.includes(D.TASK_PROGRESS_DEFAULTS_MIGRATION_ID));
  app.clickData('action', 'progress', 'work-task');
  app.fill('progress-form', { progress: 35, target: 70, minutes: '' }); app.submit('progress-form');
  assert.equal(app.get('progress-error').textContent, '');
  const after = app.saved(), edited = after.tasks.find(task => task.id === 'work-task');
  assert.deepEqual([edited.progress, edited.target], [35, 70]); assert.equal(after.logs.length, seed.logs.length + 1);
  const raw = app.raw(), reopened = boot({ raw });
  assert.equal(reopened.raw(), raw); assert.equal(reopened.writes.length, 0);
  assert.deepEqual(reopened.saved().tasks.find(task => task.id === 'work-task'), edited);
  assert.deepEqual(reopened.saved().logs, after.logs);
});

test('new task controls and blank new-task submissions default to zero progress and a one-hundred target', () => {
  const app = boot({ raw: JSON.stringify(logTestState()) });
  app.clickData('action', 'new-task');
  const form = app.get('task-form');
  assert.equal(form.elements.progress.value, '0');
  assert.equal(form.elements.target.value, '100');
  assert.equal(form.elements.totalMinutes.value, '');
  app.fill('task-form', { title: '使用默认百分比的新任务', category: '生活', due: '', nextAction: '' });
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  const created = app.saved().tasks.find(task => task.title === '使用默认百分比的新任务');
  assert.deepEqual([created.progress, created.target, created.totalMinutes, created.remaining], [0, 100, null, null]);
  app.clickData('action', 'new-task');
  assert.equal(form.elements.progress.value, '0');
  assert.equal(form.elements.target.value, '100');
  app.fill('task-form', { title: '清空输入仍采用默认的新任务', category: '课余', progress: '', target: '', due: '', nextAction: '' });
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  const blank = app.saved().tasks.find(task => task.title === '清空输入仍采用默认的新任务');
  assert.deepEqual([blank.progress, blank.target], [0, 100]);
  assert.equal(app.saved().logs.length, 0);
});

test('batch task defaults fill omitted or null percentages while preserving explicit values and event nulls', async () => {
  const app = boot({ raw: JSON.stringify(logTestState()) });
  const batch = { type: 'youxu-task-batch', version: 1, id: 'percentage-defaults-batch', tasks: [
    { id: 'defaults-missing', kind: 'task', title: '省略百分比', due: '2026-11-20' },
    { id: 'defaults-null', kind: 'task', title: '空百分比', due: '2026-11-21', progress: null, target: null },
    { id: 'defaults-explicit', kind: 'task', title: '保留指定百分比', due: '2026-11-22', totalMinutes: 200, progress: 25.5, target: 60.5 },
    { id: 'defaults-event', kind: 'event', title: '事件没有百分比', due: '2026-11-23', progress: null, target: null }
  ] };
  const raw = JSON.stringify(batch), input = app.get('task-batch-import');
  input.files = [{ size: raw.length, text: async () => raw }];
  await input.dispatch('change').settled; app.get('confirm-accept').click();
  const saved = app.saved();
  for (const id of ['defaults-missing', 'defaults-null']) {
    const task = saved.tasks.find(task => task.id === id);
    assert.deepEqual([task.progress, task.target, task.totalMinutes, task.remaining], [0, 100, null, null]);
  }
  const explicit = saved.tasks.find(task => task.id === 'defaults-explicit');
  assert.deepEqual([explicit.progress, explicit.target, explicit.remaining], [25.5, 60.5, 70]);
  const event = saved.tasks.find(task => task.id === 'defaults-event');
  assert.deepEqual([event.kind, event.progress, event.target, event.totalMinutes, event.remaining], ['event', null, null, null, 0]);
  assert.equal(saved.logs.length, 0);
  const reopened = boot({ raw: app.raw() });
  assert.deepEqual(reopened.saved().tasks.find(task => task.id === explicit.id), explicit);
  assert.equal(reopened.writes.length, 0);
});

test('restoring an older backup retains its explicit percentages across later startup', async () => {
  const D = require('../dist/data.js'), app = boot({ raw: JSON.stringify(logTestState()) });
  const backup = logTestState();
  delete backup.appliedMigrations;
  Object.assign(backup.tasks[0], { progress: 40, target: 70 });
  const raw = JSON.stringify(backup), input = app.get('backup-import');
  input.files = [{ size: raw.length, text: async () => raw }];
  await input.dispatch('change').settled; app.get('confirm-accept').click();
  assert.deepEqual([app.saved().tasks[0].progress, app.saved().tasks[0].target], [40, 70]);
  assert.ok(app.saved().appliedMigrations.includes(D.TASK_PROGRESS_DEFAULTS_MIGRATION_ID));
  const reopened = boot({ raw: app.raw() });
  assert.deepEqual([reopened.saved().tasks[0].progress, reopened.saved().tasks[0].target], [40, 70]);
  assert.equal(reopened.writes.length, 0);
});

test('task table is the default view and inline estimation immediately saves and recomputes the live plan', () => {
  const seed = tableTestState(), app = boot({ raw: JSON.stringify(seed) });
  assert.equal(app.get('task-table-panel').hidden, false);
  assert.equal(app.get('task-list').hidden, true);
  const body = app.get('task-table-body').innerHTML;
  assert.match(body, /集中填写任务/);
  assert.match(body, /data-table-field="totalMinutes"/);
  assert.match(body, /data-table-field="progress"/);
  assert.match(body, /固定小测/);
  const beforeRanking = app.get('ranking-list').innerHTML;
  changeCell(app, 'work-task', 'totalMinutes', '1200');
  assert.equal(app.get('task-table-error').textContent, '');
  const saved = app.saved(), task = saved.tasks.find(item => item.id === 'work-task');
  assert.deepEqual(task, { ...seed.tasks[0], totalMinutes: 1200, remaining: 1200 });
  assert.deepEqual(saved.tasks.filter(item => item.id !== task.id), seed.tasks.filter(item => item.id !== task.id));
  assert.deepEqual(saved.logs, seed.logs);
  assert.notEqual(app.get('ranking-list').innerHTML, beforeRanking);
  assert.match(app.get('ranking-list').innerHTML, /整体尚需 20 小时/);
  assert.match(app.get('schedule-list').innerHTML, /集中填写任务/);
  assert.ok(taskScheduledMinutes(app) > 0);
});

test('inline progress creates one advancement log and changing only the target creates no duplicate log', () => {
  const seed = tableTestState();
  Object.assign(seed.tasks[0], { totalMinutes: 300, progress: 20, target: 50 });
  const app = boot({ raw: JSON.stringify(seed) });
  const cell = changeCell(app, 'work-task', 'progress', '35');
  assert.equal(app.get('task-table-error').textContent, '');
  let saved = app.saved(), task = saved.tasks.find(item => item.id === 'work-task');
  assert.deepEqual([task.progress, task.target, task.remaining], [35, 50, 45]);
  assert.equal(saved.logs.length, 1);
  assert.deepEqual([saved.logs[0].taskId, saved.logs[0].fromProgress, saved.logs[0].toProgress, saved.logs[0].minutes], ['work-task', 20, 35, null]);
  cell.dispatch('change');
  assert.equal(app.saved().logs.length, 1);
  changeCell(app, 'work-task', 'target', '70');
  saved = app.saved(); task = saved.tasks.find(item => item.id === 'work-task');
  assert.deepEqual([task.progress, task.target, task.remaining], [35, 70, 105]);
  assert.equal(saved.logs.length, 1);
  assert.deepEqual(saved.tasks.find(item => item.id === 'second-task'), seed.tasks.find(item => item.id === 'second-task'));
});

test('invalid table cells preserve storage and their draft; native bad numeric input is not saved as an empty estimate', () => {
  const app = boot({ raw: JSON.stringify(tableTestState()) }), raw = app.raw();
  const invalid = changeCell(app, 'work-task', 'totalMinutes', '0');
  assert.equal(app.raw(), raw);
  assert.ok(app.get('task-table-error').textContent.length > 0);
  assert.equal(invalid.value, '0');
  changeCell(app, 'work-task', 'totalMinutes', '180');
  assert.equal(app.get('task-table-error').textContent, '');
  const validRaw = app.raw();
  changeCell(app, 'work-task', 'totalMinutes', '', { badInput: true });
  assert.equal(app.raw(), validRaw);
  assert.ok(app.get('task-table-error').textContent.length > 0);
  assert.equal(app.saved().tasks[0].totalMinutes, 180);
  changeCell(app, 'work-task', 'totalMinutes', '240');
  assert.equal(app.get('task-table-error').textContent, '');
  assert.equal(app.saved().tasks[0].totalMinutes, 240);
});

test('table deadline date stays date-only until a time is explicitly supplied, and clearing the time restores date precision', () => {
  const seed = tableTestState(); seed.tasks[0].due = '2026-11-10'; seed.tasks[0].duePrecision = 'date';
  const app = boot({ raw: JSON.stringify(seed) });
  assert.equal(tableCell(app, 'work-task', 'dueTime').value, '');
  changeCell(app, 'work-task', 'dueDate', '2026-11-12');
  let task = app.saved().tasks.find(item => item.id === 'work-task');
  assert.deepEqual([task.due, task.duePrecision], ['2026-11-12', 'date']);
  changeCell(app, 'work-task', 'dueTime', '15:45');
  task = app.saved().tasks.find(item => item.id === 'work-task');
  assert.deepEqual([task.due, task.duePrecision], ['2026-11-12T15:45', 'time']);
  changeCell(app, 'work-task', 'dueTime', '');
  task = app.saved().tasks.find(item => item.id === 'work-task');
  assert.deepEqual([task.due, task.duePrecision], ['2026-11-12', 'date']);
  assert.equal(app.saved().logs.length, 0);
});

test('table edits fixed event dates and ends as one validated draft without exposing progress controls or allocating work', () => {
  const seed = tableTestState(), app = boot({ raw: JSON.stringify(seed) });
  const body = app.get('task-table-body').innerHTML;
  for (const field of ['totalMinutes', 'progress', 'target', 'importance', 'enjoyment']) {
    assert.ok(!body.includes('id="grid-' + field + '-table-event"'), 'event has no work control: ' + field);
  }
  const raw = app.raw();
  changeCell(app, 'table-event', 'dueDate', '2026-11-04');
  assert.equal(app.raw(), raw, 'start after the old end cannot be saved on its own');
  assert.ok(app.get('task-table-error').textContent.length > 0);
  changeCell(app, 'table-event', 'eventEnd', '2026-11-04T18:00');
  assert.equal(app.get('task-table-error').textContent, '');
  const event = app.saved().tasks.find(item => item.id === 'table-event');
  assert.deepEqual([event.due, event.eventEnd, event.progress, event.target, event.totalMinutes], ['2026-11-04T16:00', '2026-11-04T18:00', null, null, null]);
  assert.ok(!app.get('ranking-list').innerHTML.includes('data-id="table-event"'));
  assert.ok(!app.get('schedule-list').innerHTML.includes('固定小测'), 'the fixed occurrence moves only to its edited date');
  assert.equal(app.saved().logs.length, 0);
  assert.deepEqual(app.saved().tasks.filter(item => item.kind !== 'event'), seed.tasks.filter(item => item.kind !== 'event'));
});

test('switching table filters or cards preserves an invalid cell draft and later saves its correction', () => {
  const app = boot({ raw: JSON.stringify(tableTestState()) }), raw = app.raw(), original = app.saved();
  const cell = changeCell(app, 'work-task', 'totalMinutes', '0');
  app.advance(1);
  assert.equal(cell.value, '0', 'the minute refresh cannot replace a focused draft');
  assert.equal(app.raw(), raw);
  app.get('task-cards-toggle').click();
  assert.equal(app.get('task-table-panel').hidden, true);
  assert.equal(app.get('task-list').hidden, false);
  app.get('task-table-toggle').click();
  assert.equal(app.get('task-table-panel').hidden, false);
  assert.equal(tableCell(app, 'work-task', 'totalMinutes').value, '0');
  const filter = app.get('task-filter'); filter.focus(); filter.value = 'events'; filter.dispatch('change');
  assert.ok(!app.get('task-table-body').innerHTML.includes('grid-totalMinutes-work-task'));
  filter.value = 'all'; filter.dispatch('change');
  assert.equal(tableCell(app, 'work-task', 'totalMinutes').value, '0');
  assert.deepEqual(app.saved().tasks, original.tasks, 'saving a view preference cannot commit invalid task drafts');
  assert.deepEqual(app.saved().logs, original.logs);
  changeCell(app, 'work-task', 'totalMinutes', '180');
  assert.equal(app.saved().tasks.find(item => item.id === 'work-task').totalMinutes, 180);
  assert.equal(app.get('task-table-error').textContent, '');
});

test('Enter commits the current table cell and focuses the next row in the same column; Tab remains native', () => {
  const app = boot({ raw: JSON.stringify(tableTestState()) });
  const cells = [...app.get('task-table-body').innerHTML.matchAll(/<input\b([^>]*)>/g)]
    .map(match => attributes(match[1])).filter(attrs => attrs['data-table-field'] === 'totalMinutes');
  assert.equal(cells.length, 2);
  const first = changeCell(app, cells[0]['data-id'], 'totalMinutes', '180', { commit: false });
  const enter = first.dispatch('keydown', { key: 'Enter' });
  assert.equal(enter.defaultPrevented, true);
  assert.equal(app.saved().tasks.find(task => task.id === cells[0]['data-id']).totalMinutes, 180);
  assert.equal(app.document.activeElement.id, cells[1].id);
  const tab = app.document.activeElement.dispatch('keydown', { key: 'Tab' });
  assert.equal(tab.defaultPrevented, false);
});

test('a focused table details button survives the minute refresh and still opens its task', () => {
  const seed = tableTestState(), app = boot({ raw: JSON.stringify(seed) });
  const body = app.get('task-table-body'), details = app.get('grid-details-work-task');
  assert.ok(details, 'details button is present in the actual rendered table');
  assert.equal(details.tagName, 'BUTTON');
  assert.equal(details.parentNode, body);
  details.focus();
  const version = body.markupVersion, raw = app.raw();
  app.advance(1);
  assert.equal(body.markupVersion, version, 'minute refresh cannot remove the focused details button');
  assert.equal(app.document.activeElement, details);
  details.click();
  assert.equal(app.get('task-dialog').open, true);
  assert.equal(app.get('task-form').elements.id.value, 'work-task');
  assert.equal(app.get('task-form').elements.title.value, seed.tasks[0].title);
  assert.equal(app.raw(), raw, 'opening details does not modify task data');
});

test('task view buttons persist the preference and the settings selector synchronizes it across reloads', () => {
  const seed = tableTestState(), app = boot({ raw: JSON.stringify(seed) });
  assert.equal(app.saved().settings.taskView, 'table');
  app.get('task-cards-toggle').click();
  assert.equal(app.saved().settings.taskView, 'cards');
  assert.equal(app.get('task-table-panel').hidden, true);
  assert.equal(app.get('task-list').hidden, false);
  assert.equal(app.get('settings-form').elements.taskView.value, 'cards');
  assert.equal(app.get('task-cards-toggle').getAttribute('aria-pressed'), 'true');
  const reopened = boot({ raw: app.raw() });
  assert.equal(reopened.writes.length, 0);
  assert.equal(reopened.saved().settings.taskView, 'cards');
  assert.equal(reopened.get('task-table-panel').hidden, true);
  assert.equal(reopened.get('task-list').hidden, false);
  const form = reopened.get('settings-form'), select = form.elements.taskView;
  assert.ok(select, 'view preference is an actual settings form control');
  assert.equal(select.value, 'cards');
  select.value = 'table'; form.dispatch('change', { target: select });
  assert.equal(reopened.get('settings-error').textContent, '');
  assert.equal(reopened.saved().settings.taskView, 'table');
  assert.equal(reopened.get('task-table-panel').hidden, false);
  assert.equal(reopened.get('task-list').hidden, true);
  assert.equal(reopened.get('task-table-toggle').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(reopened.saved().tasks, seed.tasks);
  assert.deepEqual(reopened.saved().logs, seed.logs);
  const again = boot({ raw: reopened.raw() });
  assert.equal(again.writes.length, 0);
  assert.equal(again.saved().settings.taskView, 'table');
  assert.equal(again.get('settings-form').elements.taskView.value, 'table');
  assert.equal(again.get('task-table-panel').hidden, false);
  assert.equal(again.get('task-list').hidden, true);
});

test('protected storage permits temporary view switching without writing its raw data', () => {
  const raw = '{unreadable data must stay intact', app = boot({ raw });
  app.get('task-cards-toggle').click();
  assert.equal(app.get('task-table-panel').hidden, true);
  assert.equal(app.get('task-list').hidden, false);
  assert.equal(app.raw(), raw);
  assert.equal(app.writes.length, 0);
  app.get('task-table-toggle').click();
  assert.equal(app.get('task-table-panel').hidden, false);
  assert.equal(app.get('task-list').hidden, true);
  assert.equal(app.raw(), raw);
  assert.equal(app.writes.length, 0);
  assert.equal(app.get('data-protection-banner').hidden, false);
});

test('weekly task creation adds a finite series and skips an existing title-and-date occurrence without overwriting it', () => {
  const seed = logTestState();
  Object.assign(seed.tasks[0], { title: '每周复盘', due: '2026-11-10', duePrecision: 'date', progress: 45, target: 60 });
  const canonical = require('../dist/data.js').validateState(seed).value;
  const app = boot({ raw: JSON.stringify(canonical) });
  const form = startTaskForm(app, { title: '每周复盘', due: '2026-11-03', repeatEnabled: true,
    repeatFrequency: 'weekly', repeatInterval: 1, repeatCount: 3 });
  form.dispatch('change', { target: form.elements.repeatEnabled });
  assert.equal(app.get('task-repeat-options').hidden, false);
  assert.ok(app.get('task-repeat-preview').textContent.length > 0);
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  assert.equal(app.get('task-dialog').open, false);
  const saved = app.saved(), tasks = saved.tasks.filter(task => task.title === '每周复盘');
  assert.deepEqual(tasks.map(task => task.due).sort(), ['2026-11-03', '2026-11-10', '2026-11-17']);
  assert.deepEqual(tasks.find(task => task.id === 'work-task'), canonical.tasks[0]);
  for (const task of tasks.filter(task => task.id !== 'work-task')) {
    assert.deepEqual([task.progress, task.target, task.totalMinutes], [0, 100, 60]);
    assert.ok(task.id && task.id !== 'work-task');
  }
  assert.match(app.get('toast').textContent, /2/);
  assert.match(app.get('toast').textContent, /1/);
  assert.equal(saved.logs.length, 0);
  const reopened = boot({ raw: app.raw() });
  assert.equal(reopened.saved().tasks.length, 3, 'reopening never generates another occurrence');
  assert.equal(reopened.writes.length, 0);
});

test('daily recurrence preserves the exact deadline time while future occurrences start at zero and one hundred', () => {
  const app = boot({ raw: JSON.stringify(logTestState()) });
  startTaskForm(app, { title: '隔日阅读', due: '2026-11-04T14:30', progress: 20, target: 50,
    repeatEnabled: true, repeatFrequency: 'daily', repeatInterval: 2, repeatCount: 3 });
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  const tasks = app.saved().tasks.filter(task => task.title === '隔日阅读').sort((a, b) => a.due.localeCompare(b.due));
  assert.deepEqual(tasks.map(task => task.due), ['2026-11-04T14:30', '2026-11-06T14:30', '2026-11-08T14:30']);
  assert.deepEqual([tasks[0].progress, tasks[0].target], [20, 50]);
  assert.ok(tasks.slice(1).every(task => task.progress === 0 && task.target === 100));
  assert.equal(new Set(tasks.map(task => task.id)).size, 3);
  assert.equal(app.saved().logs.length, 0);
});

test('recurrence requires a first deadline and valid finite interval/count before any task is saved', () => {
  for (const invalid of [{ due: '' }, { repeatCount: 1 }, { repeatCount: 53 }, { repeatInterval: 0 }, { repeatInterval: 13 }]) {
    const app = boot({ raw: JSON.stringify(logTestState()) }), raw = app.raw();
    startTaskForm(app, { title: '不可保存的重复任务', repeatEnabled: true, repeatFrequency: 'weekly', repeatInterval: 1,
      repeatCount: 4, ...invalid });
    app.submit('task-form');
    assert.ok(app.get('task-error').textContent.length > 0, JSON.stringify(invalid));
    assert.equal(app.get('task-dialog').open, true);
    assert.equal(app.raw(), raw);
  }
});

test('fixed events cannot generate a recurring task series even if repetition was enabled first', () => {
  const app = boot({ raw: JSON.stringify(logTestState()) });
  const form = startTaskForm(app, { title: '仅参加一次的考试', due: '2026-11-04', repeatEnabled: true,
    repeatFrequency: 'daily', repeatInterval: 1, repeatCount: 4 });
  app.get('task-kind').value = 'event'; app.get('task-kind').dispatch('change');
  assert.equal(form.elements.repeatEnabled.disabled, true);
  assert.equal(app.get('task-repeat-options').hidden, true);
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  const events = app.saved().tasks.filter(task => task.title === '仅参加一次的考试');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].kind, events[0].due, events[0].progress, events[0].target], ['event', '2026-11-04', null, null]);
});

test('estimate memory is a visible suggestion and fills minutes only after explicit adoption', () => {
  const seed = estimateTestState(), app = boot({ raw: JSON.stringify(seed) }), raw = app.raw();
  const form = startTaskForm(app, { title: '', totalMinutes: '' });
  form.elements.title.value = '实习周报'; form.elements.title.dispatch('input');
  assert.equal(app.get('task-estimate-memory').hidden, false);
  assert.ok(app.get('task-estimate-memory-text').textContent.length > 0);
  assert.equal(form.elements.totalMinutes.value, '', 'typing a familiar title cannot overwrite an estimate');
  assert.equal(app.raw(), raw);
  app.get('task-estimate-use').click();
  assert.equal(form.elements.totalMinutes.value, '90');
  assert.equal(app.raw(), raw, 'adopting a form suggestion still requires submitting the task');
  form.elements.totalMinutes.value = '150'; form.elements.title.dispatch('input');
  assert.equal(form.elements.totalMinutes.value, '150', 'refreshing the suggestion preserves an existing value');
  app.submit('task-form');
  assert.equal(app.get('task-error').textContent, '');
  const created = app.saved().tasks.find(task => !seed.tasks.some(original => original.id === task.id));
  assert.deepEqual([created.title, created.totalMinutes, created.progress, created.target], ['实习周报', 150, 0, 100]);
  assert.equal(app.saved().logs.length, 0);
});

test('editing excludes the current task from estimate memory and does not silently replace its saved estimate', () => {
  const seed = estimateTestState();
  seed.tasks.push({ ...seed.tasks[0], id: 'unique-estimate', title: '完全独立的一项任务', totalMinutes: 600 });
  const app = boot({ raw: JSON.stringify(seed) });
  app.clickData('action', 'edit-task', 'unique-estimate');
  const form = app.get('task-form');
  assert.equal(app.get('task-estimate-memory').hidden, true, 'the task cannot suggest its own 600-minute estimate');
  form.elements.title.value = '实习周报'; form.elements.title.dispatch('input');
  assert.equal(app.get('task-estimate-memory').hidden, false);
  assert.equal(form.elements.totalMinutes.value, '600');
  app.get('task-estimate-use').click();
  assert.equal(form.elements.totalMinutes.value, '90');
  assert.equal(app.saved().tasks.find(task => task.id === 'unique-estimate').totalMinutes, 600);
});

test('adopting a table estimate preserves the row progress draft and records only its single advancement', () => {
  const seed = estimateTestState();
  seed.tasks.push({ ...seed.tasks[0], id: 'memory-row', totalMinutes: null, progress: 0, target: 100, due: '2026-11-12' });
  const app = boot({ raw: JSON.stringify(seed) });
  const button = app.get('grid-estimate-use-memory-row');
  assert.ok(button, 'suggestion adoption is a real rendered row button');
  assert.equal(button.dataset.action, 'use-table-estimate');
  assert.equal(button.dataset.id, 'memory-row');
  changeCell(app, 'memory-row', 'progress', '20', { commit: false });
  assert.equal(app.saved().tasks.find(task => task.id === 'memory-row').progress, 0);
  button.click();
  assert.equal(app.get('task-table-error').textContent, '');
  const saved = app.saved(), updated = saved.tasks.find(task => task.id === 'memory-row');
  assert.deepEqual([updated.totalMinutes, updated.progress, updated.target, updated.remaining], [90, 20, 100, 72]);
  assert.equal(saved.logs.length, 1);
  assert.deepEqual([saved.logs[0].fromProgress, saved.logs[0].toProgress], [0, 20]);
  assert.deepEqual(saved.tasks.filter(task => task.id !== 'memory-row'), seed.tasks.filter(task => task.id !== 'memory-row'));
});

// These are mock-response UI workflow checks, not an evaluation of a model's
// ability to distinguish course assignments from LAB assignments in natural language.
test('mock AI changes both course assignments IDs only after preview approval, preserves LAB tasks, and never saves the API key', async () => {
  const seed = aiTestState(), requests = [], key = 'mock-deepseek-key-do-not-persist';
  const plan = { summary: '两项 课程甲作业各估计 60 分钟，LAB 保持原样。', actions: ['assignment-one', 'assignment-two']
    .map(id => ({ type: 'update', id, changes: { totalMinutes: 60 } })) };
  const app = boot({ raw: JSON.stringify(seed), fetch: async (url, init) => { requests.push({ url, init }); return mockAIResponse(plan); } });
  const raw = app.raw();
  openAIForm(app, '把所有 课程甲作业的预计用时改成 60 分钟，LAB 保持原样。', { apiKey: key });
  await app.submit('ai-form').settled;
  assert.equal(app.get('ai-error').textContent, '');
  assert.equal(app.get('ai-preview').hidden, false);
  assert.equal(app.get('ai-apply').disabled, false);
  assert.match(app.get('ai-change-list').innerHTML, /课程甲作业一/);
  assert.match(app.get('ai-change-list').innerHTML, /课程甲作业二/);
  assert.doesNotMatch(app.get('ai-change-list').innerHTML, /课程甲LAB|课程乙LAB/);
  assert.equal(app.raw(), raw, 'generating a proposal cannot modify saved tasks');
  assert.equal(requests.length, 1);
  const { url, init } = requests[0], body = JSON.parse(init.body);
  assert.equal(url, 'https://api.deepseek.com/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer ' + key);
  assert.equal(init.credentials, 'omit');
  assert.equal(body.model, 'deepseek-flash');
  const payload = JSON.parse(body.messages.find(message => message.role === 'user').content);
  assert.deepEqual(payload.tasks.map(task => task.id).sort(), seed.tasks.map(task => task.id).sort());
  assert.deepEqual(Object.keys(payload).sort(), ['instruction', 'tasks', 'today']);
  assert.ok(!init.body.includes(seed.logs[0].note));
  assert.ok(!init.body.includes(seed.courses[0].title));
  app.get('ai-apply').click();
  const saved = app.saved();
  for (const id of ['assignment-one', 'assignment-two']) assert.equal(saved.tasks.find(task => task.id === id).totalMinutes, 60);
  for (const id of ['lab-one', 'lab-two', 'fixed-ai-event']) assert.deepEqual(saved.tasks.find(task => task.id === id), seed.tasks.find(task => task.id === id));
  assert.deepEqual(saved.logs, seed.logs);
  assert.deepEqual(saved.courses, seed.courses);
  assert.deepEqual(saved.settings, seed.settings);
  assert.ok(!app.raw().includes(key));
  app.clickData('action', 'export-backup');
  assert.ok(!app.downloads.at(-1).parts.join('').includes(key));
});

test('AI provider controls clear the prior key and use official OpenAI headers or the explicit local proxy', async () => {
  const requests = [], seed = logTestState(), plan = { summary: '无需修改。', actions: [] };
  const app = boot({ raw: JSON.stringify(seed), fetch: async (url, init) => { requests.push({ url, init }); return mockAIResponse(plan); } });
  openAIForm(app, '查看即可，不修改。', { apiKey: 'temporary-deepseek-key' });
  app.get('ai-provider').value = 'openai'; app.get('ai-provider').dispatch('change');
  assert.equal(app.get('ai-api-key').value, '');
  assert.equal(app.get('ai-model').value, 'gpt-6-luna');
  assert.equal(app.get('ai-endpoint').textContent, 'https://api.openai.com/v1/chat/completions');
  app.fill('ai-form', { apiKey: 'mock-openai-key' });
  await app.submit('ai-form').settled;
  assert.equal(app.get('ai-error').textContent, '');
  assert.equal(requests[0].url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer mock-openai-key');
  assert.equal(JSON.parse(requests[0].init.body).model, 'gpt-6-luna');
  assert.equal(app.get('ai-apply').disabled, true);
  const localRequests = [], proxy = boot({ raw: JSON.stringify(seed), location: { protocol: 'http:', hostname: '127.0.0.1', port: '4173' },
    fetch: async (url, init) => { localRequests.push({ url, init }); return mockAIResponse(plan); } });
  openAIForm(proxy, '查看即可，不修改。', { apiKey: 'mock-proxy-key' });
  await proxy.submit('ai-form').settled;
  assert.equal(proxy.get('ai-error').textContent, '');
  assert.equal(localRequests[0].url, '/api/ai');
  assert.equal(localRequests[0].init.headers.Authorization, undefined);
  const proxied = JSON.parse(localRequests[0].init.body);
  assert.deepEqual([proxied.provider, proxied.model, proxied.apiKey], ['deepseek', 'deepseek-flash', 'mock-proxy-key']);
  assert.ok(!proxy.raw().includes('mock-proxy-key'));
});

test('an approved AI create, date-only deadline edit and deletion preserve defaults and historical logs', async () => {
  const seed = aiTestState(), plan = { summary: '新增复习，调整 DDL，并移除已不需要的任务。', actions: [
    { type: 'create', task: { title: '新增复习任务', category: '课业', due: '2026-11-12', totalMinutes: 90 } },
    { type: 'update', id: 'assignment-one', changes: { due: '2026-11-10' } },
    { type: 'delete', id: 'lab-one' }
  ] };
  const app = boot({ raw: JSON.stringify(seed), fetch: async () => mockAIResponse(plan) }), raw = app.raw();
  openAIForm(app, '新增11月12日的复习任务，把课程甲作业一改到11月10日，并删除课程甲LAB，保留历史记录。');
  await app.submit('ai-form').settled;
  assert.equal(app.get('ai-error').textContent, '');
  assert.equal(app.raw(), raw);
  assert.match(app.get('ai-change-list').innerHTML, /新增复习任务/);
  app.get('ai-apply').click();
  const saved = app.saved(), created = saved.tasks.find(task => task.title === '新增复习任务');
  assert.deepEqual([created.progress, created.target, created.totalMinutes, created.remaining], [0, 100, 90, 90]);
  const updated = saved.tasks.find(task => task.id === 'assignment-one');
  assert.deepEqual([updated.due, updated.duePrecision], ['2026-11-10', 'date']);
  assert.equal(saved.tasks.some(task => task.id === 'lab-one'), false);
  assert.deepEqual(saved.logs, seed.logs, 'deleting a task retains its prior work snapshots');
  assert.deepEqual(saved.tasks.find(task => task.id === 'lab-two'), seed.tasks.find(task => task.id === 'lab-two'));
});

test('AI generation enforces the current filtered scope and rejects invalid multi-action proposals atomically', async () => {
  const seed = aiTestState();
  for (const scenario of [
    { filter: 'events', plan: { summary: '越过范围。', actions: [{ type: 'update', id: 'assignment-one', changes: { totalMinutes: 60 } }] }, error: /范围/ },
    { filter: 'all', plan: { summary: '包含无效进度。', actions: [{ type: 'update', id: 'assignment-one', changes: { totalMinutes: 60 } },
      { type: 'update', id: 'assignment-two', changes: { progress: 101 } }] }, error: /校验|进度/ }
  ]) {
    const requests = [], app = boot({ raw: JSON.stringify(seed), fetch: async (url, init) => { requests.push(JSON.parse(init.body)); return mockAIResponse(scenario.plan); } });
    app.get('task-filter').value = scenario.filter; app.get('task-filter').dispatch('change');
    const raw = app.raw();
    openAIForm(app, '只修改当前范围内的事项。');
    await app.submit('ai-form').settled;
    assert.match(app.get('ai-error').textContent, scenario.error);
    assert.equal(app.get('ai-preview').hidden, true);
    assert.equal(app.get('ai-apply').disabled, true);
    assert.equal(app.raw(), raw);
    if (scenario.filter === 'events') {
      const payload = JSON.parse(requests[0].messages.find(message => message.role === 'user').content);
      assert.deepEqual(payload.tasks.map(task => task.id), ['fixed-ai-event']);
    }
  }
});

test('canceling an AI request or closing its dialog aborts transport and ignores a late mock response', async () => {
  const seed = logTestState(), plan = { summary: '不应应用。', actions: [{ type: 'update', id: 'work-task', changes: { totalMinutes: 60 } }] };
  for (const cancel of ['button', 'dialog']) {
    let signal, resolveResponse;
    const app = boot({ raw: JSON.stringify(seed), fetch: (url, init) => {
      signal = init.signal; return new Promise(resolve => { resolveResponse = resolve; });
    } }), raw = app.raw();
    openAIForm(app, '把预计用时改成60分钟。');
    const pending = app.submit('ai-form');
    assert.ok(signal && !signal.aborted);
    if (cancel === 'button') app.get('ai-cancel-request').click(); else app.get('ai-dialog').close();
    assert.equal(signal.aborted, true);
    await pending.settled;
    resolveResponse(mockAIResponse(plan)); await Promise.resolve(); await Promise.resolve();
    assert.equal(app.raw(), raw);
    assert.equal(app.get('ai-preview').hidden, true);
    assert.equal(app.get('ai-apply').disabled, true);
  }
});

test('AI proposals cannot overwrite tasks changed by another tab during generation or before approval', async () => {
  const seed = logTestState(), plan = { summary: '改估时。', actions: [{ type: 'update', id: 'work-task', changes: { totalMinutes: 60 } }] };
  for (const stage of ['generating', 'preview']) {
    let resolveResponse;
    const app = boot({ raw: JSON.stringify(seed), fetch: () => stage === 'preview' ? Promise.resolve(mockAIResponse(plan)) :
      new Promise(resolve => { resolveResponse = resolve; }) });
    openAIForm(app, '把预计用时改成60分钟。');
    const pending = app.submit('ai-form');
    if (stage === 'preview') await pending.settled;
    const external = JSON.parse(app.raw()); external.tasks[0].progress = 30;
    const raw = JSON.stringify(external); app.storageEvent(raw);
    if (stage === 'generating') { resolveResponse(mockAIResponse(plan)); await pending.settled; }
    else app.get('ai-apply').click();
    assert.match(app.get('ai-error').textContent, /已有更新/);
    assert.equal(app.get('ai-preview').hidden, true);
    assert.equal(app.raw(), raw);
    assert.equal(app.saved().tasks[0].progress, 30);
    assert.equal(app.saved().tasks[0].totalMinutes, 300);
  }
});

test('retrying a failed AI save persists the accepted in-memory change without duplicating its progress log', async () => {
  const plan = { summary: '推进到50%，目标调整到70%。', actions: [{ type: 'update', id: 'work-task', changes: { progress: 50, target: 70 } }] };
  const options = { raw: JSON.stringify(logTestState()), fetch: async () => mockAIResponse(plan) }, app = boot(options), raw = app.raw();
  openAIForm(app, '进度更新到50%，目标改成70%。');
  await app.submit('ai-form').settled;
  assert.equal(app.get('ai-error').textContent, '');
  options.writeError = true; app.get('ai-apply').click();
  assert.match(app.get('ai-error').textContent, /保存失败/);
  assert.equal(app.get('ai-apply').textContent, '重试保存');
  assert.equal(app.raw(), raw);
  options.writeError = false; app.get('ai-apply').click();
  assert.equal(app.get('ai-error').textContent, '');
  const saved = app.saved();
  assert.deepEqual([saved.tasks[0].progress, saved.tasks[0].target], [50, 70]);
  assert.equal(saved.logs.length, 1);
  assert.deepEqual([saved.logs[0].fromProgress, saved.logs[0].toProgress, saved.logs[0].minutes], [20, 50, null]);
  app.get('ai-apply').click();
  assert.equal(app.saved().logs.length, 1);
});

test('a daily fixed course is stored once, shown on all seven days, restored for editing and avoided on successive dates', () => {
  const D = require('../dist/data.js');
  let seed = logTestState();
  Object.assign(seed.tasks[0], { totalMinutes: 2000, progress: 0, target: 100, due: '' });
  Object.assign(seed.settings, { semesterStart: '2026-10-26', semesterWeeks: 20, useDailyBudget: false, courseBuffer: 10 });
  seed = D.validateState(seed).value;
  const app = boot({ raw: JSON.stringify(seed) });
  app.clickData('action', 'new-course');
  app.fill('course-form', { title: '每天固定练习', day: 'daily', start: '10:00', end: '11:00',
    location: '自习室', weekMode: 'all', startWeek: 1, endWeek: 20 });
  app.submit('course-form');
  assert.equal(app.get('course-error').textContent, '');
  const course = app.saved().courses[0];
  assert.equal(app.saved().courses.length, 1);
  assert.deepEqual([course.daily, course.day, course.start, course.end], [true, 0, '10:00', '11:00']);
  function assertWeekAndSchedule(date, protectedEnd) {
    const entries = [...app.get('course-week').innerHTML.matchAll(/<button\b([^>]*)>/g)]
      .map(match => attributes(match[1])).filter(attrs => attrs['data-action'] === 'edit-course' && attrs['data-id'] === course.id);
    assert.equal(entries.length, 7, 'one stored arrangement appears in all seven weekday columns');
    app.get('plan-date').value = date; app.get('plan-date').dispatch('change');
    assert.match(app.get('schedule-list').innerHTML, /每天固定练习/);
    const intervals = [...app.get('schedule-list').innerHTML.matchAll(/<div class="schedule-block task"><div class="schedule-time">(\d{2}):(\d{2})<span>(\d{2}):(\d{2})<\/span>/g)]
      .map(match => ({ start: +match[1] * 60 + +match[2], end: +match[3] * 60 + +match[4] }));
    assert.ok(intervals.length > 0);
    assert.ok(intervals.every(interval => interval.end <= 590 || interval.start >= protectedEnd));
  }
  assertWeekAndSchedule('2026-11-02', 670);
  assertWeekAndSchedule('2026-11-03', 670);
  app.clickData('action', 'edit-course', course.id);
  assert.equal(app.get('course-form').elements.day.value, 'daily');
  app.fill('course-form', { end: '11:30' }); app.submit('course-form');
  assert.equal(app.get('course-error').textContent, '');
  assert.equal(app.saved().courses.length, 1, 'editing any displayed copy updates the same stored arrangement');
  assert.deepEqual([app.saved().courses[0].id, app.saved().courses[0].daily, app.saved().courses[0].end], [course.id, true, '11:30']);
  assertWeekAndSchedule('2026-11-03', 700);
  assert.equal(app.saved().logs.length, 0);
});

test('weekly timetable aligns a daily lunch in one horizontal start-time row and edits its single stored course', () => {
  const D = require('../dist/data.js');
  let seed = logTestState({ logs: [workLog()] });
  const common = { location: '', weekMode: 'all', startWeek: 1, endWeek: 20 };
  seed.courses = [
    { ...common, id: 'daily-lunch', title: '午餐', daily: true, day: 0, start: '12:00', end: '13:00', location: '食堂' },
    { ...common, id: 'monday-early', title: '周一早课', daily: false, day: 1, start: '09:00', end: '10:00' },
    { ...common, id: 'tuesday-afternoon', title: '周二下午课', daily: false, day: 2, start: '14:00', end: '15:00' }
  ];
  Object.assign(seed.settings, { semesterStart: '2026-10-26', semesterWeeks: 20 });
  seed = D.validateState(seed).value;
  const app = boot({ raw: JSON.stringify(seed) }), markup = app.get('course-week').innerHTML;
  assert.match(markup, /<table\b[^>]*class="course-timetable"/);
  const head = markup.match(/<thead\b[^>]*>([\s\S]*?)<\/thead>/);
  assert.ok(head);
  assert.equal([...head[1].matchAll(/<th\b/g)].length, 8);
  assert.match(head[1], /开始/);
  const body = markup.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/);
  assert.ok(body);
  const rows = [...body[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1]);
  assert.equal(rows.length, 3);
  assert.ok(rows[0].includes('09:00') && rows[0].includes('monday-early'));
  assert.ok(rows[1].includes('12:00') && rows[1].includes('午餐'));
  assert.ok(rows[2].includes('14:00') && rows[2].includes('tuesday-afternoon'));
  assert.equal([...rows[1].matchAll(/data-id="daily-lunch"/g)].length, 7, 'all seven lunch copies share the same horizontal row');
  assert.ok(!rows[0].includes('daily-lunch') && !rows[2].includes('daily-lunch'));
  app.clickData('action', 'edit-course', 'daily-lunch');
  assert.equal(app.get('course-form').elements.day.value, 'daily');
  app.fill('course-form', { end: '13:30', location: '食堂二楼' }); app.submit('course-form');
  assert.equal(app.get('course-error').textContent, '');
  const saved = app.saved();
  assert.equal(saved.courses.length, 3);
  assert.equal(saved.courses.filter(course => course.id === 'daily-lunch').length, 1);
  assert.deepEqual(saved.courses.find(course => course.id === 'daily-lunch'), { ...seed.courses[0], end: '13:30', location: '食堂二楼' });
  assert.deepEqual(saved.courses.filter(course => course.id !== 'daily-lunch'), seed.courses.filter(course => course.id !== 'daily-lunch'));
  assert.deepEqual(saved.tasks, seed.tasks);
  assert.deepEqual(saved.logs, seed.logs);
  assert.deepEqual(saved.settings, seed.settings);
});

function pkuItem(extra = {}) { return { sourceId: 'a'.repeat(64), title: '同步测试作业', course: '示例课程', due: '2026-11-12T23:59', sourceUrl: 'https://course.pku.edu.cn/webapps/calendar/viewMyCalendar', ...extra }; }
function pkuResponse(value, status = 200) { return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) }; }
function openPKUForm(app) {
  app.clickData('action', 'open-pku'); assert.equal(app.get('pku-dialog').open, true);
  return app.fill('pku-form', { pairing: 'p'.repeat(64), username: 'private-test-account', password: 'private-test-password', remember: true });
}

test('PKU preview explicitly links same-name tasks, updates DDL and keeps credentials outside browser task storage', async () => {
  let remote = pkuItem(); const requests = [];
  const app = boot({ fetch: async (url, options) => { requests.push({ url, options }); return pkuResponse({ items: [remote], warnings: [] }); } });
  const existing = addTask(app, { title: '同步测试作业', due: '2026-11-10', progress: 30, target: 70, totalMinutes: 120 });
  const before = app.raw(); openPKUForm(app); await app.submit('pku-form').settled;
  assert.equal(app.get('pku-error').textContent, ''); assert.equal(app.raw(), before, 'reading only shows a preview');
  assert.equal(app.get('pku-preview').hidden, false); assert.equal(app.get('pku-select-0').checked, false);
  assert.equal(app.get('pku-password').value, ''); assert.equal(app.get('pku-username').value, '');
  const select = app.get('pku-target-0'); select.value = existing.id; select.dispatch('change');
  assert.equal(app.get('pku-select-0').checked, true); app.get('pku-apply').click();
  assert.equal(app.get('pku-error').textContent, '');
  const first = app.saved(); assert.equal(first.tasks.length, 1);
  assert.deepEqual([first.tasks[0].id, first.tasks[0].due, first.tasks[0].progress, first.tasks[0].target, first.tasks[0].totalMinutes], [existing.id, remote.due, 30, 70, 120]);
  assert.equal(first.tasks[0].sourceGroup, 'pku:' + remote.sourceId);
  assert.match(app.get('task-table-body').innerHTML, /北大教学网/); assert.doesNotMatch(app.get('task-table-body').innerHTML, /pku:aaaa/);
  assert.doesNotMatch(app.raw(), /private-test-account|private-test-password|pppppppp|pairing|cookie/);
  assert.equal(requests[0].options.credentials, 'omit'); assert.equal(requests[0].options.redirect, 'error');
  const body = JSON.parse(requests[0].options.body); assert.equal(body.password, 'private-test-password'); assert.equal(body.remember, true);
  remote = pkuItem({ due: '2026-11-15T18:00' }); await app.submit('pku-form').settled;
  assert.equal(app.get('pku-select-0').checked, true); app.get('pku-apply').click();
  assert.equal(app.saved().tasks.length, 1); assert.equal(app.saved().tasks[0].due, remote.due);
  assert.equal(app.saved().tasks[0].progress, 30); assert.equal(app.saved().logs.length, 0);
  assert.deepEqual(JSON.parse(requests[1].options.body), { remember: true }, 'saved login is requested without copying credentials into state');
  app.get('pku-dialog').close(); app.clickData('action', 'edit-task', existing.id);
  app.fill('task-form', { title: '我修改后的任务名', totalMinutes: 180 }); app.submit('task-form');
  assert.equal(app.get('task-error').textContent, ''); assert.equal(app.saved().tasks[0].sourceGroup, 'pku:' + remote.sourceId);
  app.clickData('action', 'task-cards-view');
  assert.match(app.get('task-list').innerHTML, /北大教学网/); assert.doesNotMatch(app.get('task-list').innerHTML, /pku:aaaa/);
});

test('PKU verification keeps credentials in the open form, sends SMS only on click and clears secrets on close', async () => {
  const requests = []; let attempt = 0;
  const app = boot({ fetch: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/sms')) return pkuResponse({ ok: true });
    if (++attempt === 1) return pkuResponse({ error: '需要完成统一认证验证', challenge: { captchaRequired: true, mode: 'sms', captchaImage: 'data:image/png;base64,YQ==' } }, 409);
    return pkuResponse({ items: [pkuItem()], warnings: [] });
  } });
  openPKUForm(app); const original = app.raw(); await app.submit('pku-form').settled;
  assert.equal(requests.length, 1); assert.equal(app.get('pku-verification').hidden, false);
  assert.equal(app.get('pku-sms-group').hidden, false); assert.equal(app.get('pku-otp-group').hidden, true);
  assert.equal(app.get('pku-password').value, 'private-test-password');
  await app.document.dispatch('click', { target: app.get('pku-send-sms') }).settled;
  assert.equal(requests.length, 2); assert.match(requests[1].url, /\/api\/pku\/sms$/);
  app.fill('pku-form', { captcha: 'ABCD', sms: '123456' }); await app.submit('pku-form').settled;
  assert.deepEqual(JSON.parse(requests[2].options.body).verification, { captcha: 'ABCD', sms: '123456' });
  assert.equal(app.raw(), original); assert.equal(app.get('pku-preview').hidden, false);
  app.get('pku-dialog').close();
  for (const id of ['pku-password', 'pku-username', 'pku-captcha', 'pku-sms-code', 'pku-otp-code']) assert.equal(app.get(id).value, '');
  assert.equal(app.get('pku-preview').hidden, true); assert.equal(app.get('pku-verification').hidden, true);
  assert.doesNotMatch(app.raw(), /private-test|123456|ABCD/);
});

test('PKU close aborts a pending request and ignores its late response', async () => {
  let finish, signal;
  const app = boot({ fetch: (url, options) => { signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  openPKUForm(app); const original = app.raw(), pending = app.submit('pku-form').settled;
  assert.equal(app.get('pku-read').disabled, true); app.get('pku-dialog').close(); assert.equal(signal.aborted, true);
  finish(pkuResponse({ items: [pkuItem()], warnings: [] })); await pending;
  assert.equal(app.get('pku-preview').hidden, true); assert.equal(app.raw(), original); assert.equal(app.get('pku-error').textContent, '');
});

test('PKU connection status restores remember preference and unchecking sends an explicit opt-out', async () => {
  const requests = [], app = boot({ fetch: async (url, options) => {
    requests.push({ url, options }); return pkuResponse(url.endsWith('/status') ? { remembered: true, connected: false } : { items: [], warnings: [] });
  } });
  app.clickData('action', 'open-pku'); app.fill('pku-form', { pairing: 'p'.repeat(64) });
  await app.document.dispatch('click', { target: app.get('pku-check') }).settled;
  assert.equal(app.get('pku-remember').checked, true); assert.match(app.get('pku-status').textContent, /已加密记住/);
  app.fill('pku-form', { remember: false }); await app.submit('pku-form').settled;
  assert.deepEqual(JSON.parse(requests[1].options.body), { remember: false });
});

test('PKU direct saved-login sync learns remembered state before posting and refreshes it after a pairing change', async () => {
  let remembered = true;
  const requests = [], app = boot({ fetch: async (url, options) => {
    requests.push({ url, options }); return pkuResponse(url.endsWith('/status') ? { remembered, connected: false } : { items: [], warnings: [] });
  } });
  app.clickData('action', 'open-pku'); app.fill('pku-form', { pairing: 'p'.repeat(64) });
  assert.equal(app.get('pku-remember').checked, false);
  await app.submit('pku-form').settled;
  assert.deepEqual(requests.map(request => request.url.split('/').at(-1)), ['status', 'sync']);
  assert.equal(requests[0].options.signal, requests[1].options.signal, 'status and sync share the same cancellation signal');
  assert.deepEqual(JSON.parse(requests[1].options.body), { remember: true });
  assert.equal(app.get('pku-remember').checked, true);
  remembered = false; app.fill('pku-form', { pairing: 'q'.repeat(64) }); app.get('pku-pairing').dispatch('input');
  await app.submit('pku-form').settled;
  assert.deepEqual(requests.slice(2).map(request => request.url.split('/').at(-1)), ['status', 'sync']);
  assert.deepEqual(JSON.parse(requests[3].options.body), { remember: false });
  app.get('pku-dialog').close(); app.clickData('action', 'open-pku'); remembered = true;
  await app.submit('pku-form').settled;
  assert.deepEqual(requests.slice(4).map(request => request.url.split('/').at(-1)), ['status', 'sync']);
  assert.deepEqual(JSON.parse(requests[5].options.body), { remember: true });
});

test('PKU explicit remember opt-out wins over status and skips automatic preference restoration', async () => {
  const requests = [], app = boot({ fetch: async (url, options) => {
    requests.push({ url, options }); return pkuResponse(url.endsWith('/status') ? { remembered: true, connected: false } : { items: [], warnings: [] });
  } });
  app.clickData('action', 'open-pku'); app.fill('pku-form', { pairing: 'p'.repeat(64), remember: false });
  app.get('pku-remember').dispatch('change');
  await app.document.dispatch('click', { target: app.get('pku-check') }).settled;
  assert.equal(app.get('pku-remember').checked, false, 'checking connection respects a deliberate checkbox choice');
  await app.submit('pku-form').settled;
  assert.deepEqual(requests.map(request => request.url.split('/').at(-1)), ['status', 'sync']);
  assert.deepEqual(JSON.parse(requests[1].options.body), { remember: false });
});

test('PKU cancellation during automatic status discovery prevents a later credential sync', async () => {
  let finish, signal; const requests = [], app = boot({ fetch: (url, options) => {
    requests.push(url); signal = options.signal; return new Promise(resolve => { finish = resolve; });
  } });
  app.clickData('action', 'open-pku'); app.fill('pku-form', { pairing: 'p'.repeat(64) });
  const pending = app.submit('pku-form').settled; app.get('pku-dialog').close(); assert.equal(signal.aborted, true);
  finish(pkuResponse({ remembered: true, connected: false })); await pending;
  assert.equal(requests.length, 1); assert.match(requests[0], /\/status$/); assert.equal(app.get('pku-preview').hidden, true);
});

test('PKU merge rejects newer task changes and a failed-save retry creates each imported task once', async () => {
  const options = { fetch: async () => pkuResponse({ items: [pkuItem()], warnings: [] }) }, app = boot(options);
  openPKUForm(app); await app.submit('pku-form').settled;
  const newer = app.saved(); newer.tasks.push({ id: 'newer-task', title: '另一项更新', kind: 'task', category: '生活', due: '', progress: 0, target: 100, totalMinutes: null, importance: null, enjoyment: null, nextAction: '' });
  app.storageEvent(JSON.stringify(newer)); app.get('pku-apply').click();
  assert.match(app.get('pku-error').textContent, /已有更新/); assert.equal(app.saved().tasks.length, 1);
  await app.submit('pku-form').settled; options.writeError = true; app.get('pku-apply').click();
  assert.match(app.get('pku-error').textContent, /保存失败/); assert.equal(app.get('pku-apply').textContent, '重试保存');
  options.writeError = false; app.get('pku-apply').click(); assert.equal(app.get('pku-error').textContent, '');
  assert.equal(app.saved().tasks.length, 2); assert.equal(app.saved().tasks.filter(task => task.sourceGroup.startsWith('pku:')).length, 1);
  app.get('pku-apply').click(); assert.equal(app.saved().tasks.length, 2);
});
