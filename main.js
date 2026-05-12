// ==UserScript==
// @name         ChatGPT 批量删除会话
// @namespace    https://tampermonkey.net/
// @version      0.6.0
// @description  方形可拖拽悬浮按钮 → 弹出浅色面板 → 加载/搜索/全选/删除（不依赖侧边栏DOM）
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  const ORIGIN = location.origin;
  const LIMIT_PER_PAGE = 50;     // 每页拉取数量
  const DELETE_CONCURRENCY = 3;  // 并发删除数（2~5建议）
  const DELETE_DELAY_MS = 250;   // 每次删除间隔

  // 拖拽按钮位置存储 key
  const FAB_POS_KEY = 'tm_bulkdel_fab_pos_v1';

  const state = {
    token: null,
    loading: false,
    cancelLoad: false,
    conversations: [], // { id, title, update_time }
    selected: new Set(),
    filter: '',
    open: false,
  };

  GM_addStyle(`
    :root {
      --tm-bg: #ffffff;
      --tm-panel: #ffffff;
      --tm-stroke: #eaeaea;
      --tm-stroke2: #f4f4f4;
      --tm-text: #333333;
      --tm-muted: #888888;
      --tm-shadow: 0 8px 30px rgba(0,0,0,0.08);

      --tm-radius: 12px;
      --tm-radius2: 6px;

      --tm-btn: #f9f9f9;
      --tm-btn-hover: #f0f0f0;

      --tm-danger: #fff0f0;
      --tm-danger-stroke: #ffcccc;
      --tm-danger-text: #d32f2f;

      --tm-focus: #007aff;
    }

    /* 方形悬浮按钮 */
    #tm-bulkdel-fab {
      position: fixed; right: 16px; bottom: 16px;
      width: 48px; height: 48px;
      border-radius: 50%;
      background: var(--tm-bg); color: var(--tm-text);
      border: 1px solid var(--tm-stroke);
      box-shadow: var(--tm-shadow);
      z-index: 999999; display: flex; align-items: center; justify-content: center;
      cursor: grab; user-select: none;
      transition: transform .15s ease, box-shadow .15s ease;
      font: 14px/1 system-ui, sans-serif;
      touch-action: none;
    }
    #tm-bulkdel-fab:active { cursor: grabbing; transform: scale(0.95); }
    #tm-bulkdel-fab:hover { box-shadow: 0 12px 40px rgba(0,0,0,0.12); }
    #tm-bulkdel-fab .ico { font-size: 20px; }
    
    #tm-bulkdel-fab .tip { display: none; }

    /* 遮罩 + 弹窗 */
    #tm-bulkdel-overlay {
      position: fixed; inset: 0; background: rgba(0,0,0,0.2);
      z-index: 999998; display: none;
      backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px);
    }
    #tm-bulkdel-overlay.open { display: block; }

    #tm-bulkdel-panel {
      position: fixed; right: 16px; bottom: 80px;
      width: 400px; max-width: calc(100vw - 32px);
      height: 600px; max-height: calc(100vh - 100px);
      z-index: 999999; display: none;
      background: var(--tm-panel); color: var(--tm-text);
      border: 1px solid var(--tm-stroke); border-radius: var(--tm-radius);
      box-shadow: var(--tm-shadow); overflow: hidden;
      font: 13px/1.4 system-ui, sans-serif;
      transform: translateY(10px); opacity: 0;
      transition: transform .2s ease, opacity .2s ease;
    }
    #tm-bulkdel-panel.open { display: block; transform: translateY(0); opacity: 1; }

    #tm-bulkdel-panel header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 16px; border-bottom: 1px solid var(--tm-stroke2);
    }
    #tm-bulkdel-panel header .title { font-weight: 600; font-size: 15px; display: flex; align-items: center; gap: 8px; }
    #tm-bulkdel-panel header .title .pill {
      font-size: 11px; padding: 2px 6px; border-radius: 4px;
      background: var(--tm-stroke2); color: var(--tm-muted); font-weight: normal;
    }
    #tm-bulkdel-panel header button {
      background: none; border: none; font-size: 16px; color: var(--tm-muted);
      cursor: pointer; padding: 4px; border-radius: 4px; transition: background .15s;
    }
    #tm-bulkdel-panel header button:hover { background: var(--tm-btn-hover); color: var(--tm-text); }

    #tm-bulkdel-panel .body {
      padding: 16px; display: flex; flex-direction: column; gap: 12px;
      height: calc(100% - 46px); box-sizing: border-box;
    }

    #tm-bulkdel-panel .row { display: flex; gap: 8px; flex-wrap: wrap; }

    #tm-bulkdel-panel .btn {
      background: var(--tm-btn); color: var(--tm-text);
      border: 1px solid var(--tm-stroke); border-radius: var(--tm-radius2);
      padding: 6px 12px; font-size: 13px; cursor: pointer; user-select: none;
      transition: all .15s ease;
    }
    #tm-bulkdel-panel .btn:hover:not(:disabled) { background: var(--tm-btn-hover); border-color: #ddd; }
    #tm-bulkdel-panel .btn:active:not(:disabled) { transform: translateY(1px); }
    #tm-bulkdel-panel .btn:disabled { opacity: 0.5; cursor: not-allowed; }

    #tm-bulkdel-panel .btn.danger {
      background: var(--tm-danger); border-color: var(--tm-danger-stroke); color: var(--tm-danger-text);
    }

    #tm-bulkdel-panel input[type="text"] {
      flex: 1; min-width: 120px;
      background: #fafafa; border: 1px solid var(--tm-stroke);
      color: var(--tm-text); border-radius: var(--tm-radius2);
      padding: 6px 10px; font-size: 13px; outline: none;
      transition: border-color .15s ease;
    }
    #tm-bulkdel-panel input[type="text"]:focus {
      border-color: var(--tm-focus); background: #fff;
    }

    #tm-bulkdel-panel .meta { font-size: 12px; color: var(--tm-muted); }

    #tm-bulkdel-panel .list {
      flex: 1; overflow-y: auto; overflow-x: hidden;
      border: 1px solid var(--tm-stroke2); border-radius: var(--tm-radius2);
    }
    #tm-bulkdel-panel .item {
      display: flex; gap: 10px; padding: 10px 12px;
      border-bottom: 1px solid var(--tm-stroke2); align-items: flex-start;
      transition: background .15s;
    }
    #tm-bulkdel-panel .item:hover { background: #fafafa; }
    #tm-bulkdel-panel .item:last-child { border-bottom: none; }
    #tm-bulkdel-panel .item input { margin-top: 3px; cursor: pointer; }
    #tm-bulkdel-panel .item .t { flex: 1; min-width: 0; }
    #tm-bulkdel-panel .item .name {
      font-weight: 500; margin-bottom: 4px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #tm-bulkdel-panel .item .id { font-size: 11px; color: var(--tm-muted); }

    /* 进度条 */
    #tm-bulkdel-panel .progress-container {
      display: flex; align-items: center; gap: 10px; padding: 4px 0;
    }
    #tm-bulkdel-panel .progress-track {
      flex: 1; height: 6px; background: var(--tm-stroke2);
      border-radius: 3px; overflow: hidden;
    }
    #tm-bulkdel-panel .progress-fill {
      height: 100%; width: 0%; background: var(--tm-focus);
      transition: width 0.2s ease;
    }
    #tm-bulkdel-panel .progress-text {
      font-size: 12px; color: var(--tm-text); font-variant-numeric: tabular-nums;
      min-width: 50px; text-align: right; font-weight: 500;
    }

    #tm-bulkdel-panel .log {
      max-height: 80px; overflow: auto;
      border-radius: var(--tm-radius2); padding: 8px 10px;
      color: var(--tm-muted); font-size: 12px; background: #fafafa;
      border: 1px solid var(--tm-stroke2);
    }
    #tm-bulkdel-panel .log div { margin: 3px 0; }

    #tm-bulkdel-panel .hint { font-size: 12px; color: var(--tm-muted); text-align: center; margin-top: 4px; }
  `);

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function logLine(msg) {
    const el = document.getElementById('tm-bulkdel-log');
    if (!el) return;
    const div = document.createElement('div');
    div.textContent = msg;
    el.prepend(div);
  }

  async function getAccessToken() {
    if (state.token) return state.token;
    const resp = await fetch(`${ORIGIN}/api/auth/session`, { credentials: 'include' });
    if (!resp.ok) throw new Error(`获取 token 失败：HTTP ${resp.status}`);
    const data = await resp.json().catch(() => ({}));
    if (!data || !data.accessToken) throw new Error('获取 token 失败：响应里没有 accessToken（可能未登录/会话失效）');
    state.token = data.accessToken;
    return state.token;
  }

  async function fetchConversationsPage(offset, limit) {
    const token = await getAccessToken();
    const url = `${ORIGIN}/backend-api/conversations?offset=${offset}&limit=${limit}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`拉取会话失败：HTTP ${resp.status}`);
    const data = await resp.json().catch(() => ({}));
    const items = Array.isArray(data.items) ? data.items : [];
    const hasMore = (typeof data.has_more === 'boolean') ? data.has_more : (items.length === limit);
    return { items, hasMore };
  }

  async function deleteConversation(id) {
    const token = await getAccessToken();
    const url = `${ORIGIN}/backend-api/conversation/${id}`;
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'include',
      body: JSON.stringify({ is_visible: false }),
    });
    if (!resp.ok) throw new Error(`删除失败：HTTP ${resp.status}`);
  }

  function getFilteredConversations() {
    const q = (state.filter || '').trim().toLowerCase();
    if (!q) return state.conversations;
    return state.conversations.filter(c =>
      (c.title || '').toLowerCase().includes(q) || (c.id || '').toLowerCase().includes(q)
    );
  }

  function renderList() {
    const list = document.getElementById('tm-bulkdel-list');
    const meta = document.getElementById('tm-bulkdel-meta');
    if (!list || !meta) return;

    const filtered = getFilteredConversations();
    meta.textContent = `已加载：${state.conversations.length}｜当前显示：${filtered.length}｜已选：${state.selected.size}`;

    list.innerHTML = '';
    for (const c of filtered) {
      const row = document.createElement('div');
      row.className = 'item';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.selected.has(c.id);
      cb.addEventListener('change', () => {
        if (cb.checked) state.selected.add(c.id);
        else state.selected.delete(c.id);
        renderList();
      });

      const t = document.createElement('div');
      t.className = 't';

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = c.title || '(无标题)';

      const cid = document.createElement('div');
      cid.className = 'id';
      cid.textContent = c.id;

      t.append(name, cid);
      row.append(cb, t);
      list.appendChild(row);
    }
  }

  async function loadAll() {
    if (state.loading) return;
    state.loading = true;
    state.cancelLoad = false;
    logLine('开始加载会话…');

    const btnStop = document.getElementById('tm-bulkdel-stop');
    const btnLoad = document.getElementById('tm-bulkdel-load');
    if (btnStop) btnStop.disabled = false;
    if (btnLoad) btnLoad.disabled = true;

    try {
      let offset = state.conversations.length;
      let hasMore = true;

      while (hasMore && !state.cancelLoad) {
        const { items, hasMore: hm } = await fetchConversationsPage(offset, LIMIT_PER_PAGE);
        const normalized = items.map(it => ({
          id: it.id,
          title: it.title,
          update_time: it.update_time,
        })).filter(x => x.id);

        const existing = new Set(state.conversations.map(x => x.id));
        for (const n of normalized) {
          if (!existing.has(n.id)) state.conversations.push(n);
        }

        offset = state.conversations.length;
        hasMore = hm && items.length > 0;

        logLine(`已加载 ${state.conversations.length} 条…`);
        renderList();
        await sleep(200);
      }

      logLine(state.cancelLoad ? '已停止加载。' : '加载完成。');
    } catch (e) {
      logLine(`加载失败：${e.message || e}`);
      alert(`加载失败：${e.message || e}`);
    } finally {
      state.loading = false;
      if (btnStop) btnStop.disabled = true;
      if (btnLoad) btnLoad.disabled = false;
      renderList();
    }
  }

  function selectAllVisible() {
    for (const c of getFilteredConversations()) state.selected.add(c.id);
    renderList();
  }

  function invertVisible() {
    for (const c of getFilteredConversations()) {
      if (state.selected.has(c.id)) state.selected.delete(c.id);
      else state.selected.add(c.id);
    }
    renderList();
  }

  function clearSelectedVisible() {
    for (const c of getFilteredConversations()) state.selected.delete(c.id);
    renderList();
  }

  async function deleteSelected() {
    const ids = Array.from(state.selected);
    if (!ids.length) return alert('还没有勾选任何会话。');

    const ok = confirm(`确认删除选中的 ${ids.length} 条会话？\n\n删除不可撤销。`);
    if (!ok) return;

    logLine(`开始删除 ${ids.length} 条…`);

    const progContainer = document.getElementById('tm-bulkdel-progress-container');
    const progText = document.getElementById('tm-bulkdel-progress-text');
    const progFill = document.getElementById('tm-bulkdel-progress-fill');
    
    if (progContainer) progContainer.style.display = 'flex';
    if (progText) progText.textContent = `0 / ${ids.length}`;
    if (progFill) progFill.style.width = '0%';

    let idx = 0, success = 0, fail = 0;

    async function worker() {
      while (idx < ids.length) {
        const my = ids[idx++];
        try {
          await deleteConversation(my);
          success++;
          state.selected.delete(my);
          state.conversations = state.conversations.filter(x => x.id !== my);
          logLine(`✅ 删除成功：${my}`);
        } catch (e) {
          fail++;
          logLine(`❌ 删除失败：${my}（${e.message || e}）`);
        }
        
        const totalDone = success + fail;
        if (progText) progText.textContent = `${success} / ${ids.length}`;
        if (progFill) progFill.style.width = `${(totalDone / ids.length) * 100}%`;

        renderList();
        await sleep(DELETE_DELAY_MS);
      }
    }

    await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, () => worker()));
    logLine(`完成：成功 ${success}，失败 ${fail}。`);
    setTimeout(() => {
      alert(`删除完成：成功 ${success}，失败 ${fail}。`);
      if (progContainer) progContainer.style.display = 'none';
    }, 300);
  }

  function setOpen(open) {
    state.open = open;

    const overlay = document.getElementById('tm-bulkdel-overlay');
    const panel = document.getElementById('tm-bulkdel-panel');

    if (overlay) overlay.classList.toggle('open', open);
    if (panel) panel.classList.toggle('open', open);

    if (open) {
      setTimeout(() => {
        const q = document.getElementById('tm-bulkdel-q');
        if (q) q.focus();
      }, 60);
    }
  }

  /** =========================
   *  可拖拽 FAB
   *  ========================= */
  function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

  function loadFabPos() {
    try {
      const raw = localStorage.getItem(FAB_POS_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      if (typeof p?.x !== 'number' || typeof p?.y !== 'number') return null;
      return p;
    } catch { return null; }
  }

  function saveFabPos(x, y) {
    try {
      localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x, y }));
    } catch {}
  }

  function applyFabPos(fab, x, y) {
    const w = fab.offsetWidth || 52;
    const h = fab.offsetHeight || 52;
    const pad = 8;

    const maxX = window.innerWidth - w - pad;
    const maxY = window.innerHeight - h - pad;

    const nx = clamp(x, pad, maxX);
    const ny = clamp(y, pad, maxY);

    fab.style.left = `${nx}px`;
    fab.style.top = `${ny}px`;
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';

    saveFabPos(nx, ny);
  }

  function initFabDrag(fab) {
    let pointerId = null;
    let startX = 0, startY = 0;
    let baseX = 0, baseY = 0;
    let moved = false;

    const DRAG_THRESHOLD = 4; // 小于这个视为点击

    fab.addEventListener('pointerdown', (e) => {
      // 左键 / 触控
      if (e.button !== undefined && e.button !== 0) return;

      pointerId = e.pointerId;
      fab.setPointerCapture(pointerId);

      const rect = fab.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      baseX = rect.left;
      baseY = rect.top;
      moved = false;
    });

    fab.addEventListener('pointermove', (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;

      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      if (!moved && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        moved = true;
      }

      if (moved) {
        e.preventDefault();
        applyFabPos(fab, baseX + dx, baseY + dy);
      }
    });

    fab.addEventListener('pointerup', (e) => {
      if (pointerId === null || e.pointerId !== pointerId) return;

      try { fab.releasePointerCapture(pointerId); } catch {}
      const wasMoved = moved;

      pointerId = null;
      moved = false;

      // 没拖动 -> 当作点击开关面板
      if (!wasMoved) {
        setOpen(!state.open);
      }
    });

    fab.addEventListener('pointercancel', () => {
      pointerId = null;
      moved = false;
    });

    // 窗口尺寸变化时，确保按钮还在屏幕内
    window.addEventListener('resize', () => {
      const rect = fab.getBoundingClientRect();
      applyFabPos(fab, rect.left, rect.top);
    }, { passive: true });
  }

  function mountUI() {
    if (document.getElementById('tm-bulkdel-fab')) return;

    const overlay = document.createElement('div');
    overlay.id = 'tm-bulkdel-overlay';
    overlay.addEventListener('click', () => setOpen(false));
    document.body.appendChild(overlay);

    const panel = document.createElement('div');
    panel.id = 'tm-bulkdel-panel';
    panel.innerHTML = `
      <header>
        <div class="title">
          批量删除会话
          <span class="pill">API</span>
        </div>
        <button id="tm-bulkdel-close" title="关闭 (Esc)">✕</button>
      </header>
      <div class="body">
        <div class="row">
          <button class="btn" id="tm-bulkdel-load">加载全部</button>
          <button class="btn" id="tm-bulkdel-stop" disabled>停止加载</button>
          <button class="btn danger" id="tm-bulkdel-del">删除选中</button>
        </div>
        <div class="row">
          <button class="btn" id="tm-bulkdel-all">全选</button>
          <button class="btn" id="tm-bulkdel-inv">反选</button>
          <button class="btn" id="tm-bulkdel-clr">清除</button>
          <input id="tm-bulkdel-q" type="text" placeholder="搜索标题或ID…">
        </div>
        <div class="meta" id="tm-bulkdel-meta">已加载：0｜当前显示：0｜已选：0</div>
        <div class="list" id="tm-bulkdel-list"></div>
        <div class="progress-container" id="tm-bulkdel-progress-container" style="display: none;">
          <div class="progress-track">
            <div class="progress-fill" id="tm-bulkdel-progress-fill"></div>
          </div>
          <div class="progress-text" id="tm-bulkdel-progress-text">0 / 0</div>
        </div>
        <div class="log" id="tm-bulkdel-log"></div>
        <div class="hint">
          打开面板：拖拽或点击右下角按钮。关闭：Esc 或点击遮罩。<br>按钮位置会自动保存。
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const fab = document.createElement('div');
    fab.id = 'tm-bulkdel-fab';
    fab.innerHTML = `<div class="ico">🗑</div><div class="tip">批量删除会话</div>`;
    document.body.appendChild(fab);

    // 应用保存的按钮位置（如有）
    const saved = loadFabPos();
    if (saved) {
      // 等元素有尺寸再定位
      requestAnimationFrame(() => applyFabPos(fab, saved.x, saved.y));
    }

    // 初始化拖拽（拖动时不会触发点击）
    initFabDrag(fab);

    // 面板事件
    document.getElementById('tm-bulkdel-close').onclick = () => setOpen(false);
    document.getElementById('tm-bulkdel-load').onclick = loadAll;
    document.getElementById('tm-bulkdel-stop').onclick = () => { state.cancelLoad = true; };
    document.getElementById('tm-bulkdel-del').onclick = deleteSelected;
    document.getElementById('tm-bulkdel-all').onclick = selectAllVisible;
    document.getElementById('tm-bulkdel-inv').onclick = invertVisible;
    document.getElementById('tm-bulkdel-clr').onclick = clearSelectedVisible;

    document.getElementById('tm-bulkdel-q').addEventListener('input', (e) => {
      state.filter = e.target.value || '';
      renderList();
    });

    // ESC 关闭
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) setOpen(false);
    }, { passive: true });

    renderList();
    logLine('就绪：点击“加载全部”。');
    setOpen(false);
  }

  // 初始化 + SPA 兜底
  function init() { mountUI(); }
  init();

  const mo = new MutationObserver(() => {
    if (!document.getElementById('tm-bulkdel-fab')) mountUI();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

})();
