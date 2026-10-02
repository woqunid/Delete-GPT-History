// ==UserScript==
// @name         ChatGPT 批量删除会话
// @namespace    https://tampermonkey.net/
// @version      0.7.0
// @description  加载、搜索并批量清理 ChatGPT 会话，支持删除预览、停止任务和失败重试
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const ORIGIN = location.origin;
  const LIMIT_PER_PAGE = 50;
  const DELETE_CONCURRENCY = 3;
  const REQUEST_GAP_MS = 250;
  const REQUEST_TIMEOUT_MS = 15000;
  const MAX_RETRIES = 2;
  const DISPLAY_BATCH = 100;
  const FAB_POS_KEY = 'tm_bulkdel_fab_pos_v2';
  const state = {
    token: null, tokenExpiresAt: 0, tokenPromise: null,
    nextRequestAt: 0, cooldownUntil: 0,
    loading: false, deleting: false, cancelDelete: false, loadController: null,
    started: false, loadComplete: false, nextOffset: 0, loadNeedsRefresh: false, loadError: '',
    conversations: new Map(), selected: new Set(), visibleIds: new Set(),
    filter: '', displayLimit: DISPLAY_BATCH, confirmIds: null, confirmLimit: DISPLAY_BATCH,
    open: false, returnFocus: null, progress: null, status: '', statusError: false,
    syncNeeded: false,
  };
  let ui = null;
  let renderTimer = null;
  let searchTimer = null;
  let mountFrame = null;
  let observer = null;

  GM_addStyle(`
    #tm-bulkdel-root {
      --tm-bg: #fff; --tm-text: #292929; --tm-muted: #626262;
      --tm-stroke: #e5e5e5; --tm-soft: #f7f7f7;
      --tm-primary: #292929; --tm-on-primary: #fff;
      --tm-danger: #bb3030; --tm-on-danger: #fff; --tm-danger-soft: #fff3f3;
      --tm-shadow: 0 8px 32px #0000001a;
      font: 14px/1.5 system-ui, -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif;
      color: var(--tm-text); color-scheme: light;
    }
    @media (prefers-color-scheme: dark) {
      #tm-bulkdel-root {
        --tm-bg: #242424; --tm-text: #ededed; --tm-muted: #b6b6b6;
        --tm-stroke: #424242; --tm-soft: #2e2e2e;
        --tm-primary: #ededed; --tm-on-primary: #242424;
        --tm-danger: #f38c8c; --tm-on-danger: #351313; --tm-danger-soft: #382525;
        --tm-shadow: 0 8px 32px #00000050; color-scheme: dark;
      }
    }
    html.dark #tm-bulkdel-root, html[data-theme='dark'] #tm-bulkdel-root {
      --tm-bg: #242424; --tm-text: #ededed; --tm-muted: #b6b6b6;
      --tm-stroke: #424242; --tm-soft: #2e2e2e;
      --tm-primary: #ededed; --tm-on-primary: #242424;
      --tm-danger: #f38c8c; --tm-on-danger: #351313; --tm-danger-soft: #382525;
      --tm-shadow: 0 8px 32px #00000050; color-scheme: dark;
    }
    html.light #tm-bulkdel-root, html[data-theme='light'] #tm-bulkdel-root {
      --tm-bg: #fff; --tm-text: #292929; --tm-muted: #626262;
      --tm-stroke: #e5e5e5; --tm-soft: #f7f7f7;
      --tm-primary: #292929; --tm-on-primary: #fff;
      --tm-danger: #bb3030; --tm-on-danger: #fff; --tm-danger-soft: #fff3f3;
      --tm-shadow: 0 8px 32px #0000001a; color-scheme: light;
    }
    #tm-bulkdel-root *, #tm-bulkdel-root *::before, #tm-bulkdel-root *::after { box-sizing: border-box; }
    #tm-bulkdel-root [hidden] { display: none !important; }
    #tm-bulkdel-root button, #tm-bulkdel-root input { font: inherit; }
    #tm-bulkdel-root button { cursor: pointer; }
    #tm-bulkdel-root button:disabled { opacity: .45; cursor: default; }
    #tm-bulkdel-root button:focus-visible, #tm-bulkdel-root input:focus-visible, #tm-bulkdel-root summary:focus-visible { outline: 2px solid var(--tm-primary); outline-offset: 3px; }
    #tm-bulkdel-fab {
      position: fixed; right: 16px; bottom: 16px; width: 48px; height: 48px;
      display: grid; place-items: center; z-index: 999997;
      border: 1px solid var(--tm-stroke); border-radius: 50%; background: var(--tm-bg);
      color: var(--tm-text); box-shadow: var(--tm-shadow); font-size: 21px;
      cursor: grab; user-select: none; touch-action: none;
    }
    #tm-bulkdel-fab:active { cursor: grabbing; }
    #tm-bulkdel-overlay { position: fixed; inset: 0; background: #00000038; z-index: 999998; backdrop-filter: blur(2px); }
    #tm-bulkdel-panel {
      position: fixed; right: 16px; bottom: 80px; width: 440px; max-width: calc(100vw - 32px);
      max-height: calc(100vh - 104px); max-height: calc(100dvh - 104px);
      display: flex; flex-direction: column; z-index: 999999;
      background: var(--tm-bg); color: var(--tm-text); border: 1px solid var(--tm-stroke);
      border-radius: 16px; box-shadow: var(--tm-shadow); overflow: hidden;
    }
    #tm-bulkdel-panel header { padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; gap: 10px; border-bottom: 1px solid var(--tm-stroke); flex-shrink: 0; }
    #tm-bulkdel-panel h2 { margin: 0; font-size: 18px; font-weight: 600; }
    #tm-bulkdel-panel .subtitle { margin: 3px 0 0; font-size: 13px; color: var(--tm-muted); }
    #tm-bulkdel-panel .actions { display: flex; align-items: center; gap: 4px; }
    #tm-bulkdel-panel .btn { border: 1px solid var(--tm-stroke); border-radius: 8px; padding: 8px 12px; min-height: 38px; background: var(--tm-bg); color: var(--tm-text); white-space: nowrap; }
    #tm-bulkdel-panel .btn:hover:not(:disabled) { background: var(--tm-soft); }
    #tm-bulkdel-panel .btn.quiet { border-color: transparent; color: var(--tm-muted); padding: 7px; background: transparent; }
    #tm-bulkdel-panel .btn.primary { background: var(--tm-primary); color: var(--tm-on-primary); border-color: var(--tm-primary); }
    #tm-bulkdel-panel .btn.danger { background: var(--tm-danger); color: var(--tm-on-danger); border-color: var(--tm-danger); }
    #tm-bulkdel-panel .btn.primary:hover:not(:disabled), #tm-bulkdel-panel .btn.danger:hover:not(:disabled) { filter: brightness(.92); }
    #tm-bulkdel-panel .close { font-size: 22px; width: 38px; padding: 2px; }
    #tm-bulkdel-panel main, #tm-bulkdel-confirm { min-height: 0; overflow: auto; overscroll-behavior: contain; }
    #tm-bulkdel-panel .search { display: block; margin: 16px 18px 0; }
    #tm-bulkdel-panel .search input { width: 100%; padding: 10px 12px; border: 1px solid var(--tm-stroke); border-radius: 9px; background: var(--tm-soft); color: var(--tm-text); }
    #tm-bulkdel-panel .search input::placeholder { color: var(--tm-muted); }
    #tm-bulkdel-panel .meta { padding: 9px 18px; font-size: 13px; color: var(--tm-muted); }
    #tm-bulkdel-panel .selection-warning { margin: 0 18px 10px; padding: 8px 10px; border-radius: 8px; background: var(--tm-danger-soft); color: var(--tm-danger); font-size: 13px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
    #tm-bulkdel-panel .selection-warning .btn { color: var(--tm-danger); }
    #tm-bulkdel-panel .empty { padding: 30px 18px; min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; text-align: center; }
    #tm-bulkdel-panel h3 { font-size: 16px; margin: 0; font-weight: 600; }
    #tm-bulkdel-panel .empty p { margin: 0 0 6px; color: var(--tm-muted); font-size: 13px; overflow-wrap: anywhere; }
    #tm-bulkdel-panel .list-toolbar { padding: 8px 18px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; border-bottom: 1px solid var(--tm-stroke); }
    #tm-bulkdel-panel .check-label { display: flex; gap: 9px; align-items: center; cursor: pointer; min-height: 32px; }
    #tm-bulkdel-panel input[type='checkbox'] { width: 16px; height: 16px; margin: 0; accent-color: var(--tm-primary); flex-shrink: 0; }
    #tm-bulkdel-panel .list { padding: 0 18px; max-height: 340px; max-height: min(42vh, 340px); overflow: auto; }
    #tm-bulkdel-panel .item { padding: 12px 0; display: flex; gap: 11px; align-items: center; border-bottom: 1px solid var(--tm-stroke); cursor: pointer; }
    #tm-bulkdel-panel .item:last-child { border-bottom: 0; }
    #tm-bulkdel-panel .item .text { min-width: 0; }
    #tm-bulkdel-panel .name { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    #tm-bulkdel-panel .date { display: block; margin-top: 3px; font-size: 12px; color: var(--tm-muted); }
    #tm-bulkdel-panel .list-end { padding: 8px 18px; display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 12px; color: var(--tm-muted); }
    #tm-bulkdel-panel .footer { position: sticky; bottom: 0; background: var(--tm-bg); padding: 14px 18px; border-top: 1px solid var(--tm-stroke); display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    #tm-bulkdel-panel .count { font-weight: 600; font-variant-numeric: tabular-nums; }
    #tm-bulkdel-panel .hint { font-size: 12px; color: var(--tm-muted); margin-top: 3px; }
    #tm-bulkdel-panel .task { padding: 10px 18px; background: var(--tm-soft); font-size: 13px; color: var(--tm-muted); }
    #tm-bulkdel-panel .task.error { color: var(--tm-danger); }
    #tm-bulkdel-panel .progress { height: 5px; margin-top: 8px; border-radius: 3px; background: var(--tm-stroke); overflow: hidden; }
    #tm-bulkdel-panel .progress-fill { height: 100%; background: var(--tm-primary); width: 0; }
    #tm-bulkdel-panel .task-actions { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
    #tm-bulkdel-panel details { padding: 9px 18px; font-size: 12px; color: var(--tm-muted); border-top: 1px solid var(--tm-stroke); }
    #tm-bulkdel-panel summary { cursor: pointer; }
    #tm-bulkdel-panel .log { max-height: 100px; overflow: auto; overflow-wrap: anywhere; }
    #tm-bulkdel-panel .log div { margin-top: 5px; }
    #tm-bulkdel-panel .help { margin: 8px 0 0; padding-left: 18px; }
    #tm-bulkdel-confirm { padding: 20px 18px 0; }
    #tm-bulkdel-confirm p { font-size: 13px; color: var(--tm-muted); }
    #tm-bulkdel-confirm .confirm-warning { color: var(--tm-danger); }
    #tm-bulkdel-confirm ol { padding-left: 22px; max-height: 240px; overflow: auto; overflow-wrap: anywhere; }
    #tm-bulkdel-confirm li { padding: 5px 0; }
    #tm-bulkdel-confirm .footer { margin: 16px -18px 0; justify-content: flex-end; }
    @media (max-width: 480px) {
      #tm-bulkdel-panel { right: 8px; bottom: 72px; max-width: calc(100vw - 16px); max-height: calc(100dvh - 88px); }
      #tm-bulkdel-panel header { padding: 14px; }
      #tm-bulkdel-panel .search input { font-size: 16px; }
      #tm-bulkdel-panel .footer .danger { flex-grow: 1; }
    }
    @media (pointer: coarse) {
      #tm-bulkdel-panel .btn, #tm-bulkdel-panel .check-label, #tm-bulkdel-panel .item { min-height: 44px; }
    }
  `);

  function abortError() { return new DOMException('已停止加载', 'AbortError'); }
  function sleep(ms, signal) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const finish = () => { signal?.removeEventListener('abort', cancel); resolve(); };
      const timer = setTimeout(finish, ms);
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(abortError()); };
      signal?.addEventListener('abort', cancel, { once: true });
    });
  }
  function httpError(message, status = 0) { const error = new Error(message); error.status = status; return error; }
  function retryAfterMs(value) {
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
  }
  async function requestSlot(signal) {
    while (true) {
      const slot = Math.max(Date.now(), state.nextRequestAt, state.cooldownUntil);
      state.nextRequestAt = slot + REQUEST_GAP_MS;
      await sleep(slot - Date.now(), signal);
      if (state.cooldownUntil <= Date.now()) return;
    }
  }
  function logLine(message) {
    if (!ui) return;
    const entry = document.createElement('div');
    entry.textContent = message;
    ui.log.prepend(entry);
    while (ui.log.children.length > 100) ui.log.lastElementChild.remove();
    ui.logDetails.hidden = false;
  }
  async function request(path, { method = 'GET', body, signal, auth = true, json = true } = {}) {
    let retries = 0;
    let refreshed = false;
    while (true) {
      if (signal?.aborted) throw abortError();
      const token = auth ? await getAccessToken(signal) : null;
      await requestSlot(signal);
      if (signal?.aborted) throw abortError();
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
      let retryDelay = null;
      try {
        const headers = {};
        if (token) headers.Authorization = 'Bearer ' + token;
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const response = await fetch(ORIGIN + path, {
          method, headers, credentials: 'include', signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (response.status === 401 && auth && !refreshed) {
          if (state.token === token) { state.token = null; state.tokenExpiresAt = 0; }
          refreshed = true;
          await response.body?.cancel();
          continue;
        }
        if (!response.ok) {
          const retryable = [429, 502, 503, 504].includes(response.status);
          if (retryable && retries < MAX_RETRIES) {
            retryDelay = Math.max(1000 * 2 ** retries, retryAfterMs(response.headers.get('Retry-After')));
            logLine('HTTP ' + response.status + '，等待 ' + Math.ceil(retryDelay / 1000) + ' 秒后重试。');
            await response.body?.cancel();
          } else {
            const hint = response.status === 401 ? '登录已失效，请重新登录后重试。' : response.status === 403 ? '访问被拒绝，请刷新 ChatGPT 页面后重试。' : '请求失败：HTTP ' + response.status;
            throw httpError(hint, response.status);
          }
        } else if (json) {
          try { return await response.json(); }
          catch (error) {
            if (controller.signal.aborted) throw error;
            throw httpError('接口响应不是有效 JSON，请刷新页面后重试。');
          }
        } else {
          await response.text();
          return null;
        }
      } catch (error) {
        if (signal?.aborted) throw abortError();
        if ((timedOut || error instanceof TypeError) && retries < MAX_RETRIES) {
          retryDelay = 1000 * 2 ** retries;
          logLine((timedOut ? '请求超时' : '网络连接失败') + '，稍后重试。');
        } else if (timedOut) {
          throw httpError('请求超时，请稍后重试；已发出的操作可能已经生效。');
        } else {
          throw error;
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      }
      retries++;
      state.cooldownUntil = Math.max(state.cooldownUntil, Date.now() + retryDelay);
    }
  }
  async function getAccessToken(signal) {
    if (state.token && Date.now() < state.tokenExpiresAt) return state.token;
    if (!state.tokenPromise) {
      state.tokenPromise = (async () => {
        const data = await request('/api/auth/session', { auth: false, signal });
        if (!data || typeof data.accessToken !== 'string' || !data.accessToken) throw httpError('无法获取登录状态，请确认已登录 ChatGPT。', 401);
        state.token = data.accessToken;
        state.tokenExpiresAt = Date.now() + 5 * 60 * 1000;
        return state.token;
      })().finally(() => { state.tokenPromise = null; });
    }
    return state.tokenPromise;
  }
  async function fetchConversationsPage(offset, signal) {
    const data = await request('/backend-api/conversations?offset=' + offset + '&limit=' + LIMIT_PER_PAGE, { signal });
    if (!data || !Array.isArray(data.items) || ('has_more' in data && typeof data.has_more !== 'boolean')) throw httpError('会话列表响应格式已变化，未继续加载。');
    const items = data.items.map(item => {
      if (!item || typeof item.id !== 'string' || !item.id) throw httpError('会话列表包含无效 ID，未继续加载。');
      const title = typeof item.title === 'string' && item.title ? item.title : '(无标题)';
      return { id: item.id, title, update_time: item.update_time, search: (title + '\n' + item.id).toLowerCase() };
    });
    const hasMore = typeof data.has_more === 'boolean' ? data.has_more : data.items.length === LIMIT_PER_PAGE;
    if (hasMore && !items.length) throw httpError('接口返回空页但仍标记有更多会话，请重新加载。');
    return { items, hasMore, count: data.items.length };
  }
  function busy() { return state.loading || state.deleting; }
  function locked() { return busy() || state.confirmIds !== null; }
  function getFilteredConversations() {
    const query = state.filter.trim().toLowerCase();
    return Array.from(state.conversations.values()).filter(row => !query || row.search.includes(query));
  }
  function selectedOutsideFilter() { let count = 0; for (const id of state.selected) if (!state.visibleIds.has(id)) count++; return count; }
  function formatDate(value) {
    if (value === undefined || value === null) return '更新时间未知';
    const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? '更新时间未知' : '更新于 ' + date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function renderState() {
    if (!ui) return;
    const count = state.conversations.size;
    const outside = selectedOutsideFilter();
    const selectedVisible = state.selected.size - outside;
    ui.panel.setAttribute('aria-busy', String(busy()));
    ui.panel.setAttribute('aria-labelledby', state.confirmIds ? 'tm-bulkdel-confirm-title' : 'tm-bulkdel-title');
    ui.search.disabled = locked() || !count;
    ui.refresh.hidden = !state.started;
    ui.refresh.disabled = locked();
    ui.load.disabled = locked();
    ui.load.hidden = state.loading || count > 0;
    ui.load.textContent = state.loadNeedsRefresh || state.loadComplete ? '重新加载' : state.started ? '继续加载' : '加载会话';
    ui.resume.hidden = count === 0 || state.loadComplete || busy();
    ui.resume.disabled = locked();
    ui.resume.textContent = state.loadNeedsRefresh ? '重新加载' : '继续加载';
    ui.stop.hidden = !busy();
    ui.stop.disabled = state.deleting && state.cancelDelete;
    ui.stop.textContent = state.loading ? '停止加载' : state.cancelDelete ? '正在停止…' : '停止删除';
    ui.loaded.hidden = count === 0;
    ui.empty.hidden = count > 0;
    ui.emptyTitle.textContent = state.loading ? '正在加载会话' : state.loadError ? '加载未完成' : state.loadComplete ? '暂无会话' : state.started ? '加载已停止' : '尚未加载会话';
    ui.emptyDescription.textContent = state.loadError || (state.loading ? '正在获取列表，可随时停止加载。' : state.loadComplete ? '当前没有可显示的会话。' : '先加载列表，再选择需要删除的记录。');
    ui.meta.textContent = state.started ? '已加载 ' + count + ' 条 · 当前显示 ' + state.visibleIds.size + ' 条' + (!state.loadComplete ? ' · 尚未加载完' : '') : '加载后可搜索和选择会话';
    ui.count.textContent = '已选 ' + state.selected.size + ' 条';
    ui.delete.disabled = locked() || !state.selected.size;
    ui.delete.textContent = state.selected.size ? '删除 ' + state.selected.size + ' 条会话' : '删除选中';
    ui.clear.disabled = locked() || !state.selected.size;
    ui.clearHidden.disabled = locked();
    ui.all.disabled = locked() || !state.visibleIds.size;
    ui.all.checked = state.visibleIds.size > 0 && selectedVisible === state.visibleIds.size;
    ui.all.indeterminate = selectedVisible > 0 && selectedVisible < state.visibleIds.size;
    ui.warning.hidden = !outside;
    ui.warningText.textContent = '另有 ' + outside + ' 条已选会话不在当前搜索结果中';
    for (const [id, row] of ui.rows) { row.checkbox.disabled = locked(); row.checkbox.checked = state.selected.has(id); }
    ui.task.hidden = !state.status && !state.loading && !state.deleting;
    ui.task.classList.toggle('error', state.statusError);
    ui.status.textContent = state.loading ? '正在加载 · 已获取 ' + count + ' 条' : state.status;
    const progress = state.progress;
    ui.progress.hidden = !progress;
    if (progress) {
      const processed = progress.success + progress.fail;
      ui.progress.setAttribute('aria-valuenow', String(processed));
      ui.progress.setAttribute('aria-valuemax', String(progress.total));
      ui.progressFill.style.width = (progress.total ? processed / progress.total * 100 : 0) + '%';
    }
    ui.retry.hidden = busy() || !progress || progress.fail === 0;
    ui.retry.disabled = locked();
    ui.sync.hidden = busy() || !state.syncNeeded;
    const shown = Math.min(state.visibleIds.size, state.displayLimit);
    ui.listCount.textContent = '显示 ' + shown + ' / ' + state.visibleIds.size + ' 条';
    ui.more.hidden = shown >= state.visibleIds.size;
    ui.more.disabled = locked();
    ui.main.hidden = state.confirmIds !== null;
    ui.confirm.hidden = state.confirmIds === null;
  }
  function renderList() {
    if (!ui) return;
    const filtered = getFilteredConversations();
    state.visibleIds = new Set(filtered.map(row => row.id));
    const activeId = document.activeElement?.dataset?.conversationId;
    const fragment = document.createDocumentFragment();
    for (const item of filtered.slice(0, state.displayLimit)) {
      let row = ui.rows.get(item.id);
      if (!row) {
        const element = document.createElement('label'); element.className = 'item';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.dataset.conversationId = item.id;
        checkbox.setAttribute('aria-label', '选择 ' + item.title);
        checkbox.addEventListener('change', () => {
          if (locked()) { checkbox.checked = state.selected.has(item.id); return; }
          if (checkbox.checked) state.selected.add(item.id); else state.selected.delete(item.id);
          renderState();
        });
        const text = document.createElement('span'); text.className = 'text';
        const title = document.createElement('span'); title.className = 'name'; title.textContent = item.title; title.title = item.title;
        const date = document.createElement('span'); date.className = 'date'; date.textContent = formatDate(item.update_time);
        text.append(title, date); element.append(checkbox, text);
        row = { element, checkbox, title, date }; ui.rows.set(item.id, row);
      }
      row.title.textContent = item.title; row.title.title = item.title;
      row.date.textContent = formatDate(item.update_time);
      row.checkbox.setAttribute('aria-label', '选择 ' + item.title);
      fragment.append(row.element);
    }
    if (filtered.length === 0 && state.conversations.size > 0) {
      const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '没有匹配的会话，试试其他关键词。'; fragment.append(empty);
    }
    ui.list.replaceChildren(fragment);
    renderState();
    if (activeId && ui.rows.get(activeId)?.element.isConnected) ui.rows.get(activeId).checkbox.focus();
  }
  function scheduleRender() {
    if (renderTimer !== null) return;
    renderTimer = setTimeout(() => { renderTimer = null; renderList(); }, 120);
  }
  function flushRender() { clearTimeout(renderTimer); renderTimer = null; renderList(); }
  async function loadAll({ reset = false } = {}) {
    if (locked()) return;
    state.loading = true;
    state.started = true;
    state.loadError = '';
    state.progress = null;
    state.status = ''; state.statusError = false;
    if (reset || state.loadNeedsRefresh) {
      state.conversations.clear(); state.selected.clear(); ui?.rows.clear();
      state.nextOffset = 0; state.loadComplete = false; state.loadNeedsRefresh = false; state.filter = ''; state.displayLimit = DISPLAY_BATCH;
      clearTimeout(searchTimer); searchTimer = null;
      if (ui) ui.search.value = '';
    }
    state.loadController = new AbortController();
    const signal = state.loadController.signal;
    flushRender();
    logLine(reset ? '开始重新加载会话。' : '开始加载会话。');
    try {
      while (!state.loadComplete) {
        const page = await fetchConversationsPage(state.nextOffset, signal);
        let added = 0;
        for (const row of page.items) { if (!state.conversations.has(row.id)) added++; state.conversations.set(row.id, row); }
        state.nextOffset += page.count;
        state.loadComplete = !page.hasMore;
        scheduleRender();
        if (page.hasMore && added === 0) throw httpError('接口连续返回已加载的会话，已停止以避免重复请求。请重新加载。');
        logLine('已加载 ' + state.conversations.size + ' 条。');
      }
      state.status = '加载完成 · 共 ' + state.conversations.size + ' 条会话';
    } catch (error) {
      if (error.name === 'AbortError') state.status = '加载已停止 · 可继续加载';
      else { state.loadError = error.message || String(error); state.status = '加载失败：' + state.loadError; state.statusError = true; logLine(state.status); }
    } finally {
      state.loading = false; state.loadController = null; flushRender();
    }
  }
  function startOrResume() { return loadAll({ reset: !state.started || state.loadComplete }); }
  function toggleSelectAll() {
    if (locked()) return;
    clearTimeout(searchTimer); searchTimer = null;
    if (ui) state.filter = ui.search.value;
    flushRender();
    const allSelected = state.visibleIds.size > 0 && Array.from(state.visibleIds).every(id => state.selected.has(id));
    for (const id of state.visibleIds) { if (allSelected) state.selected.delete(id); else state.selected.add(id); }
    renderState();
  }
  function clearSelection() { if (locked()) return; state.selected.clear(); renderState(); }
  function showConfirmation(ids = Array.from(state.selected)) {
    if (locked() || !ids.length) return;
    clearTimeout(searchTimer); searchTimer = null;
    if (ui) state.filter = ui.search.value;
    flushRender();
    state.confirmIds = ids.filter(id => state.conversations.has(id));
    if (!state.confirmIds.length) { state.confirmIds = null; return; }
    state.confirmLimit = DISPLAY_BATCH;
    renderConfirmation(); renderState(); ui.cancelConfirm.focus();
  }
  function renderConfirmation() {
    if (!ui || !state.confirmIds) return;
    ui.confirmTitle.textContent = '确认删除 ' + state.confirmIds.length + ' 条会话？';
    ui.confirmDelete.textContent = '确认删除 ' + state.confirmIds.length + ' 条';
    const outside = state.confirmIds.filter(id => !state.visibleIds.has(id)).length;
    ui.confirmWarning.hidden = outside === 0;
    ui.confirmWarning.textContent = '其中 ' + outside + ' 条不在当前搜索结果中，请核对后再删除。';
    ui.confirmList.replaceChildren();
    for (const id of state.confirmIds.slice(0, state.confirmLimit)) {
      const item = document.createElement('li'); item.textContent = state.conversations.get(id).title; ui.confirmList.append(item);
    }
    ui.confirmMore.hidden = state.confirmLimit >= state.confirmIds.length;
    ui.confirmMore.textContent = '显示更多待删会话（还剩 ' + Math.max(0, state.confirmIds.length - state.confirmLimit) + ' 条）';
  }
  function cancelConfirmation() { state.confirmIds = null; renderState(); ui?.delete.focus(); }
  async function deleteConfirmed() {
    if (busy() || !state.confirmIds?.length) return;
    const ids = state.confirmIds.slice();
    for (const id of ids) state.selected.add(id);
    state.confirmIds = null; state.deleting = true; state.cancelDelete = false;
    state.statusError = false;
    state.progress = { total: ids.length, success: 0, fail: 0, failedIds: [] };
    state.status = '正在删除 · 已处理 0/' + ids.length;
    renderState();
    let index = 0;
    let stopReason = '';
    async function worker() {
      while (index < ids.length && !state.cancelDelete) {
        const id = ids[index++];
        try {
          await request('/backend-api/conversation/' + encodeURIComponent(id), { method: 'PATCH', body: { is_visible: false }, json: false });
          state.progress.success++; state.selected.delete(id); state.conversations.delete(id); state.visibleIds.delete(id);
          if (!state.loadComplete) state.loadNeedsRefresh = true;
          ui?.rows.get(id)?.element.remove(); ui?.rows.delete(id); state.syncNeeded = true;
          logLine('删除成功：' + id);
        } catch (error) {
          state.progress.fail++; state.progress.failedIds.push(id);
          logLine('删除失败：' + id + '（' + (error.message || error) + '）');
          if (error.status === 401 || error.status === 403) { state.cancelDelete = true; stopReason = error.message; }
        }
        const progress = state.progress;
        state.status = '正在删除 · 已处理 ' + (progress.success + progress.fail) + '/' + progress.total + ' · 成功 ' + progress.success + ' · 失败 ' + progress.fail;
        scheduleRender();
      }
    }
    try {
      await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, worker));
      const progress = state.progress;
      const processed = progress.success + progress.fail;
      state.status = (state.cancelDelete ? '已停止' : '已完成') + ' · 已处理 ' + processed + '/' + progress.total + ' · 成功 ' + progress.success + ' · 失败 ' + progress.fail + (processed < progress.total ? ' · 未执行 ' + (progress.total - processed) : '') + (stopReason ? ' · ' + stopReason : '');
      if (state.loadNeedsRefresh) state.status += ' · 列表尚未加载完，请重新加载获取剩余会话';
      state.statusError = progress.fail > 0;
      logLine(state.status);
    } finally {
      state.deleting = false; flushRender();
    }
  }
  function stopTask() {
    if (state.loading) state.loadController?.abort();
    else if (state.deleting) { state.cancelDelete = true; state.status += ' · 等待当前请求结束'; renderState(); }
  }
  function setOpen(open) {
    if (!ui) return;
    if (open && !state.open) state.returnFocus = document.activeElement;
    if (!open && state.confirmIds !== null) cancelConfirmation();
    state.open = open; ui.overlay.hidden = !open; ui.panel.hidden = !open;
    ui.fab.setAttribute('aria-expanded', String(open));
    if (open) ui.close.focus();
    else if (state.returnFocus?.isConnected) state.returnFocus.focus();
    else ui.fab.focus();
  }
  function clamp(value, min, max) { return Math.max(min, Math.min(Math.max(min, max), value)); }
  function applyFabPos(fab, x, y, save = false) {
    const next = { x: clamp(x, 8, window.innerWidth - (fab.offsetWidth || 48) - 8), y: clamp(y, 8, window.innerHeight - (fab.offsetHeight || 48) - 8) };
    Object.assign(fab.style, { left: next.x + 'px', top: next.y + 'px', right: 'auto', bottom: 'auto' });
    if (save) { try { localStorage.setItem(FAB_POS_KEY, JSON.stringify(next)); } catch {} }
  }
  function initFab(fab) {
    let drag = null;
    let suppressClick = false;
    fab.addEventListener('click', event => { if (suppressClick && event.detail !== 0) { suppressClick = false; return; } suppressClick = false; setOpen(!state.open); });
    fab.addEventListener('pointerdown', event => {
      if (event.button !== undefined && event.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
      fab.setPointerCapture(event.pointerId);
    });
    fab.addEventListener('pointermove', event => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) drag.moved = true;
      if (drag.moved) { event.preventDefault(); applyFabPos(fab, drag.left + dx, drag.top + dy); }
    });
    fab.addEventListener('pointerup', event => {
      if (!drag || drag.id !== event.pointerId) return;
      suppressClick = drag.moved;
      if (drag.moved) { const rect = fab.getBoundingClientRect(); applyFabPos(fab, rect.left, rect.top, true); }
      try { fab.releasePointerCapture(event.pointerId); } catch {}
      drag = null;
    });
    fab.addEventListener('pointercancel', () => { drag = null; suppressClick = false; });
    let saved;
    try { saved = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null'); } catch {}
    if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) applyFabPos(fab, saved.x, saved.y);
  }
  function mountUI() {
    if (!document.body || document.getElementById('tm-bulkdel-root')) return;
    const root = document.createElement('div'); root.id = 'tm-bulkdel-root';
    root.innerHTML = `
      <button id="tm-bulkdel-fab" type="button" aria-label="打开聊天记录清理面板" aria-controls="tm-bulkdel-panel" aria-expanded="false">🗑</button>
      <div id="tm-bulkdel-overlay" hidden></div>
      <section id="tm-bulkdel-panel" role="dialog" aria-modal="true" aria-labelledby="tm-bulkdel-title" aria-describedby="tm-bulkdel-subtitle" hidden>
        <header>
          <div><h2 id="tm-bulkdel-title">清理聊天记录</h2><p id="tm-bulkdel-subtitle" class="subtitle">选择需要删除的会话</p></div>
          <div class="actions"><button class="btn quiet" data-ui="refresh" type="button" hidden>刷新</button><button class="btn quiet close" data-ui="close" type="button" aria-label="关闭面板">×</button></div>
        </header>
        <main data-ui="main">
          <label class="search"><input data-ui="search" type="search" aria-label="搜索会话标题或 ID" placeholder="搜索会话标题或 ID…" disabled></label>
          <div class="meta" data-ui="meta"></div>
          <div class="selection-warning" data-ui="warning" hidden><span data-ui="warningText"></span><button class="btn quiet" data-ui="clearHidden" type="button">清空选择</button></div>
          <div class="empty" data-ui="empty"><h3 data-ui="emptyTitle"></h3><p data-ui="emptyDescription"></p><button class="btn primary" data-ui="load" type="button">加载会话</button></div>
          <div data-ui="loaded" hidden>
            <div class="list-toolbar"><label class="check-label"><input data-ui="all" type="checkbox"><span>全选当前结果</span></label><div class="actions"><button class="btn quiet" data-ui="resume" type="button" hidden>继续加载</button><button class="btn quiet" data-ui="clear" type="button">清空选择</button></div></div>
            <div class="list" data-ui="list"></div>
            <div class="list-end"><span data-ui="listCount"></span><button class="btn quiet" data-ui="more" type="button" hidden>显示更多</button></div>
          </div>
          <div class="task" data-ui="task" hidden>
            <div data-ui="status" role="status" aria-live="polite"></div>
            <div class="progress" data-ui="progress" role="progressbar" aria-label="删除处理进度" aria-valuemin="0" hidden><div class="progress-fill" data-ui="progressFill"></div></div>
            <div class="task-actions"><button class="btn" data-ui="stop" type="button" hidden>停止加载</button><button class="btn" data-ui="retry" type="button" hidden>重试失败项</button><button class="btn quiet" data-ui="sync" type="button" hidden>刷新页面同步侧栏</button></div>
          </div>
          <details data-ui="logDetails" hidden><summary>操作详情</summary><div class="log" data-ui="log"></div></details>
          <details><summary>使用帮助</summary><ul class="help"><li>加载会话后，按标题或 ID 搜索并勾选；全选只作用于当前搜索结果。</li><li>切换搜索不会清除之前的选择，删除前请核对完整的待删列表。</li><li>停止删除会停止安排后续会话，已发出的请求仍会完成。</li><li>关闭：Esc 或点击遮罩。拖动垃圾桶按钮可调整位置。</li><li>本工具不提供撤销，也不能保证服务器永久清除聊天数据。</li></ul></details>
          <footer class="footer"><div><div class="count" data-ui="count" aria-live="polite">已选 0 条</div><div class="hint">删除前可核对会话标题</div></div><button class="btn danger" data-ui="delete" type="button" disabled>删除选中</button></footer>
        </main>
        <section id="tm-bulkdel-confirm" data-ui="confirm" aria-labelledby="tm-bulkdel-confirm-title" hidden>
          <h3 id="tm-bulkdel-confirm-title" data-ui="confirmTitle"></h3><p>请核对以下会话。本工具不提供撤销。</p><p class="confirm-warning" data-ui="confirmWarning" hidden></p>
          <ol data-ui="confirmList"></ol><button class="btn quiet" data-ui="confirmMore" type="button" hidden>显示更多待删会话</button>
          <footer class="footer"><button class="btn" data-ui="cancelConfirm" type="button">返回检查</button><button class="btn danger" data-ui="confirmDelete" type="button">确认删除</button></footer>
        </section>
      </section>`;
    document.body.append(root);
    const find = name => root.querySelector('[data-ui="' + name + '"]');
    ui = { root, rows: new Map(), panel: root.querySelector('#tm-bulkdel-panel'), fab: root.querySelector('#tm-bulkdel-fab'), overlay: root.querySelector('#tm-bulkdel-overlay') };
    for (const name of ['refresh', 'close', 'main', 'search', 'meta', 'warning', 'warningText', 'clearHidden', 'empty', 'emptyTitle', 'emptyDescription', 'load', 'loaded', 'all', 'resume', 'clear', 'list', 'listCount', 'more', 'task', 'status', 'progress', 'progressFill', 'stop', 'retry', 'sync', 'logDetails', 'log', 'count', 'delete', 'confirm', 'confirmTitle', 'confirmWarning', 'confirmList', 'confirmMore', 'cancelConfirm', 'confirmDelete']) ui[name] = find(name);
    initFab(ui.fab);
    ui.close.addEventListener('click', () => setOpen(false));
    ui.overlay.addEventListener('click', () => setOpen(false));
    ui.load.addEventListener('click', startOrResume);
    ui.resume.addEventListener('click', startOrResume);
    ui.refresh.addEventListener('click', () => loadAll({ reset: true }));
    ui.all.addEventListener('change', toggleSelectAll);
    ui.clear.addEventListener('click', clearSelection);
    ui.clearHidden.addEventListener('click', clearSelection);
    ui.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { searchTimer = null; state.filter = ui.search.value; state.displayLimit = DISPLAY_BATCH; renderList(); }, 150);
    });
    ui.more.addEventListener('click', () => { if (!locked()) { state.displayLimit += DISPLAY_BATCH; renderList(); } });
    ui.delete.addEventListener('click', () => showConfirmation());
    ui.cancelConfirm.addEventListener('click', cancelConfirmation);
    ui.confirmMore.addEventListener('click', () => { state.confirmLimit += DISPLAY_BATCH; renderConfirmation(); });
    ui.confirmDelete.addEventListener('click', deleteConfirmed);
    ui.stop.addEventListener('click', stopTask);
    ui.retry.addEventListener('click', () => showConfirmation((state.progress?.failedIds || []).filter(id => state.conversations.has(id))));
    ui.sync.addEventListener('click', () => { if (!locked()) location.reload(); });
    ui.search.value = state.filter;
    renderList();
    if (state.confirmIds) renderConfirmation();
    ui.panel.hidden = !state.open; ui.overlay.hidden = !state.open; ui.fab.setAttribute('aria-expanded', String(state.open));
    observer?.disconnect();
    observer?.observe(document.documentElement, { childList: true });
    observer?.observe(document.body, { childList: true });
  }

  // Bootstrap: keep all task and authentication state private to this userscript.
  observer = new MutationObserver(() => {
    if (document.getElementById('tm-bulkdel-root') || mountFrame !== null) return;
    mountFrame = requestAnimationFrame(() => { mountFrame = null; mountUI(); });
  });
  mountUI();
  window.addEventListener('resize', () => {
    if (!ui?.fab.isConnected) return;
    const rect = ui.fab.getBoundingClientRect(); applyFabPos(ui.fab, rect.left, rect.top, true);
  }, { passive: true });
  window.addEventListener('keydown', event => {
    if (!state.open || !ui) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (state.confirmIds) cancelConfirmation(); else setOpen(false);
    } else if (event.key === 'Tab') {
      const focusable = Array.from(ui.panel.querySelectorAll('button, input, summary')).filter(element => !element.disabled && element.getClientRects().length);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (!first) return;
      if (event.shiftKey && (document.activeElement === first || !ui.panel.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ui.panel.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    }
  }, true);
})();
