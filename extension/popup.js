// VideoGrab Pro - popup.js v2.1
// 修复：双语切换 / 删除记录黑名单 / 打开文件夹 / 自动填入当前页链接

'use strict';

// ═══════════════════════════════════════════════════════════════════
// i18n — 运行时读取本地 JSON，支持中/英切换
// ═══════════════════════════════════════════════════════════════════
const I18N = { zh: {}, en: {} };
let   LANG = 'zh';   // 默认中文

async function loadI18n() {
  try {
    const [zh, en] = await Promise.all([
      fetch(chrome.runtime.getURL('_locales/zh_CN/messages.json')).then(r => r.json()),
      fetch(chrome.runtime.getURL('_locales/en/messages.json')).then(r => r.json()),
    ]);
    for (const [k, v] of Object.entries(zh)) I18N.zh[k] = v.message;
    for (const [k, v] of Object.entries(en)) I18N.en[k] = v.message;
  } catch (e) {
    console.error('i18n load failed', e);
  }
}

function t(key, fallback) {
  return I18N[LANG]?.[key] || I18N.zh[key] || fallback || key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = t(el.dataset.i18n);
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const msg = t(el.dataset.i18nPh);
    if (msg) el.placeholder = msg;
  });
  // 语言切换按钮显示"切换到另一语言"
  const langBtn = $('btn-lang');
  if (langBtn) langBtn.textContent = LANG === 'zh' ? 'EN' : '中文';
}

async function toggleLang() {
  LANG = LANG === 'zh' ? 'en' : 'zh';
  await chrome.storage.local.set({ vg_lang: LANG });
  applyI18n();
}

// ═══════════════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════════════
const store = {
  tasks:          {},           // id -> task  (server 唯一数据源)
  deletedIds:     new Set(),    // ★ 内存黑名单：popup 周期内有效，防止 SSE 重现
  selectedIds:    new Set(),
  selectMode:     false,
  taskFilter:     'all',
  detectedVideos: [],
  playlistItems:  [],
  selectedPl:     new Set(),
  selectedQuality:'best',
  selectedFormat: null,
  removeWatermark:true,
  embedSubs:      false,
  analyzeResult:  null,
  pageUrl:        '',           // 当前标签页 URL（供 Download tab 自动填入）
};

// ═══════════════════════════════════════════════════════════════════
// 进度平滑 RAF
// ═══════════════════════════════════════════════════════════════════
const progressTargets = {};
let   rafPending      = false;

function scheduleProgressRaf() {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(tickProgress);
}

function tickProgress() {
  rafPending = false;
  let hasPending = false;
  for (const [tid, target] of Object.entries(progressTargets)) {
    const fill = document.querySelector(`.task-item[data-tid="${tid}"] .progress-fill`);
    if (!fill) { delete progressTargets[tid]; continue; }
    const current = parseFloat(fill.style.width) || 0;
    const diff    = target - current;
    if (Math.abs(diff) < 0.3) {
      fill.style.width = target + '%';
      delete progressTargets[tid];
    } else {
      fill.style.width = (current + diff * 0.25) + '%';
      hasPending = true;
    }
  }
  if (hasPending) scheduleProgressRaf();
}

// ═══════════════════════════════════════════════════════════════════
// 速度移动平均
// ═══════════════════════════════════════════════════════════════════
const speedHistory = {};
const SPEED_WIN    = 5;

function smoothSpeed(tid, rawSpeed) {
  if (!rawSpeed) return '';
  const nums = rawSpeed.match(/([\d.]+)\s*(\w+\/s)/);
  if (!nums) return rawSpeed;
  const val  = parseFloat(nums[1]);
  const unit = nums[2];
  if (!speedHistory[tid]) speedHistory[tid] = [];
  const hist = speedHistory[tid];
  hist.push(val);
  if (hist.length > SPEED_WIN) hist.shift();
  const avg = hist.reduce((a, b) => a + b, 0) / hist.length;
  return avg.toFixed(1) + unit;
}

// ═══════════════════════════════════════════════════════════════════
// SSE
// ═══════════════════════════════════════════════════════════════════
let sseSource     = null;
let sseRetryTimer = null;
let ssePort       = 7788;

function connectSSE(port) {
  ssePort = port;
  if (sseSource) { sseSource.close(); sseSource = null; }
  if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }

  const es = new EventSource(`http://127.0.0.1:${port}/events`);
  sseSource = es;

  const dot = $('sse-dot');
  es.onopen = () => { if (dot) dot.classList.add('live'); };

  es.onmessage = ev => {
    try {
      const data = JSON.parse(ev.data);
      if (!data || !data.id) return;

      // ★ 服务端广播的删除事件
      if (data.__deleted__) {
        store.deletedIds.add(data.id);
        delete store.tasks[data.id];
        document.querySelector(`.task-item[data-tid="${data.id}"]`)?.remove();
        updateEmptyState();
        updateTaskBadge();
        return;
      }

      // ★ 黑名单过滤（前端删除后 SSE 快照重推的情况）
      if (store.deletedIds.has(data.id)) return;

      applyTaskUpdate(data);
    } catch {}
  };

  es.onerror = () => {
    if (dot) dot.classList.remove('live');
    es.close();
    sseSource   = null;
    sseRetryTimer = setTimeout(() => connectSSE(ssePort), 3000);
  };
}

window.addEventListener('unload', () => {
  if (sseSource)     sseSource.close();
  if (sseRetryTimer) clearTimeout(sseRetryTimer);
});

// ═══════════════════════════════════════════════════════════════════
// 任务更新（事件驱动，增量 patch）
// ═══════════════════════════════════════════════════════════════════
function applyTaskUpdate(task) {
  if (store.deletedIds.has(task.id)) return;   // 黑名单再次拦截

  const prev = store.tasks[task.id];
  store.tasks[task.id] = task;
  updateTaskBadge();

  if (task.status === 'completed' || task.status === 'error' || task.status === 'cancelled') {
    delete speedHistory[task.id];
    delete progressTargets[task.id];
  }

  if (!isTaskVisible(task)) {
    const el = document.querySelector(`.task-item[data-tid="${task.id}"]`);
    if (el) el.remove();
    updateEmptyState();
    return;
  }

  const existing = document.querySelector(`.task-item[data-tid="${task.id}"]`);
  if (!existing) {
    const list    = $('task-list');
    const emptyEl = $('empty-tasks');
    if (emptyEl) emptyEl.style.display = 'none';
    const el = buildTaskEl(task);
    list.insertBefore(el, list.firstChild);
    return;
  }
  patchTaskEl(existing, task, prev);
}

function isTaskVisible(task) {
  switch (store.taskFilter) {
    case 'active':    return task.status === 'downloading' || task.status === 'pending';
    case 'completed': return task.status === 'completed';
    case 'error':     return task.status === 'error' || task.status === 'cancelled';
    default:          return true;
  }
}

function patchTaskEl(el, task) {
  const pct     = Math.min(100, task.progress || 0);
  const isActive= task.status === 'downloading' || task.status === 'pending';
  const fillCls = task.status === 'completed' ? 'completed' : task.status === 'error' ? 'error' : '';

  const fill = el.querySelector('.progress-fill');
  if (fill) {
    fill.className = 'progress-fill' + (fillCls ? ' ' + fillCls : '');
    progressTargets[task.id] = pct;
    scheduleProgressRaf();
  }
  const pctEl = el.querySelector('.progress-pct');
  if (pctEl) {
    pctEl.textContent = pctLabel(task);
    pctEl.className   = 'progress-pct' + (fillCls ? ' ' + fillCls : '');
  }
  const spdEl = el.querySelector('.progress-speed');
  if (spdEl) spdEl.textContent = smoothSpeed(task.id, task.speed || '');

  const etaEl = el.querySelector('.progress-eta');
  if (etaEl) etaEl.textContent = task.eta ? task.eta + ' ' + t('remaining', '剩余') : '';

  const stEl = el.querySelector('.task-status');
  if (stEl) { stEl.textContent = statusLabel(task.status); stEl.className = 'task-status ' + (task.status || 'pending'); }

  const cancelBtn = el.querySelector('.task-cancel-btn');
  const openBtn   = el.querySelector('.task-open-btn');
  const deleteBtn = el.querySelector('.task-delete-btn');
  if (cancelBtn) cancelBtn.style.display = isActive ? '' : 'none';
  if (openBtn)   openBtn.style.display   = task.status === 'completed' ? '' : 'none';
  if (deleteBtn) deleteBtn.style.display = isActive ? 'none' : '';

  const metaEl = el.querySelector('.task-meta-info');
  if (metaEl) metaEl.textContent = task.status === 'error' ? (task.error || 'Error') : fmtTime(task.completed_at || task.created_at);

  const titleEl = el.querySelector('.task-title');
  if (titleEl && task.title) titleEl.textContent = task.title;
}

// ═══════════════════════════════════════════════════════════════════
// 构建任务 DOM
// ═══════════════════════════════════════════════════════════════════
function buildTaskEl(task) {
  const isActive= task.status === 'downloading' || task.status === 'pending';
  const pct     = Math.min(100, task.progress || 0);
  const fillCls = task.status === 'completed' ? 'completed' : task.status === 'error' ? 'error' : '';
  const chk     = store.selectedIds.has(task.id);

  const div = document.createElement('div');
  div.className = 'task-item' + (store.selectMode ? ' select-mode' : '') + (chk ? ' selected' : '');
  div.dataset.tid = task.id;

  div.innerHTML = `
    <div class="task-check"></div>
    <div class="task-header">
      <div class="task-title" title="${esc(task.url || '')}">${esc(task.title || task.url || 'Unknown')}</div>
      <div class="task-status ${task.status || 'pending'}">${statusLabel(task.status)}</div>
    </div>
    <div class="progress-track">
      <div class="progress-fill${fillCls ? ' ' + fillCls : ''}" style="width:${pct}%"></div>
    </div>
    <div class="progress-info">
      <span class="progress-pct${fillCls ? ' ' + fillCls : ''}">${pctLabel(task)}</span>
      <span class="progress-speed">${smoothSpeed(task.id, task.speed || '')}</span>
      <span class="progress-eta">${task.eta ? task.eta + ' ' + t('remaining', '剩余') : ''}</span>
    </div>
    <div class="task-meta">
      <span class="task-meta-info">${task.status === 'error' ? esc(task.error || 'Error') : fmtTime(task.completed_at || task.created_at)}</span>
      <button class="task-action-btn task-cancel-btn" style="${isActive ? '' : 'display:none'}">${t('cancelBtn', '取消')}</button>
      <button class="task-action-btn task-open-btn" style="${task.status === 'completed' ? '' : 'display:none'}">📂</button>
      <button class="task-action-btn task-delete-btn" style="${isActive ? 'display:none' : ''}">🗑</button>
    </div>`;
  return div;
}

// ═══════════════════════════════════════════════════════════════════
// 完整重建任务列表
// ═══════════════════════════════════════════════════════════════════
function renderTaskList() {
  const list    = $('task-list');
  const emptyEl = $('empty-tasks');
  const ft      = filteredTasks();
  updateTaskBadge();
  list.querySelectorAll('.task-item').forEach(el => el.remove());
  if (!ft.length) {
    if (emptyEl) emptyEl.style.display = 'block';
    updateBatchBar();
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  ft.forEach(task => {
    const el = buildTaskEl(task);
    list.appendChild(el);
    progressTargets[task.id] = Math.min(100, task.progress || 0);
  });
  scheduleProgressRaf();
  updateBatchBar();
}

function updateEmptyState() {
  const list    = $('task-list');
  const emptyEl = $('empty-tasks');
  if (emptyEl) emptyEl.style.display = list.querySelectorAll('.task-item').length ? 'none' : 'block';
}

function filteredTasks() {
  const all = Object.values(store.tasks)
    .filter(t => !store.deletedIds.has(t.id))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  switch (store.taskFilter) {
    case 'active':    return all.filter(t => t.status === 'downloading' || t.status === 'pending');
    case 'completed': return all.filter(t => t.status === 'completed');
    case 'error':     return all.filter(t => t.status === 'error' || t.status === 'cancelled');
    default:          return all;
  }
}

function updateTaskBadge() {
  const active = Object.values(store.tasks)
    .filter(t => !store.deletedIds.has(t.id) && (t.status === 'downloading' || t.status === 'pending')).length;
  setBadge('task-count', active);
}

// ═══════════════════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════════════════
let currentTab = null;

async function init() {
  try {
    // 1. 加载语言包 + 读取持久化语言设置
    await loadI18n();
    const stored = await chrome.storage.local.get(['vg_lang']).catch(() => ({}));
    LANG = stored.vg_lang || 'zh';
    applyI18n();

    // 2. 获取当前标签页
    [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    store.pageUrl = currentTab?.url || '';
    try { $('current-site').textContent = new URL(store.pageUrl).hostname; } catch {}

    // 3. 读取用户设置
    const settings = await chrome.storage.local.get(null).catch(() => ({}));
    store.removeWatermark = settings.removeWatermark !== false;
    store.embedSubs       = !!settings.embedSubs;
    applyToggles();

    // 4. 绑定事件
    setupTabSwitching();
    setupEventDelegation();
    setupStaticListeners();

    // 5. 自动填入当前页 URL 到 Download tab
    if (store.pageUrl) {
      const urlInput = $('url-input');
      if (urlInput && !urlInput.value) {
        urlInput.value = store.pageUrl;
      }
      $('playlist-url-input').value = store.pageUrl;
    }

    // 6. 检查服务器 + 连接 SSE
    await checkServer();

    // 7. 扫描当前页视频
    scanVideos();

  } catch (e) {
    console.error('init error', e);
  }
}

// ═══════════════════════════════════════════════════════════════════
// 服务器检查 + SSE 连接
// ═══════════════════════════════════════════════════════════════════
async function checkServer() {
  const dot = $('status-dot'), txt = $('status-text'), lnk = $('install-link');
  if (dot) dot.className = 'status-dot checking';
  if (txt) txt.textContent = t('statusChecking', '正在连接服务...');
  try {
    const r = await chrome.runtime.sendMessage({ action: 'check-server' });
    if (r?.running) {
      if (dot) dot.className = 'status-dot running';
      if (txt) txt.textContent = t('statusRunning', '本地服务运行中') + ' · yt-dlp ' + (r.ytdlp_version || '');
      if (lnk) lnk.style.display = 'none';

      const port = r.port || 7788;
      connectSSE(port);

      // 拉取初始任务列表
      try {
        const data = await fetch(`http://127.0.0.1:${port}/api/tasks`).then(r => r.json());
        (data.tasks || []).forEach(task => {
          if (!store.deletedIds.has(task.id)) {
            store.tasks[task.id] = task;
          }
        });
        renderTaskList();
      } catch {}
      return true;
    }
  } catch {}
  if (dot) dot.className = 'status-dot';
  if (txt) txt.textContent = t('statusStopped', '⚠️ 服务未启动');
  if (lnk) lnk.style.display = 'block';
  return false;
}

// ═══════════════════════════════════════════════════════════════════
// 标签页切换
// ═══════════════════════════════════════════════════════════════════
function setupTabSwitching() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const id = tab.dataset.tab;
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const panel = $('panel-' + id);
      if (panel) panel.classList.add('active');

      // ★ 切到 Download tab 时，如果输入框为空则自动填入当前页 URL
      if (id === 'download') {
        const urlInput = $('url-input');
        if (urlInput && !urlInput.value && store.pageUrl) {
          urlInput.value = store.pageUrl;
        }
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// 静态按钮
// ═══════════════════════════════════════════════════════════════════
function setupStaticListeners() {
  // Header
  $('btn-refresh')?.addEventListener('click', async () => {
    await checkServer();
    scanVideos();
  });
  $('btn-settings')?.addEventListener('click', () => chrome.runtime.openOptionsPage?.());
  $('btn-lang')?.addEventListener('click', toggleLang);

  // Detect tab
  $('btn-dl-all')?.addEventListener('click', dlAll);
  $('btn-rescan')?.addEventListener('click', scanVideos);

  // Download tab
  $('btn-analyze')?.addEventListener('click', analyzeUrl);
  $('btn-dl-url')?.addEventListener('click', dlFromInput);
  $('btn-dl-page')?.addEventListener('click', dlCurrentPage);

  document.querySelectorAll('.q-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.q-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.selectedQuality = btn.dataset.q;
      store.selectedFormat  = null;
      $('format-selector')?.classList.remove('visible');
    });
  });

  $('toggle-watermark')?.addEventListener('click', function () {
    store.removeWatermark = !store.removeWatermark;
    this.classList.toggle('on', store.removeWatermark);
    chrome.storage.local.set({ removeWatermark: store.removeWatermark });
  });
  $('toggle-subs')?.addEventListener('click', function () {
    store.embedSubs = !store.embedSubs;
    this.classList.toggle('on', store.embedSubs);
  });

  // Tasks toolbar
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      store.taskFilter = btn.dataset.filter;
      renderTaskList();
    });
  });
  $('btn-select-tasks')?.addEventListener('click', () => store.selectMode ? exitSelectMode() : enterSelectMode());
  $('btn-clear-history')?.addEventListener('click', clearHistory);
  $('btn-select-all')?.addEventListener('click', selectAll);
  $('btn-batch-delete')?.addEventListener('click', deleteSelected);
  $('btn-exit-select')?.addEventListener('click', exitSelectMode);

  // Dialog
  $('dialog-confirm-btn')?.addEventListener('click', () => { if (_confirmCb) _confirmCb(); hideConfirm(); });
  $('dialog-cancel-btn')?.addEventListener('click', hideConfirm);

  // Playlist
  $('btn-analyze-pl')?.addEventListener('click', analyzePl);
  $('btn-dl-playlist')?.addEventListener('click', dlPlaylist);
  $('pl-select-all')?.addEventListener('click', () => {
    const all = store.playlistItems.every(v => store.selectedPl.has(v.url));
    if (all) {
      store.selectedPl.clear();
      document.querySelectorAll('.pl-item').forEach(el => el.classList.remove('selected'));
    } else {
      store.playlistItems.forEach(v => store.selectedPl.add(v.url));
      document.querySelectorAll('.pl-item').forEach(el => el.classList.add('selected'));
    }
  });
}

// ═══════════════════════════════════════════════════════════════════
// 事件委托（任务列表）
// ═══════════════════════════════════════════════════════════════════
function setupEventDelegation() {
  const list = $('task-list');
  list.addEventListener('click', async e => {
    const item = e.target.closest('.task-item');
    if (!item) return;
    const tid = item.dataset.tid;

    if (e.target.closest('.task-cancel-btn')) {
      e.stopPropagation();
      await cancelTask(tid);
      return;
    }
    if (e.target.closest('.task-open-btn')) {
      e.stopPropagation();
      await openTaskFolder(tid);
      return;
    }
    if (e.target.closest('.task-delete-btn')) {
      e.stopPropagation();
      await deleteTask(tid);
      return;
    }
    if (store.selectMode) toggleSelect(tid, item);
  });
}

// ★ 打开文件夹（问题3修复）
async function openTaskFolder(tid) {
  try {
    const port = await getPort();
    const r = await fetch(`http://127.0.0.1:${port}/api/open/${tid}`, {
      method: 'POST', signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    if (!data.success) {
      notify(t('openFolderFailed', '⚠️ 打开文件夹失败') + (data.error ? ': ' + data.error : ''));
    }
  } catch (e) {
    notify(t('openFolderFailed', '⚠️ 打开文件夹失败'));
    console.error('openTaskFolder', e);
  }
}

// ★ 删除任务（问题2修复：先加本地黑名单，再请求服务器删除）
async function deleteTask(tid) {
  // 立即加入本地黑名单，防止 SSE 重现
  store.deletedIds.add(tid);
  delete store.tasks[tid];
  delete speedHistory[tid];
  delete progressTargets[tid];
  document.querySelector(`.task-item[data-tid="${tid}"]`)?.remove();
  updateEmptyState();
  updateTaskBadge();
  // 异步通知服务器
  try {
    const port = await getPort();
    await fetch(`http://127.0.0.1:${port}/api/delete/${tid}`, {
      method: 'POST', signal: AbortSignal.timeout(5000)
    });
  } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// 多选
// ═══════════════════════════════════════════════════════════════════
function enterSelectMode() {
  store.selectMode = true;
  store.selectedIds.clear();
  $('btn-select-tasks')?.classList.add('active');
  document.querySelectorAll('.task-item').forEach(el => el.classList.add('select-mode'));
  updateBatchBar();
}

function exitSelectMode() {
  store.selectMode = false;
  store.selectedIds.clear();
  $('btn-select-tasks')?.classList.remove('active');
  document.querySelectorAll('.task-item').forEach(el => el.classList.remove('select-mode', 'selected'));
  updateBatchBar();
}

function toggleSelect(tid, itemEl) {
  const el = document.querySelector(`.task-item[data-tid="${tid}"]`) || itemEl;
  if (store.selectedIds.has(tid)) {
    store.selectedIds.delete(tid);
    el.classList.remove('selected');
  } else {
    store.selectedIds.add(tid);
    el.classList.add('selected');
  }
  updateBatchBar();
}

function selectAll() {
  filteredTasks().forEach(t => store.selectedIds.add(t.id));
  document.querySelectorAll('.task-item').forEach(el => el.classList.add('selected'));
  updateBatchBar();
}

function updateBatchBar() {
  const bar = $('batch-bar');
  if (!bar) return;
  if (store.selectMode) {
    bar.classList.add('visible');
    $('batch-count-text').textContent = `${store.selectedIds.size} ` + (LANG === 'zh' ? '条已选' : 'selected');
  } else {
    bar.classList.remove('visible');
  }
}

// ═══════════════════════════════════════════════════════════════════
// 取消 / 删除
// ═══════════════════════════════════════════════════════════════════
async function cancelTask(tid) {
  try {
    const port = await getPort();
    await fetch(`http://127.0.0.1:${port}/api/cancel/${tid}`, {
      method: 'POST', signal: AbortSignal.timeout(5000)
    });
  } catch {}
}

async function deleteSelected() {
  if (!store.selectedIds.size) { notify(t('noSelection', '请先勾选记录')); return; }
  const count = store.selectedIds.size;
  confirm2('🗑', t('deleteConfirmTitle', `删除 ${count} 条记录`),
    t('deleteConfirmDesc', '仅清除列表记录，视频文件不受影响。'), async () => {
      const ids = [...store.selectedIds];
      for (const id of ids) await deleteTask(id);
      exitSelectMode();
      notify(t('deleted', '✅ 已删除') + ` ${count}`);
    });
}

function clearHistory() {
  const toDelete = Object.values(store.tasks).filter(
    t => !store.deletedIds.has(t.id) && t.status !== 'downloading' && t.status !== 'pending'
  );
  if (!toDelete.length) { notify(t('nothingToClear', '没有可清除的记录')); return; }
  confirm2('🗑', t('clearConfirmTitle', '清除全部历史'),
    t('clearConfirmDesc', `将清除 ${toDelete.length} 条记录`), async () => {
      for (const task of toDelete) await deleteTask(task.id);
      notify(t('cleared', '✅ 已清除') + ` ${toDelete.length}`);
    });
}

// ═══════════════════════════════════════════════════════════════════
// ★ 页面视频扫描（问题4修复）
// ═══════════════════════════════════════════════════════════════════
async function scanVideos() {
  const listEl  = $('video-list');
  const emptyEl = $('empty-detect');
  const scanEl  = $('scanning-indicator');
  const optsEl  = $('detect-options');

  if (scanEl) scanEl.style.display = 'flex';
  if (listEl) listEl.innerHTML = '';
  if (emptyEl) emptyEl.style.display = 'none';
  if (optsEl)  optsEl.classList.remove('visible');

  // 获取拦截到的视频
  let intercepted = [];
  try {
    const r = await chrome.runtime.sendMessage({ action: 'get-intercepted-videos', tabId: currentTab.id });
    intercepted = r?.videos || [];
  } catch {}

  // 获取 DOM 扫描结果 + 平台信息
  let domVids = [], platformInfo = null;
  try {
    const r = await chrome.tabs.sendMessage(currentTab.id, { action: 'scan-videos' });
    domVids      = r?.videos || [];
    platformInfo = r?.platformInfo;
  } catch {}

  // 合并去重
  const map = new Map();
  [...intercepted, ...domVids].forEach(v => { if (v.url && !map.has(v.url)) map.set(v.url, v); });
  store.detectedVideos = [...map.values()];

  if (scanEl) scanEl.style.display = 'none';

  if (store.detectedVideos.length || platformInfo) {
    if (optsEl) optsEl.classList.add('visible');
    renderVideoList(store.detectedVideos, listEl, platformInfo);
    setBadge('detect-count', store.detectedVideos.length);

    // ★ 如果识别到平台页面，自动将当前页 URL 填入 Download tab
    if (platformInfo) {
      const urlInput = $('url-input');
      if (urlInput && !urlInput.value) {
        urlInput.value = platformInfo.pageUrl || store.pageUrl;
      }
    }
  } else {
    if (emptyEl) emptyEl.style.display = 'block';
    setBadge('detect-count', 0);
    // ★ 无检测结果时也填入当前页 URL（用户可手动触发下载）
    const urlInput = $('url-input');
    if (urlInput && !urlInput.value && store.pageUrl) {
      urlInput.value = store.pageUrl;
    }
  }
}

function renderVideoList(videos, container, pInfo) {
  if (!container) return;
  container.innerHTML = '';

  if (pInfo?.platform) {
    const card = document.createElement('div');
    card.className = 'video-item';
    card.innerHTML = `
      <div class="video-header">
        <div class="video-thumb" style="background:rgba(0,212,255,0.1);font-size:20px">${platformEmoji(pInfo.platform)}</div>
        <div class="video-info">
          <div class="video-title">${esc(pInfo.title || t('currentPage', '当前页面'))}</div>
          <div class="video-meta">
            <span class="meta-tag platform">${esc(pInfo.platform)}</span>
            <span class="meta-tag">${pInfo.isPlaylist ? t('tabPlaylist', '播放列表') : t('singleVideo', '单个视频')}</span>
          </div>
        </div>
      </div>
      <div class="video-actions">
        <button class="dl-btn primary" id="smart-dl-btn">${t('smartDownload', '⬇ 智能下载')}</button>
        ${pInfo.isPlaylist ? `<button class="dl-btn" id="pl-switch-btn">${t('batchDownload', '📋 批量')}</button>` : ''}
        <button class="dl-btn" id="show-fmt-btn">${t('formats', '🎯 选格式')}</button>
      </div>`;
    container.appendChild(card);
    $('smart-dl-btn')?.addEventListener('click', dlCurrentPage);
    $('pl-switch-btn')?.addEventListener('click', () => {
      document.querySelector('.tab[data-tab="playlist"]')?.click();
      $('playlist-url-input').value = pInfo.pageUrl;
    });
    $('show-fmt-btn')?.addEventListener('click', () => showFormats(pInfo.pageUrl));
  }

  videos.forEach((v, i) => {
    const div = document.createElement('div');
    div.className = 'video-item';
    div.innerHTML = `
      <div class="video-header">
        <div class="video-thumb">${v.poster ? `<img src="${esc(v.poster)}" onerror="this.style.display='none'">` : '🎬'}</div>
        <div class="video-info">
          <div class="video-title" title="${esc(v.url)}">${esc(v.title || ('Stream ' + (i + 1)))}</div>
          <div class="video-meta">
            <span class="meta-tag">${v.type || 'Stream'}</span>
            ${v.quality && v.quality !== 'unknown' ? `<span class="meta-tag quality">${v.quality}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="video-actions">
        <button class="dl-btn primary" data-si="${i}">${t('downloadBtn', '⬇ 下载')}</button>
        <button class="dl-btn" data-ci="${i}">${t('copyBtn', '📋 复制')}</button>
      </div>`;
    container.appendChild(div);
  });

  container.querySelectorAll('[data-si]').forEach(b =>
    b.addEventListener('click', () => dlStream(+b.dataset.si)));
  container.querySelectorAll('[data-ci]').forEach(b =>
    b.addEventListener('click', () => {
      navigator.clipboard.writeText(store.detectedVideos[+b.dataset.ci]?.url || '');
      notify(t('copied', '✅ 已复制'));
    }));
}

function platformEmoji(p) {
  const map = { YouTube:'▶️', TikTok:'🎵', Douyin:'🎵', Instagram:'📸', Bilibili:'📺',
    'Twitter/X':'🐦', Facebook:'👤', Vimeo:'🎞️', Reddit:'🤖', Twitch:'🎮', XiGua:'📹' };
  return map[p] || '🌐';
}

// ═══════════════════════════════════════════════════════════════════
// 下载
// ═══════════════════════════════════════════════════════════════════
const QUALITY_FMTS = {
  best:   'bestvideo+bestaudio/best',
  '4k':   'bestvideo[height<=2160]+bestaudio/best',
  '1080p':'bestvideo[height<=1080]+bestaudio/best',
  '720p': 'bestvideo[height<=720]+bestaudio/best',
  '480p': 'bestvideo[height<=480]+bestaudio/best',
  audio:  'bestaudio/best',
};

async function getPort() {
  const s = await chrome.storage.local.get(['serverPort']).catch(() => ({}));
  return s.serverPort || 7788;
}

async function getCookies() {
  try { return await chrome.runtime.sendMessage({ action: 'get-all-cookies', tabId: currentTab.id }); }
  catch { return null; }
}

async function ensureServer() {
  const r = await chrome.runtime.sendMessage({ action: 'check-server' });
  if (r?.running) return true;
  notify(t('serverRequired', '⚠️ 请先启动本地服务'));
  return false;
}

async function startDownloadAndSwitch(params) {
  const r = await chrome.runtime.sendMessage({ action: 'start-download', ...params });
  if (r?.task_id) {
    notify(t('downloadStarted', '✅ 已加入下载队列'));
    document.querySelector('.tab[data-tab="tasks"]')?.click();
  } else {
    notify(t('downloadFailed', '❌ 下载失败') + (r?.error ? ': ' + r.error : ''));
  }
  return r;
}

async function dlCurrentPage() {
  if (!await ensureServer()) return;
  await startDownloadAndSwitch({
    url:             store.pageUrl,
    formatId:        store.selectedFormat || QUALITY_FMTS[store.selectedQuality] || QUALITY_FMTS.best,
    cookies:         await getCookies(),
    removeWatermark: store.removeWatermark,
    embedSubs:       store.embedSubs,
    title:           currentTab?.title || store.pageUrl,
  });
}

async function dlStream(idx) {
  if (!await ensureServer()) return;
  const v = store.detectedVideos[idx];
  if (!v) return;
  await startDownloadAndSwitch({
    url:             v.url,
    formatId:        'best',
    cookies:         await getCookies(),
    removeWatermark: store.removeWatermark,
    title:           v.title || currentTab?.title || 'video',
    referer:         store.pageUrl,
  });
}

async function dlFromInput() {
  if (!await ensureServer()) return;
  const url = $('url-input')?.value.trim();
  if (!url) { notify(t('noUrl', '⚠️ 请先输入视频链接')); return; }
  await startDownloadAndSwitch({
    url,
    formatId:        store.selectedFormat || QUALITY_FMTS[store.selectedQuality] || QUALITY_FMTS.best,
    cookies:         await getCookies(),
    removeWatermark: store.removeWatermark,
    embedSubs:       store.embedSubs,
    title:           store.analyzeResult?.title || url,
  });
}

async function dlAll() {
  if (!await ensureServer()) return;
  if (!store.detectedVideos.length) { await dlCurrentPage(); return; }
  const cookies = await getCookies();
  for (const v of store.detectedVideos) {
    await chrome.runtime.sendMessage({
      action: 'start-download', url: v.url, formatId: 'best',
      cookies, removeWatermark: store.removeWatermark,
      title: v.title || 'video', referer: store.pageUrl,
    });
  }
  notify(`✅ ` + (LANG === 'zh' ? `已启动 ${store.detectedVideos.length} 个下载` : `Started ${store.detectedVideos.length} downloads`));
  document.querySelector('.tab[data-tab="tasks"]')?.click();
}

// ═══════════════════════════════════════════════════════════════════
// 格式分析
// ═══════════════════════════════════════════════════════════════════
async function analyzeUrl() {
  const url = $('url-input')?.value.trim();
  if (!url) { notify(t('noUrl', '⚠️ 请先输入视频链接')); return; }
  if (!await ensureServer()) return;

  const btn = $('btn-analyze');
  if (btn) { btn.textContent = '⌛'; btn.disabled = true; }
  try {
    const r = await chrome.runtime.sendMessage({ action: 'get-formats', url, cookies: await getCookies() });
    if (r?.error) { notify('❌ ' + r.error); return; }
    store.analyzeResult = r;
    const arEl = $('analyze-result');
    if (arEl) {
      $('ar-title').textContent = r.title || url;
      $('ar-meta').textContent  = (r.uploader ? r.uploader + ' · ' : '') + (r.duration ? fmtDuration(r.duration) : '');
      arEl.classList.add('visible');
    }
    const fmtList = $('format-list');
    if (fmtList) {
      fmtList.innerHTML = '';
      (r.formats || []).slice(0, 20).forEach(f => {
        const div = document.createElement('div');
        div.className = 'fmt-item';
        div.dataset.fid = f.format_id;
        div.innerHTML = `
          <span class="fmt-res">${f.resolution || (f.height ? f.height + 'p' : 'audio')}</span>
          <span class="fmt-ext">${f.ext || ''}</span>
          <span>${f.vcodec === 'none' ? '🎵' : '🎬'}</span>
          <span class="fmt-size">${f.filesize ? fmtSize(f.filesize) : ''}</span>`;
        div.addEventListener('click', () => {
          document.querySelectorAll('.fmt-item').forEach(el => el.classList.remove('active'));
          div.classList.add('active');
          store.selectedFormat = f.format_id;
        });
        fmtList.appendChild(div);
      });
      if (r.formats?.length) $('format-selector')?.classList.add('visible');
    }
  } finally {
    if (btn) { btn.textContent = t('analyzeBtn', '🔍'); btn.disabled = false; }
  }
}

async function showFormats(url) {
  const urlInput = $('url-input');
  if (urlInput) urlInput.value = url;
  document.querySelector('.tab[data-tab="download"]')?.click();
  await analyzeUrl();
}

// ═══════════════════════════════════════════════════════════════════
// 播放列表
// ═══════════════════════════════════════════════════════════════════
async function analyzePl() {
  const url = $('playlist-url-input')?.value.trim();
  if (!url) { notify(t('noUrl', '⚠️ 请输入链接')); return; }
  if (!await ensureServer()) return;
  const btn = $('btn-analyze-pl');
  if (btn) { btn.textContent = '⌛'; btn.disabled = true; }
  try {
    const r = await chrome.runtime.sendMessage({ action: 'get-playlist-info', url, cookies: await getCookies() });
    if (r?.error) { notify('❌ ' + r.error); return; }
    store.playlistItems = r.entries || [];
    store.selectedPl    = new Set(store.playlistItems.map(e => e.url));
    const titleEl = $('pl-title');
    if (titleEl) titleEl.textContent = r.title || 'Playlist';
    const plList = $('pl-list');
    if (plList) {
      plList.innerHTML = '';
      store.playlistItems.forEach(entry => {
        const div = document.createElement('div');
        div.className = 'pl-item selected';
        div.dataset.url = entry.url;
        div.innerHTML = `
          <div class="pl-check"></div>
          <div class="pl-title" title="${esc(entry.url)}">${esc(entry.title || entry.url)}</div>
          <div class="pl-dur">${entry.duration ? fmtDuration(entry.duration) : ''}</div>`;
        div.addEventListener('click', () => {
          if (store.selectedPl.has(entry.url)) {
            store.selectedPl.delete(entry.url);
            div.classList.remove('selected');
          } else {
            store.selectedPl.add(entry.url);
            div.classList.add('selected');
          }
        });
        plList.appendChild(div);
      });
    }
    const plResult = $('pl-result');
    if (plResult) plResult.style.display = 'block';
  } finally {
    if (btn) { btn.textContent = '🔍'; btn.disabled = false; }
  }
}

async function dlPlaylist() {
  if (!store.selectedPl.size) { notify(t('noSelection', '请先选择')); return; }
  if (!await ensureServer()) return;
  const cookies = await getCookies();
  for (const url of store.selectedPl) {
    await chrome.runtime.sendMessage({
      action: 'start-download', url,
      formatId: QUALITY_FMTS[store.selectedQuality] || QUALITY_FMTS.best,
      cookies, removeWatermark: store.removeWatermark,
    });
  }
  notify(`✅ ` + (LANG === 'zh' ? `已启动 ${store.selectedPl.size} 个下载` : `Started ${store.selectedPl.size} downloads`));
  document.querySelector('.tab[data-tab="tasks"]')?.click();
}

// ═══════════════════════════════════════════════════════════════════
// 确认对话框
// ═══════════════════════════════════════════════════════════════════
let _confirmCb = null;
function confirm2(icon, title, desc, cb) {
  $('dialog-icon').textContent  = icon;
  $('dialog-title').textContent = title;
  $('dialog-desc').textContent  = desc;
  _confirmCb = cb;
  $('confirm-dialog').classList.add('visible');
}
function hideConfirm() {
  $('confirm-dialog').classList.remove('visible');
  _confirmCb = null;
}

// ═══════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════
function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function setBadge(id, count) {
  const el = $(id);
  if (el) el.textContent = count > 0 ? String(count) : '';
}
function applyToggles() {
  $('toggle-watermark')?.classList.toggle('on', store.removeWatermark);
  $('toggle-subs')?.classList.toggle('on', store.embedSubs);
}
function notify(msg, dur = 2500) {
  const el = $('notify-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), dur);
}
function pctLabel(task) {
  if (task.status === 'completed') return '✅ ' + t('statusCompleted', '已完成');
  if (task.status === 'error')     return '❌ ' + t('statusError', '失败');
  if (task.status === 'cancelled') return '⛔ ' + t('statusCancelled', '已取消');
  if (task.status === 'pending')   return '⏳ ' + t('statusPending', '等待中');
  return Math.round(task.progress || 0) + '%';
}
function statusLabel(s) {
  const map = { downloading:'statusDownloading', pending:'statusPending',
    completed:'statusCompleted', error:'statusError', cancelled:'statusCancelled' };
  return t(map[s], s);
}
function fmtTime(ts) {
  if (!ts) return '';
  const diff = (Date.now() - ts * 1000) / 1000;
  if (diff < 60)    return t('justNow', '刚刚');
  if (diff < 3600)  return Math.floor(diff / 60) + (LANG === 'zh' ? '分钟前' : 'm ago');
  if (diff < 86400) return Math.floor(diff / 3600) + (LANG === 'zh' ? '小时前' : 'h ago');
  return new Date(ts * 1000).toLocaleDateString();
}
function fmtDuration(s) {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function fmtSize(bytes) {
  const units = ['B','KB','MB','GB'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return n.toFixed(1) + units[i];
}

// ── 启动 ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
