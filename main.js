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
    :root{
      /* 浅色主题 */
      --tm-bg: rgba(255,255,255,.92);
      --tm-panel: rgba(255,255,255,.96);
      --tm-stroke: rgba(0,0,0,.10);
      --tm-stroke2: rgba(0,0,0,.06);
      --tm-text: rgba(0,0,0,.88);
      --tm-muted: rgba(0,0,0,.62);
      --tm-shadow: 0 18px 50px rgba(0,0,0,.18);

      --tm-radius: 14px;
      --tm-radius2: 12px;

      --tm-btn: rgba(0,0,0,.04);
      --tm-btn-hover: rgba(0,0,0,.07);

      --tm-danger: rgba(185,28,28,.10);
      --tm-danger-stroke: rgba(185,28,28,.35);
      --tm-danger-text: rgba(140,0,0,.85);

      --tm-focus: rgba(59,130,246,.35); /* 蓝色 focus ring */
    }

    /* 方形悬浮按钮（可拖拽） */
    #tm-bulkdel-fab{
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 52px;
      height: 52px;
      border-radius: 12px;
      background: var(--tm-bg);
      color: var(--tm-text);
      border: 1px solid var(--tm-stroke);
      box-shadow: var(--tm-shadow);
      z-index: 999999;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: grab;
      user-select: none;
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      transition: transform .12s ease, background .12s ease, border-color .12s ease;
      font: 14px/1 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      touch-action: none; /* 关键：移动端拖拽不滚屏 */
    }
    #tm-bulkdel-fab:active{ cursor: grabbing; }
    #tm-bulkdel-fab:hover{
      transform: translateY(-1px);
      background: rgba(105,105,105);
      border-color: rgba(0,0,0,.14);
    }
    #tm-bulkdel-fab .ico{ font-size: 18px; line-height: 1; }

    #tm-bulkdel-fab .tip{
      position:absolute;
      right: 62px;
      bottom: 10px;
      padding: 6px 8px;
      background: rgba(255,255,255,.92);
      border: 1px solid rgba(0,0,0,.10);
      border-radius: 10px;
      color: var(--tm-text);
      font-size: 12px;
      white-space: nowrap;
      opacity: 0;
      transform: translateX(6px);
      pointer-events: none;
      transition: opacity .12s ease, transform .12s ease;
      box-shadow: 0 10px 30px rgba(0,0,0,.12);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
    }
    #tm-bulkdel-fab:hover .tip{ opacity: 1; transform: translateX(0px); }

    /* 遮罩 + 弹窗面板 */
    #tm-bulkdel-overlay{
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,.18);
      z-index: 999998;
      display: none;
      backdrop-filter: blur(2px);
      -webkit-backdrop-filter: blur(2px);
    }
    #tm-bulkdel-overlay.open{ display:block; }

    #tm-bulkdel-panel{
      position: fixed;
      right: 16px;
      bottom: 78px;
      width: 420px;
      max-width: calc(100vw - 32px);
      height: 620px;
      max-height: calc(100vh - 110px);
      z-index: 999999;
      display: none;
      background: var(--tm-panel);
      color: var(--tm-text);
      border: 1px solid var(--tm-stroke);
      border-radius: var(--tm-radius);
      box-shadow: var(--tm-shadow);
      overflow: hidden;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font: 13px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial;
      transform: translateY(8px);
      opacity: 0;
      transition: transform .14s ease, opacity .14s ease;
    }
    #tm-bulkdel-panel.open{
      display:block;
      transform: translateY(0);
      opacity: 1;
    }

    #tm-bulkdel-panel header{
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding: 10px 12px;
      border-bottom: 1px solid var(--tm-stroke2);
      background: rgba(255,255,255,.70);
    }
    #tm-bulkdel-panel header .title{
      display:flex; gap:8px; align-items:center;
      font-weight: 700;
      letter-spacing: .2px;
    }
    #tm-bulkdel-panel header .title .pill{
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--tm-stroke);
      color: var(--tm-muted);
      font-weight: 700;
      background: rgba(0,0,0,.03);
    }
    #tm-bulkdel-panel header button{
      background: rgba(0,0,0,.04);
      color: var(--tm-text);
      border: 1px solid var(--tm-stroke);
      border-radius: 10px;
      padding: 6px 8px;
      cursor: pointer;
    }
    #tm-bulkdel-panel header button:hover{
      background: rgba(0,0,0,.06);
      border-color: rgba(0,0,0,.14);
    }

    #tm-bulkdel-panel .body{
      padding: 10px 12px;
      display:flex;
      flex-direction: column;
      gap: 10px;
      height: calc(100% - 52px);
      box-sizing: border-box;
    }

    #tm-bulkdel-panel .row{
      display:flex; gap:8px; flex-wrap:wrap;
    }

    #tm-bulkdel-panel .btn{
      background: var(--tm-btn);
      color: var(--tm-text);
      border: 1px solid var(--tm-stroke);
      border-radius: var(--tm-radius2);
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      transition: background .12s ease, border-color .12s ease, transform .06s ease;
    }
    #tm-bulkdel-panel .btn:hover{
      background: var(--tm-btn-hover);
      border-color: rgba(0,0,0,.14);
    }
    #tm-bulkdel-panel .btn:active{ transform: scale(.99); }
    #tm-bulkdel-panel .btn:disabled{ opacity:.45; cursor:not-allowed; }

    #tm-bulkdel-panel .btn.danger{
      background: var(--tm-danger);
      border-color: var(--tm-danger-stroke);
      color: var(--tm-danger-text);
      font-weight: 650;
    }

    #tm-bulkdel-panel input[type="text"]{
      flex:1;
      min-width: 160px;
      background: rgba(255,255,255,.90);
      border: 1px solid var(--tm-stroke);
      color: var(--tm-text);
      border-radius: var(--tm-radius2);
      padding: 8px 10px;
      outline: none;
    }
    #tm-bulkdel-panel input[type="text"]::placeholder{ color: rgba(0,0,0,.40); }
    #tm-bulkdel-panel input[type="text"]:focus{
      border-color: rgba(59,130,246,.40);
      box-shadow: 0 0 0 4px var(--tm-focus);
    }

    #tm-bulkdel-panel .meta{
      font-size: 12px;
      color: var(--tm-muted);
      margin-top: -4px;
    }

    #tm-bulkdel-panel .list{
      flex: 1;
      overflow: auto;
      border: 1px solid var(--tm-stroke2);
      border-radius: var(--tm-radius);
      background: rgba(255,255,255,.70);
    }
    #tm-bulkdel-panel .item{
      display:flex;
      gap: 10px;
      padding: 10px 10px;
      border-bottom: 1px solid var(--tm-stroke2);
      align-items: flex-start;
    }
    #tm-bulkdel-panel .item:hover{
      background: rgba(0,0,0,.02);
    }
    #tm-bulkdel-panel .item:last-child{ border-bottom: none; }
    #tm-bulkdel-panel .item input{ margin-top: 2px; }
    #tm-bulkdel-panel .item .t{ flex:1; }
    #tm-bulkdel-panel .item .name{
      font-weight: 700;
      margin-bottom: 2px;
      word-break: break-word;
    }
    #tm-bulkdel-panel .item .id{
      font-size: 11px;
      color: rgba(0,0,0,.55);
      word-break: break-all;
    }

    #tm-bulkdel-panel .log{
      max-height: 92px;
      overflow: auto;
      border: 1px dashed var(--tm-stroke2);
      border-radius: var(--tm-radius2);
      padding: 8px 10px;
      color: rgba(0,0,0,.70);
      font-size: 12px;
      background: rgba(0,0,0,.02);
    }
    #tm-bulkdel-panel .log div{ margin: 2px 0; }

    #tm-bulkdel-panel .hint{
      font-size: 12px;
      color: rgba(0,0,0,.55);
      line-height: 1.35;
    }
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
        renderList();
        await sleep(DELETE_DELAY_MS);
      }
    }

    await Promise.all(Array.from({ length: DELETE_CONCURRENCY }, () => worker()));
    logLine(`完成：成功 ${success}，失败 ${fail}。`);
    alert(`删除完成：成功 ${success}，失败 ${fail}。`);
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
          <button class="btn" id="tm-bulkdel-all">全选(当前)</button>
          <button class="btn" id="tm-bulkdel-inv">反选(当前)</button>
          <button class="btn" id="tm-bulkdel-clr">清除(当前)</button>
          <input id="tm-bulkdel-q" type="text" placeholder="搜索标题或ID…">
        </div>
        <div class="meta" id="tm-bulkdel-meta">已加载：0｜当前显示：0｜已选：0</div>
        <div class="list" id="tm-bulkdel-list"></div>
        <div class="log" id="tm-bulkdel-log"></div>
        <div class="hint">
          打开面板：拖拽/点击右下角按钮。<br>
          关闭：右上角 ✕ / 按 Esc / 点遮罩。<br>
          提示：按钮位置会自动保存。
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
