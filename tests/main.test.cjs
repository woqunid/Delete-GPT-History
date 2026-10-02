'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// A small DOM double exercises the production event handlers without a browser
// dependency or access to a signed-in ChatGPT session. It does not test CSS layout.
class Element {
  constructor(tag, document, attributes = {}) {
    this.tagName = tag; this.document = document; this.attributes = attributes;
    this.childNodes = []; this.parentNode = null; this.listeners = new Map();
    this.style = {}; this.dataset = {}; this.value = ''; this.checked = false;
    this.hidden = 'hidden' in attributes; this.disabled = 'disabled' in attributes;
    this.className = attributes.class || ''; this._text = '';
    this.classList = { toggle: (name, enabled) => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      if (enabled) names.add(name); else names.delete(name);
      this.className = Array.from(names).join(' ');
    } };
  }
  get id() { return this.attributes.id || ''; }
  set id(value) { this.attributes.id = value; }
  get children() { return this.childNodes.filter(node => !node.tagName.startsWith('#')); }
  get lastElementChild() { return this.children.at(-1); }
  get isConnected() { return this === this.document.documentElement || !!this.parentNode?.isConnected; }
  get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this._text = String(value); }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    const tokens = html.match(/<\/?[a-z][^>]*>|[^<]+/gi) || [];
    for (const token of tokens) {
      if (token.startsWith('</')) { stack.pop(); continue; }
      if (token.startsWith('<')) {
        const tag = token.match(/^<([a-z]+)/i)[1];
        const attributes = {};
        const attrText = token.slice(tag.length + 1, -1);
        const attrPattern = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
        let match;
        while ((match = attrPattern.exec(attrText))) attributes[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
        const node = new Element(tag, this.document, attributes);
        stack.at(-1).append(node);
        if (!['input', 'br', 'hr', 'img'].includes(tag)) stack.push(node);
      } else {
        const text = new Element('#text', this.document); text._text = token; stack.at(-1).append(text);
      }
    }
  }
  append(...nodes) {
    for (const node of nodes) {
      if (node.tagName === '#fragment') { this.append(...node.childNodes.slice()); continue; }
      node.remove(); node.parentNode = this; this.childNodes.push(node);
    }
  }
  prepend(node) { node.remove(); node.parentNode = this; this.childNodes.unshift(node); }
  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = []; this._text = ''; this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  matches(selector) {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const attr = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    if (attr) return attr[1] in this.attributes && (attr[2] === undefined || this.attributes[attr[1]] === attr[2]);
    return selector === this.tagName;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const result = [];
    for (const child of this.childNodes) {
      if (selectors.some(value => child.matches(value))) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  contains(node) { return this === node || this.childNodes.some(child => child.contains(node)); }
  getClientRects() {
    let node = this;
    while (node) { if (node.hidden) return []; node = node.parentNode; }
    return this.isConnected ? [{}] : [];
  }
  getBoundingClientRect() { return { left: Number.parseFloat(this.style.left) || 960, top: Number.parseFloat(this.style.top) || 704 }; }
  get offsetWidth() { return 48; }
  get offsetHeight() { return 48; }
  setPointerCapture() {}
  releasePointerCapture() {}
  focus() { this.document.activeElement = this; }
  addEventListener(name, fn) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(fn); }
  emit(name, extra = {}) {
    const event = { target: this, detail: 1, preventDefault() {}, stopPropagation() {}, ...extra };
    return Promise.all((this.listeners.get(name) || []).map(fn => fn(event)));
  }
  click() { return this.disabled ? Promise.resolve() : this.emit('click'); }
}
function makeDocument() {
  const document = { created: 0, activeElement: null };
  document.createElement = tag => { document.created++; return new Element(tag, document); };
  document.createDocumentFragment = () => new Element('#fragment', document);
  document.documentElement = document.createElement('html');
  document.body = document.createElement('body'); document.documentElement.append(document.body);
  document.getElementById = id => document.documentElement.querySelector('#' + id);
  return document;
}
class Clock {
  constructor() { this.now = Date.UTC(2026, 9, 2); this.nextId = 0; this.jobs = new Map(); }
  setTimeout(fn, ms) { const id = ++this.nextId; this.jobs.set(id, { at: this.now + ms, fn }); return id; }
  clearTimeout(id) { this.jobs.delete(id); }
  async until(predicate, limit = 1000) {
    for (let step = 0; step < limit; step++) {
      for (let microtask = 0; microtask < 40; microtask++) await Promise.resolve();
      if (predicate()) return;
      const next = Array.from(this.jobs.entries()).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) throw new Error('No timer can make progress');
      this.jobs.delete(next[0]); this.now = next[1].at; next[1].fn();
    }
    throw new Error('Virtual clock exceeded timer limit');
  }
  async run(promise) {
    let done = false, result, error;
    Promise.resolve(promise).then(value => { result = value; done = true; }, value => { error = value; done = true; });
    await this.until(() => done);
    if (error) throw error;
    return result;
  }
}
function response(data = {}, status = 200, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] || null }, body: { cancel: async () => {} }, json: async () => data, text: async () => '' };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function abortable(signal) { return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })); }
function setup(fetchImpl = async () => response()) {
  const clock = new Clock();
  const document = makeDocument();
  const storage = new Map();
  class TestDate extends Date { static now() { return clock.now; } }
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const instrumented = source.slice(0, source.indexOf('  // Bootstrap:')) + '\n globalThis.app = { state, mountUI, renderList, loadAll, request, toggleSelectAll, showConfirmation, cancelConfirmation, deleteConfirmed, stopTask, setOpen, logLine, get ui() { return ui; } };\n})();';
  const context = vm.createContext({
    document, location: { origin: 'https://example.invalid', reload() {} },
    window: { innerWidth: 1024, innerHeight: 768 },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    GM_addStyle() {}, fetch: fetchImpl, AbortController, DOMException, TypeError, Date: TestDate,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
  });
  vm.runInContext(instrumented, context);
  const app = context.app;
  app.mountUI(); app.setOpen(true);
  app.state.token = 'test-token'; app.state.tokenExpiresAt = clock.now + 600000;
  return { app, clock, document, storage };
}
function seed(app, ids) {
  for (const id of ids) {
    const title = '会话 ' + id;
    app.state.conversations.set(id, { id, title, search: (title + '\n' + id).toLowerCase(), update_time: 1720000000 });
  }
  app.state.started = true; app.state.loadComplete = true; app.renderList();
}
function select(app, ids) { for (const id of ids) app.state.selected.add(id); app.renderList(); }
function confirm(app) { app.showConfirmation(); return app.deleteConfirmed(); }

test('empty state disables deletion; selection reuses rows and large lists are bounded', () => {
  const { app, document } = setup();
  assert.equal(app.ui.delete.disabled, true);
  assert.equal(app.ui.emptyTitle.textContent, '尚未加载会话');
  seed(app, Array.from({ length: 1000 }, (_, index) => String(index)));
  assert.equal(app.ui.list.children.length, 100);
  const checkbox = app.ui.rows.get('0').checkbox;
  const before = document.created;
  checkbox.checked = true; checkbox.emit('change');
  assert.equal(document.created, before);
  assert.equal(app.ui.rows.get('0').checkbox, checkbox);
  assert.equal(app.ui.count.textContent, '已选 1 条');
  assert.equal(app.ui.all.indeterminate, true);
});

test('selection outside the search remains explicit in the complete confirmation', () => {
  const { app } = setup(); seed(app, ['A', 'B']); select(app, ['A']);
  app.ui.search.value = 'B'; app.toggleSelectAll();
  assert.deepEqual(Array.from(app.state.selected), ['A', 'B']);
  assert.equal(app.ui.warning.hidden, false);
  assert.match(app.ui.warningText.textContent, /另有 1 条/);
  app.showConfirmation();
  assert.deepEqual(app.ui.confirmList.children.map(node => node.textContent), ['会话 A', '会话 B']);
  assert.match(app.ui.confirmWarning.textContent, /其中 1 条/);
});

test('select-all flushes a pending search and includes matching unexpanded rows', () => {
  const { app } = setup(); seed(app, Array.from({ length: 150 }, (_, index) => 'B' + index).concat('A'));
  app.ui.search.value = 'B'; app.ui.search.emit('input'); app.toggleSelectAll();
  assert.equal(app.state.selected.size, 150);
  assert.equal(app.state.selected.has('A'), false);
  app.showConfirmation(); assert.equal(app.ui.confirmList.children.length, 100);
  app.ui.confirmMore.click(); assert.equal(app.ui.confirmList.children.length, 150);
});

test('untrusted titles are text and refreshed titles replace cached row labels', async () => {
  const title = '<img src=x onerror=alert(1)>';
  const { app, clock } = setup(async () => response({ items: [{ id: 'A', title }], has_more: false }));
  seed(app, ['A']); app.state.loadComplete = false;
  await clock.run(app.loadAll());
  const row = app.ui.rows.get('A');
  assert.equal(row.title.textContent, title); assert.equal(row.title.children.length, 0);
  select(app, ['A']); app.showConfirmation(); assert.equal(app.ui.confirmList.children[0].children.length, 0);
});

test('duplicate deletion and loading during deletion cannot start additional requests', async () => {
  const gate = deferred(); const calls = [];
  const { app, clock } = setup(async (url, options) => { calls.push({ url, options }); await gate.promise; return response(); });
  seed(app, ['A', 'B', 'C']); select(app, ['A', 'B', 'C']);
  const first = confirm(app); const second = app.deleteConfirmed(); const loading = app.loadAll({ reset: true });
  await clock.until(() => calls.length === 3);
  assert.equal(app.ui.delete.disabled, true); assert.equal(app.ui.all.disabled, true);
  const checkbox = app.ui.rows.get('A').checkbox; checkbox.checked = false; checkbox.emit('change');
  assert.equal(checkbox.checked, true);
  assert.equal(calls.every(call => call.options.method === 'PATCH'), true);
  assert.equal(calls.every(call => JSON.parse(call.options.body).is_visible === false), true);
  gate.resolve(); await clock.run(Promise.all([first, second, loading]));
  assert.equal(calls.length, 3); assert.equal(app.state.progress.success, 3); assert.equal(app.state.conversations.size, 0);
});

test('progress counts successes plus failures and retry only submits failed IDs', async () => {
  const calls = []; let retry = false;
  const { app, clock } = setup(async url => { const id = url.split('/').pop(); calls.push(id); return response({}, id === 'B' && !retry ? 500 : 200); });
  seed(app, ['A', 'B', 'C', 'D']); select(app, ['A', 'B', 'C', 'D']);
  await clock.run(confirm(app));
  assert.equal(app.ui.progressFill.style.width, '100%');
  assert.match(app.ui.status.textContent, /已处理 4\/4 · 成功 3 · 失败 1/);
  assert.deepEqual(Array.from(app.state.selected), ['B']);
  await app.ui.retry.click(); assert.deepEqual(Array.from(app.state.confirmIds), ['B']);
  retry = true; await clock.run(app.deleteConfirmed());
  assert.deepEqual(calls, ['A', 'B', 'C', 'D', 'B']); assert.equal(app.state.conversations.size, 0);
});

test('stop deletion lets started requests finish but leaves the rest selected', async () => {
  const gate = deferred(); const calls = [];
  const { app, clock } = setup(async url => { calls.push(url); await gate.promise; return response(); });
  seed(app, ['A', 'B', 'C', 'D', 'E', 'F']); select(app, ['A', 'B', 'C', 'D', 'E', 'F']);
  const pending = confirm(app); await clock.until(() => calls.length === 3); app.stopTask();
  gate.resolve(); await clock.run(pending);
  assert.equal(calls.length, 3); assert.equal(app.state.selected.size, 3);
  assert.match(app.ui.status.textContent, /已停止 · 已处理 3\/6/);
  assert.match(app.ui.status.textContent, /未执行 3/); assert.equal(app.ui.progressFill.style.width, '50%');
});

test('page offsets advance by the received count even when IDs are duplicated', async () => {
  const offsets = [];
  const { app, clock } = setup(async url => {
    const offset = new URL(url).searchParams.get('offset'); offsets.push(offset);
    return response(offset === '0' ? { items: [{ id: 'A' }, { id: 'A' }, { id: 'B' }], has_more: true } : { items: [{ id: 'C' }], has_more: false });
  });
  await clock.run(app.loadAll({ reset: true }));
  assert.deepEqual(offsets, ['0', '3']); assert.equal(app.state.conversations.size, 3); assert.equal(app.state.loadComplete, true);
});

test('repeated pages stop instead of looping indefinitely', async () => {
  let calls = 0;
  const { app, clock } = setup(async () => { calls++; return response({ items: [{ id: 'A' }], has_more: true }); });
  await clock.run(app.loadAll({ reset: true }));
  assert.equal(calls, 2); assert.equal(app.state.loadComplete, false); assert.match(app.ui.status.textContent, /已停止以避免重复请求/);
});

for (const [name, result, pattern] of [
  ['invalid JSON', () => ({ ...response(), json: async () => { throw new SyntaxError('bad JSON'); } }), /有效 JSON/],
  ['changed response shape', () => response({ conversations: [] }), /响应格式已变化/],
  ['empty page claiming more data', () => response({ items: [], has_more: true }), /空页/],
]) {
  test(name + ' is an explicit error, not successful empty loading', async () => {
    let calls = 0;
    const { app, clock } = setup(async () => { calls++; return result(); });
    await clock.run(app.loadAll({ reset: true }));
    assert.equal(calls, 1); assert.equal(app.state.loadComplete, false); assert.equal(app.state.statusError, true); assert.match(app.ui.status.textContent, pattern);
  });
}

test('refresh starts at zero and replaces stale selections and conversations', async () => {
  const offsets = [];
  const { app, clock } = setup(async url => { offsets.push(new URL(url).searchParams.get('offset')); return response({ items: [{ id: 'NEW', title: '新会话' }], has_more: false }); });
  seed(app, ['OLD']); select(app, ['OLD']); app.state.nextOffset = 50;
  await clock.run(app.loadAll({ reset: true }));
  assert.deepEqual(offsets, ['0']); assert.deepEqual(Array.from(app.state.conversations.keys()), ['NEW']); assert.equal(app.state.selected.size, 0);
});

test('concurrent 401 responses share a single refresh and retry with the new token', async () => {
  let sessions = 0, oldRequests = 0, newRequests = 0;
  const { app, clock, storage } = setup(async (url, options) => {
    if (url.endsWith('/api/auth/session')) { sessions++; return response({ accessToken: 'fresh-token' }); }
    if (options.headers.Authorization === 'Bearer test-token') { oldRequests++; return response({}, 401); }
    assert.equal(options.headers.Authorization, 'Bearer fresh-token'); newRequests++; return response();
  });
  seed(app, ['A', 'B', 'C']); select(app, ['A', 'B', 'C']); await clock.run(confirm(app));
  assert.equal(sessions, 1); assert.equal(oldRequests, 3); assert.equal(newRequests, 3);
  assert.equal(app.state.progress.success, 3); assert.equal(storage.size, 0);
  assert.doesNotMatch(app.ui.log.textContent, /test-token|fresh-token/);
});

test('403 stops scheduling the remaining batch', async () => {
  let calls = 0;
  const { app, clock } = setup(async () => { calls++; return response({}, 403); });
  seed(app, ['A', 'B', 'C', 'D', 'E']); select(app, ['A', 'B', 'C', 'D', 'E']);
  await clock.run(confirm(app));
  assert.equal(calls, 3); assert.equal(app.state.selected.size, 5); assert.match(app.ui.status.textContent, /访问被拒绝/);
});

test('persistent 401 refreshes only once per request and stops the batch', async () => {
  let sessions = 0, writes = 0;
  const { app, clock } = setup(async url => {
    if (url.endsWith('/api/auth/session')) { sessions++; return response({ accessToken: 'still-invalid' }); }
    writes++; return response({}, 401);
  });
  seed(app, ['A']); select(app, ['A']); await clock.run(confirm(app));
  assert.equal(sessions, 1); assert.equal(writes, 2); assert.match(app.ui.status.textContent, /登录已失效/);
});

test('429 shares Retry-After cooldown and all requests retain global spacing', async () => {
  const calls = []; let limited = false; let clock;
  const setupResult = setup(async url => {
    calls.push({ id: url.split('/').pop(), at: clock.now });
    if (!limited) { limited = true; return response({}, 429, { 'retry-after': '2' }); }
    return response();
  });
  const app = setupResult.app; clock = setupResult.clock;
  seed(app, ['A', 'B', 'C']); select(app, ['A', 'B', 'C']); await clock.run(confirm(app));
  assert.equal(calls.length, 4);
  assert.equal(calls[1].at - calls[0].at >= 2000, true);
  for (let index = 1; index < calls.length; index++) assert.equal(calls[index].at - calls[index - 1].at >= 250, true);
  assert.equal(app.state.progress.success, 3);
});

test('temporary failures have a bounded retry budget', async () => {
  let calls = 0;
  const { app, clock } = setup(async () => { calls++; return response({}, 503); });
  await assert.rejects(clock.run(app.request('/test')), /HTTP 503/); assert.equal(calls, 3);
});

test('network errors retry and a later successful response is accepted', async () => {
  let calls = 0;
  const { app, clock } = setup(async () => { calls++; if (calls === 1) throw new TypeError('offline'); return response({ ok: true }); });
  const result = await clock.run(app.request('/test')); assert.equal(result.ok, true); assert.equal(calls, 2);
});

test('timeout covers the response body and retries remain bounded', async () => {
  let calls = 0;
  const { app, clock } = setup(async (_, options) => { calls++; return { ...response(), text: () => abortable(options.signal) }; });
  const start = clock.now;
  await assert.rejects(clock.run(app.request('/test', { method: 'PATCH', body: { is_visible: false }, json: false })), /请求超时/);
  assert.equal(calls, 3); assert.equal(clock.now - start >= 45000, true);
});

test('stopping load aborts the current request and a later resume can succeed', async () => {
  let hang = true, calls = 0;
  const { app, clock } = setup(async (_, options) => { calls++; if (hang) return abortable(options.signal); return response({ items: [{ id: 'A' }], has_more: false }); });
  const pending = app.loadAll({ reset: true }); await clock.until(() => calls === 1); app.stopTask();
  await clock.run(pending); assert.equal(app.state.loading, false); assert.equal(app.state.loadError, ''); assert.match(app.ui.status.textContent, /加载已停止/);
  hang = false; await clock.run(app.loadAll()); assert.equal(app.state.loadComplete, true); assert.equal(app.state.conversations.size, 1);
});

test('close cancels an unconfirmed snapshot and remount preserves the filter', () => {
  let calls = 0; const { app } = setup(async () => { calls++; return response(); });
  seed(app, ['A', 'B']); select(app, ['A']); app.ui.search.value = 'B'; app.showConfirmation();
  app.setOpen(false); assert.equal(app.state.confirmIds, null); assert.equal(calls, 0);
  app.ui.root.remove(); app.mountUI(); assert.equal(app.ui.search.value, 'B'); assert.equal(app.state.visibleIds.size, 1);
});

test('logs stay bounded and never create nodes from log markup', () => {
  const { app } = setup(); for (let index = 0; index < 150; index++) app.logLine('<b>' + index + '</b>');
  assert.equal(app.ui.log.children.length, 100); assert.equal(app.ui.log.children[0].textContent, '<b>149</b>'); assert.equal(app.ui.log.children[0].children.length, 0);
});

test('deleting from a partial list invalidates its cursor before resuming', async () => {
  const offsets = [];
  const { app, clock } = setup(async (url, options) => {
    if (options.method === 'PATCH') return response();
    offsets.push(new URL(url).searchParams.get('offset'));
    return response({ items: [{ id: 'NEW', title: '剩余会话' }], has_more: false });
  });
  seed(app, ['A', 'B']); app.state.loadComplete = false; app.state.nextOffset = 50; select(app, ['A']);
  await clock.run(confirm(app));
  assert.equal(app.state.loadNeedsRefresh, true); assert.equal(app.ui.resume.textContent, '重新加载');
  await clock.run(app.ui.resume.click());
  assert.deepEqual(offsets, ['0']); assert.deepEqual(Array.from(app.state.conversations.keys()), ['NEW']); assert.equal(app.state.loadNeedsRefresh, false);
});

test('a fully deleted partial list offers a fresh reload in the empty state', async () => {
  const { app, clock } = setup(async () => response());
  seed(app, ['A']); app.state.loadComplete = false; select(app, ['A']);
  app.showConfirmation(); assert.equal(app.ui.panel.getAttribute('aria-labelledby'), 'tm-bulkdel-confirm-title');
  await clock.run(app.deleteConfirmed());
  assert.equal(app.ui.panel.getAttribute('aria-labelledby'), 'tm-bulkdel-title');
  assert.equal(app.ui.load.hidden, false); assert.equal(app.ui.load.textContent, '重新加载');
});
