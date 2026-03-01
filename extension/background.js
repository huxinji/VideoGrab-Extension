// VideoGrab Pro - Background Service Worker v2
// 职责：请求拦截、Badge、消息路由（不再维护任务状态）

'use strict';

const SERVER_BASE = 'http://127.0.0.1:7788';

// 监控到的视频请求缓存（按tabId存储）
const interceptedVideos = new Map();

// =====================
// 初始化
// =====================
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await chrome.storage.local.set({
      serverPort:        7788,
      defaultFormat:     'best',
      downloadPath:      '',
      removeWatermark:   true,
      autoSelectFormat:  true,
      preferredQuality:  '4K',
      concurrentDownloads: 3,
      notifications:     true,
      cookieSync:        true,
    });
    chrome.tabs.create({ url: 'options.html' });
  }
  setupContextMenus();
});

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'download-video',
      title: '⬇ Download with VideoGrab',
      contexts: ['video', 'link', 'page'],
    });
    chrome.contextMenus.create({
      id: 'download-page-videos',
      title: '📋 Download all page videos',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: 'copy-video-url',
      title: '📋 Copy video URL',
      contexts: ['video'],
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab) return;
  if (info.menuItemId === 'download-video') {
    const url = info.srcUrl || info.linkUrl || tab.url;
    await startDownload({ url, title: tab.title || url });
  } else if (info.menuItemId === 'copy-video-url') {
    chrome.tabs.sendMessage(tab.id, { action: 'copy-url', url: info.srcUrl });
  }
});

// =====================
// 请求拦截（仅真正的视频资源）
// =====================
const VIDEO_PATTERNS = [
  /\.m3u8(\?|$)/i,
  /\.mpd(\?|$)/i,
  /\.(mp4|webm|flv|mkv|avi|mov|ts|m4v)(\?|$)/i,
  /googlevideo\.com/,
  /youtube\.com\/videoplayback/,
  /tiktokv\.com/,
  /aweme\.snssdk\.com.*video/,
  /cdninstagram\.com.*video/,
  /video\.twimg\.com/,
  /v\.redd\.it/,
  /bili.*video/,
];

const BLOCKED_PATTERNS = [
  /^blob:/i,
  /\.(webp|png|jpg|jpeg|gif|svg|ico)(\?|$)/i,
  /\/ping\?/i,
  /audio-only/i,
];

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { url, tabId, type } = details;
    if (tabId < 0) return;

    // 过滤非视频资源
    if (BLOCKED_PATTERNS.some(p => p.test(url))) return;

    const isVideo = VIDEO_PATTERNS.some(p => p.test(url)) || type === 'media';
    if (!isVideo) return;

    if (!interceptedVideos.has(tabId)) {
      interceptedVideos.set(tabId, new Map());
    }

    const tabVideos = interceptedVideos.get(tabId);
    if (!tabVideos.has(url)) {
      tabVideos.set(url, {
        url,
        type:      getVideoType(url),
        timestamp: Date.now(),
        quality:   extractQualityFromUrl(url),
      });
      chrome.runtime.sendMessage({
        action: 'video-intercepted',
        tabId,
        video:  tabVideos.get(url),
      }).catch(() => {});
      updateBadge(tabId);
    }
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other'] }
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    const ct = details.responseHeaders?.find(
      h => h.name.toLowerCase() === 'content-type'
    )?.value || '';

    const validMime = (
      ct.startsWith('video/') ||
      ct.includes('application/x-mpegURL') ||
      ct.includes('application/vnd.apple.mpegurl')
    );
    if (!validMime) return;

    const { tabId, url } = details;
    if (tabId < 0) return;
    if (!interceptedVideos.has(tabId)) interceptedVideos.set(tabId, new Map());
    const tabVideos = interceptedVideos.get(tabId);
    if (!tabVideos.has(url)) {
      tabVideos.set(url, {
        url,
        type:        ct.includes('mpegURL') ? 'HLS' : 'Direct',
        contentType: ct,
        timestamp:   Date.now(),
        quality:     extractQualityFromUrl(url),
      });
      updateBadge(tabId);
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders', 'extraHeaders']
);

function getVideoType(url) {
  if (/\.m3u8/i.test(url)) return 'HLS';
  if (/\.mpd/i.test(url))  return 'DASH';
  if (/\.ts(\?|$)/i.test(url)) return 'TS';
  if (/\.mp4/i.test(url))  return 'MP4';
  if (/\.webm/i.test(url)) return 'WebM';
  return 'Stream';
}

function extractQualityFromUrl(url) {
  const m = url.match(/(\d{3,4})[pP]/) || url.match(/quality=(\d+)/);
  return m ? m[1] + 'p' : 'unknown';
}

function updateBadge(tabId) {
  const count = interceptedVideos.get(tabId)?.size || 0;
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count), tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#ff6b6b', tabId });
  } else {
    chrome.action.setBadgeText({ text: '', tabId });
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    interceptedVideos.delete(tabId);
    updateBadge(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  interceptedVideos.delete(tabId);
});

// =====================
// 消息路由
// =====================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ error: err.message }));
  return true;
});

async function handleMessage(msg, sender) {
  const tabId = sender.tab?.id;

  switch (msg.action) {
    case 'get-intercepted-videos': {
      const vid = interceptedVideos.get(msg.tabId || tabId);
      return { videos: vid ? Array.from(vid.values()) : [] };
    }

    case 'get-tab-url': {
      try {
        const tab = await chrome.tabs.get(msg.tabId);
        return { url: tab.url, title: tab.title };
      } catch {
        return { url: '', title: '' };
      }
    }

    case 'get-cookies':
      return getCookiesForUrl(msg.url);

    case 'get-all-cookies':
      return getAllCookiesForTab(msg.tabId);

    case 'check-server':
      return checkServer();

    case 'get-formats':
      return callServer('POST', '/api/formats', { url: msg.url, cookies: msg.cookies });

    case 'start-download':
      return startDownload(msg);

    case 'cancel-download':
      return callServer('POST', `/api/cancel/${msg.taskId}`);

    case 'delete-task':
      return callServer('POST', `/api/delete/${msg.taskId}`);

    case 'open-folder':
      return callServer('POST', `/api/open/${msg.taskId}`);

    case 'get-all-tasks':
      return callServer('GET', '/api/tasks');

    case 'get-playlist-info':
      return callServer('POST', '/api/playlist', { url: msg.url, cookies: msg.cookies });

    case 'clear-intercepted':
      interceptedVideos.delete(msg.tabId);
      updateBadge(msg.tabId);
      return { success: true };

    case 'update-ytdlp':
      return callServer('POST', '/api/update');

    case 'get-settings':
      return chrome.storage.local.get(null);

    case 'save-settings':
      await chrome.storage.local.set(msg.settings);
      return { success: true };

    case 'inject-content-script':
      await chrome.scripting.executeScript({
        target: { tabId: msg.tabId },
        files: ['content.js'],
      });
      return { success: true };

    default:
      throw new Error('Unknown action: ' + msg.action);
  }
}

// =====================
// Cookie 管理
// =====================
async function getCookiesForUrl(url) {
  try {
    const cookies = await chrome.cookies.getAll({ url });
    return { cookies: formatCookies(cookies) };
  } catch (e) {
    return { cookies: [], error: e.message };
  }
}

async function getAllCookiesForTab(tabId) {
  try {
    const tab    = await chrome.tabs.get(tabId);
    const urlObj = new URL(tab.url);
    const domains = [
      urlObj.hostname,
      '.' + urlObj.hostname,
    ];
    if (urlObj.hostname.split('.').length > 2) {
      const parts = urlObj.hostname.split('.');
      domains.push('.' + parts.slice(-2).join('.'));
    }

    const all = [];
    for (const d of [...new Set(domains)]) {
      try { all.push(...await chrome.cookies.getAll({ domain: d })); } catch {}
    }

    const seen = new Set();
    const unique = all.filter(c => {
      const k = `${c.domain}|${c.name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    return {
      cookies:         formatCookies(unique),
      cookieHeader:    unique.map(c => `${c.name}=${c.value}`).join('; '),
      netscapeCookies: toNetscape(unique),
    };
  } catch (e) {
    return { cookies: [], error: e.message };
  }
}

function formatCookies(cookies) {
  return cookies.map(c => ({
    name:           c.name,
    value:          c.value,
    domain:         c.domain,
    path:           c.path,
    secure:         c.secure,
    httpOnly:       c.httpOnly,
    expirationDate: c.expirationDate,
  }));
}

function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File', '# Generated by VideoGrab Pro'];
  cookies.forEach(c => {
    const d   = c.domain;
    const sub = d.startsWith('.') ? 'TRUE' : 'FALSE';
    const sec = c.secure ? 'TRUE' : 'FALSE';
    const exp = c.expirationDate ? Math.floor(c.expirationDate) : 0;
    lines.push(`${d}\t${sub}\t${c.path || '/'}\t${sec}\t${exp}\t${c.name}\t${c.value}`);
  });
  return lines.join('\n');
}

// =====================
// 服务器通信
// =====================
async function getPort() {
  const s = await chrome.storage.local.get(['serverPort']).catch(() => ({}));
  return s.serverPort || 7788;
}

async function callServer(method, path, body) {
  const port = await getPort();
  try {
    const opts = {
      method,
      signal: AbortSignal.timeout(30000),
    };
    if (body) {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body    = JSON.stringify(body);
    }
    const resp = await fetch(`http://127.0.0.1:${port}${path}`, opts);
    return await resp.json();
  } catch (e) {
    return { error: e.message };
  }
}

async function checkServer() {
  const port = await getPort();
  for (let i = 0; i < 3; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/api/status`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) {
        const data = await resp.json();
        return { running: true, ...data };
      }
    } catch {
      if (i < 2) await new Promise(r => setTimeout(r, 500));
    }
  }
  return { running: false, error: 'Cannot connect to local server' };
}

async function startDownload(params) {
  const settings = await chrome.storage.local.get(['serverPort', 'removeWatermark', 'downloadPath']);
  const port     = settings.serverPort || 7788;
  const payload  = {
    url:              params.url,
    format_id:        params.formatId || 'bestvideo+bestaudio/best',
    cookies:          params.cookies,
    remove_watermark: params.removeWatermark ?? settings.removeWatermark ?? true,
    download_path:    params.downloadPath || settings.downloadPath || '',
    title:            params.title || '',
    embed_subs:       params.embedSubs || false,
    referer:          params.referer || '',
    user_agent:       params.userAgent || '',
  };
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api/download`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
      signal:  AbortSignal.timeout(10000),
    });
    const data = await resp.json();
    // 完成通知由 SSE 推送后 popup 自行处理；这里只返回 task_id
    return data;
  } catch (e) {
    return { error: e.message };
  }
}
