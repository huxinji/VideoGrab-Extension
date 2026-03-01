// VideoGrab Pro - options.js v2.1
// 接入与 popup.js 相同的运行时 i18n 系统，支持中/英切换

'use strict';

// ─────────────────────────────────────────────────────────────────
// i18n（与 popup.js 完全相同的机制，两页共享 chrome.storage.vg_lang）
// ─────────────────────────────────────────────────────────────────
const I18N = { zh: {}, en: {} };
let   LANG = 'zh';

async function loadI18n() {
  const [zh, en] = await Promise.all([
    fetch(chrome.runtime.getURL('_locales/zh_CN/messages.json')).then(r => r.json()),
    fetch(chrome.runtime.getURL('_locales/en/messages.json')).then(r => r.json()),
  ]);
  for (const [k, v] of Object.entries(zh)) I18N.zh[k] = v.message;
  for (const [k, v] of Object.entries(en)) I18N.en[k] = v.message;
}

function t(key, fallback) {
  return I18N[LANG]?.[key] || I18N.zh[key] || fallback || key;
}

/** 遍历所有 data-i18n 节点，替换文本内容 */
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const msg = t(el.dataset.i18n);
    if (!msg) return;
    // <option> / <button> / <div> 直接替换 textContent
    // 但要保留内部有子元素的节点（如 card-title 里含图标的情况）
    if (el.children.length === 0) {
      el.textContent = msg;
    }
  });
  // placeholder
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const msg = t(el.dataset.i18nPh);
    if (msg) el.placeholder = msg;
  });
  // 语言切换按钮本身显示"目标语言"
  const langBtn = document.getElementById('btn-lang');
  if (langBtn) langBtn.textContent = t('optLangSwitch', LANG === 'zh' ? 'EN' : '中文');
  // copy hint 文字（code-block 内的 span）
  document.querySelectorAll('.copy-hint').forEach(el => {
    if (!el.dataset.copied) el.textContent = t('clickCopy', '点击复制');
  });
  // update-log 初始占位文字（只在为空时替换）
  const log = document.getElementById('update-log');
  if (log && log.dataset.empty !== 'false') {
    log.textContent = t('updateLogWaiting', '等待更新...');
  }
}

async function toggleLang() {
  LANG = LANG === 'zh' ? 'en' : 'zh';
  await chrome.storage.local.set({ vg_lang: LANG });
  applyI18n();
}

// ─────────────────────────────────────────────────────────────────
// Settings load / save / reset
// ─────────────────────────────────────────────────────────────────
let currentSettings = {};

async function loadSettings() {
  try {
    const s = await chrome.storage.local.get(null);
    currentSettings = s;

    const set = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.value = val ?? el.value;
    };

    set('pref-quality',      s.preferredQuality    ?? 'best');
    set('pref-format',       s.preferredFormat     ?? 'mp4');
    set('download-path',     s.downloadPath        ?? '');
    set('filename-template', s.filenameTemplate    ?? '%(title)s.%(ext)s');
    set('concurrent',        s.concurrentDownloads ?? 3);
    set('server-port',       s.serverPort          ?? 7788);
    set('proxy-url',         s.proxyUrl            ?? '');
    set('extra-args',        (s.extraArgs ?? []).join('\n'));

    const tog = (id, val, defaultOn) => {
      const el = document.getElementById(id);
      if (el) el.classList.toggle('on', val !== undefined ? !!val : !!defaultOn);
    };
    tog('opt-watermark', s.removeWatermark, true);
    tog('opt-cookie',    s.cookieSync,      true);
    tog('opt-notif',     s.notifications,   true);
    tog('opt-subs',      s.embedSubs,       false);
    tog('opt-thumb',     s.writeThumbnail,  false);
    tog('opt-proxy',     s.useProxy,        false);

    const proxyRow = document.getElementById('proxy-row');
    if (proxyRow) proxyRow.style.display = s.useProxy ? 'flex' : 'none';
  } catch (e) {
    console.error('loadSettings error:', e);
  }
}

async function saveSettings() {
  try {
    const tog = id => document.getElementById(id)?.classList.contains('on') ?? false;
    const val = id => document.getElementById(id)?.value ?? '';

    const settings = {
      preferredQuality:    val('pref-quality'),
      preferredFormat:     val('pref-format'),
      downloadPath:        val('download-path'),
      filenameTemplate:    val('filename-template'),
      concurrentDownloads: parseInt(val('concurrent'))  || 3,
      serverPort:          parseInt(val('server-port')) || 7788,
      proxyUrl:            val('proxy-url'),
      extraArgs:           val('extra-args').split('\n').map(l => l.trim()).filter(Boolean),
      removeWatermark:     tog('opt-watermark'),
      cookieSync:          tog('opt-cookie'),
      notifications:       tog('opt-notif'),
      embedSubs:           tog('opt-subs'),
      writeThumbnail:      tog('opt-thumb'),
      useProxy:            tog('opt-proxy'),
    };

    await chrome.storage.local.set(settings);
    currentSettings = settings;
    showStatus(t('saveOk', '✅ 已保存'), '#00c896');
  } catch (e) {
    showStatus(t('saveFail', '❌ 保存失败') + ': ' + e.message, '#ff4757');
  }
}

async function resetSettings() {
  if (!confirm(t('resetConfirm', '确定恢复所有默认设置吗？'))) return;
  const defaults = {
    serverPort: 7788, preferredQuality: 'best', preferredFormat: 'mp4',
    downloadPath: '', filenameTemplate: '%(title)s.%(ext)s',
    removeWatermark: true, cookieSync: true, notifications: true,
    embedSubs: false, writeThumbnail: false, useProxy: false,
    proxyUrl: '', extraArgs: [], concurrentDownloads: 3,
  };
  await chrome.storage.local.set(defaults);
  await loadSettings();
  showStatus(t('resetOk', '✅ 已恢复默认'), '#00c896');
}

function showStatus(msg, color) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = color || '#00c896';
  setTimeout(() => { el.textContent = ''; }, 3000);
}

// ─────────────────────────────────────────────────────────────────
// 服务检测 / 更新
// ─────────────────────────────────────────────────────────────────
async function checkStatus() {
  const dot    = document.getElementById('srv-dot');
  const name   = document.getElementById('srv-name');
  const detail = document.getElementById('srv-detail');
  const updateBtn  = document.getElementById('btn-update');
  const updateCard = document.getElementById('update-card');

  if (dot)    { dot.className = 'status-dot'; dot.style.background = '#ffd700'; }
  if (detail) detail.textContent = t('srvChecking', '检测中...');

  try {
    const result = await chrome.runtime.sendMessage({ action: 'check-server' });
    if (result?.running) {
      if (dot)    { dot.className = 'status-dot running'; dot.style.background = ''; }
      if (name)   name.textContent = t('srvRunning', '本地服务运行中 ✅');
      if (detail) detail.textContent =
        `Port: ${result.port || 7788}  ·  yt-dlp: ${result.ytdlp_version || '?'}  ·  ffmpeg: ${result.ffmpeg ? '✅' : '❌'}`;
      if (updateBtn)  updateBtn.style.display = 'inline-block';
      if (updateCard) updateCard.style.display = 'block';
    } else {
      if (dot)    { dot.className = 'status-dot stopped'; dot.style.background = ''; }
      if (name)   name.textContent = t('srvStopped', '本地服务未启动');
      if (detail) detail.textContent = t('srvStoppedDesc', '请在终端运行 python3 server.py');
      if (updateBtn)  updateBtn.style.display = 'none';
    }
  } catch (e) {
    if (detail) detail.textContent = t('srvStopped', '检测失败') + ': ' + e.message;
  }
}

async function updateYtdlp() {
  const log = document.getElementById('update-log');
  if (log) { log.textContent = '...'; log.dataset.empty = 'false'; }
  try {
    const result = await chrome.runtime.sendMessage({ action: 'update-ytdlp' });
    if (log) log.textContent = result.error
      ? ('❌ ' + result.error)
      : (result.log || '✅ Done');
  } catch (e) {
    if (log) log.textContent = '❌ ' + e.message;
  }
}

// ─────────────────────────────────────────────────────────────────
// Cookie 导出
// ─────────────────────────────────────────────────────────────────
async function exportCookies() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const result = await chrome.runtime.sendMessage({ action: 'get-all-cookies', tabId: tab.id });
    if (result?.netscapeCookies) {
      const blob = new Blob([result.netscapeCookies], { type: 'text/plain' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = 'cookies.txt'; a.click();
      URL.revokeObjectURL(url);
    } else {
      alert(t('cookieNone', '未获取到 Cookie，请确保已在目标网站登录'));
    }
  } catch (e) {
    alert(t('exportFail', '导出失败') + ': ' + e.message);
  }
}

// ─────────────────────────────────────────────────────────────────
// Code block 复制
// ─────────────────────────────────────────────────────────────────
function setupCodeBlocks() {
  document.querySelectorAll('[data-copyable]').forEach(block => {
    block.addEventListener('click', () => {
      const hint = block.querySelector('.copy-hint');
      const text = block.textContent
        .replace(t('clickCopy', '点击复制'), '')
        .replace(t('copiedText', '✅ 已复制'), '')
        .trim();
      navigator.clipboard.writeText(text).then(() => {
        if (hint) {
          hint.dataset.copied = 'true';
          hint.textContent = t('copiedText', '✅ 已复制');
          setTimeout(() => {
            delete hint.dataset.copied;
            hint.textContent = t('clickCopy', '点击复制');
          }, 2000);
        }
      });
    });
  });
}

function downloadServerFiles() {
  alert(t('serverFilesHint', 'server 文件夹已包含在完整安装包中，解压后找到 server/ 文件夹即可。'));
}

// ─────────────────────────────────────────────────────────────────
// DOMContentLoaded
// ─────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // 1. 加载语言包，读取已存语言设置
  await loadI18n();
  const stored = await chrome.storage.local.get(['vg_lang']).catch(() => ({}));
  LANG = stored.vg_lang || 'zh';
  applyI18n();

  // 2. 加载用户设置
  await loadSettings();

  // 3. 检查服务状态
  checkStatus();

  // 4. 语言切换按钮
  document.getElementById('btn-lang')?.addEventListener('click', toggleLang);

  // 5. 保存 / 恢复默认
  document.getElementById('btn-save')?.addEventListener('click', saveSettings);
  document.getElementById('btn-reset')?.addEventListener('click', resetSettings);

  // 6. 服务检测 / 更新按钮
  document.getElementById('btn-check')?.addEventListener('click', checkStatus);
  document.getElementById('btn-update')?.addEventListener('click', updateYtdlp);
  document.getElementById('btn-update-engine')?.addEventListener('click', updateYtdlp);

  // 7. Cookie 导出
  document.getElementById('btn-export-cookie')?.addEventListener('click', exportCookies);

  // 8. 下载服务文件按钮
  ['btn-dl-win', 'btn-dl-mac', 'btn-dl-linux'].forEach(id => {
    document.getElementById(id)?.addEventListener('click', downloadServerFiles);
  });

  // 9. Nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('section-' + tab.dataset.section)?.classList.add('active');
    });
  });

  // 10. OS tabs
  document.querySelectorAll('.tab-os').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-os').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.os-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('os-' + tab.dataset.os)?.classList.add('active');
    });
  });

  // 11. Toggle 开关
  document.querySelectorAll('.toggle').forEach(el => {
    el.addEventListener('click', () => {
      el.classList.toggle('on');
      if (el.id === 'opt-proxy') {
        const row = document.getElementById('proxy-row');
        if (row) row.style.display = el.classList.contains('on') ? 'flex' : 'none';
      }
    });
  });

  // 12. Code block 复制
  setupCodeBlocks();

  // 13. Hash 跳转
  if (location.hash === '#install') {
    document.querySelector('[data-section="install"]')?.click();
  }
});
