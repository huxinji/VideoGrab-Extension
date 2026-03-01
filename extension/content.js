// VideoGrab Pro - content.js v2
// 职责：DOM 视频扫描、平台识别；仅允许真正的视频资源

'use strict';

const VALID_MIME = [
  'video/',
  'application/x-mpegurl',
  'application/vnd.apple.mpegurl',
];

const VALID_EXT = ['.mp4', '.mkv', '.webm', '.m3u8', '.ts', '.flv', '.mov', '.m4v'];

const BLOCKED_PREFIX = ['blob:', 'data:', 'javascript:'];
const BLOCKED_EXT    = ['.webp', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.mp3', '.aac'];

function isVideoUrl(url) {
  if (!url) return false;
  if (BLOCKED_PREFIX.some(p => url.startsWith(p))) return false;
  const lower = url.toLowerCase().split('?')[0];
  if (BLOCKED_EXT.some(e => lower.endsWith(e))) return false;
  if (VALID_EXT.some(e => lower.includes(e))) return true;
  return false;
}

// ── 平台检测 ────────────────────────────────────────────────────────────────
const PLATFORMS = {
  'youtube.com':    'YouTube',
  'youtu.be':       'YouTube',
  'tiktok.com':     'TikTok',
  'douyin.com':     'Douyin',
  'instagram.com':  'Instagram',
  'twitter.com':    'Twitter/X',
  'x.com':          'Twitter/X',
  'bilibili.com':   'Bilibili',
  'weibo.com':      'Weibo',
  'xiaohongshu.com':'XiaoHongShu',
  'facebook.com':   'Facebook',
  'vimeo.com':      'Vimeo',
  'reddit.com':     'Reddit',
  'twitch.tv':      'Twitch',
  'ixigua.com':     'XiGua',
  'kuaishou.com':   'Kuaishou',
};

function detectPlatform() {
  const host = location.hostname.replace(/^www\./, '');
  for (const [domain, name] of Object.entries(PLATFORMS)) {
    if (host === domain || host.endsWith('.' + domain)) {
      return name;
    }
  }
  return null;
}

// ── DOM 视频扫描 ─────────────────────────────────────────────────────────────
function scanDomVideos() {
  const videos = [];
  const seen   = new Set();

  // <video> 元素
  document.querySelectorAll('video').forEach(el => {
    const srcs = [
      el.src,
      el.currentSrc,
      ...Array.from(el.querySelectorAll('source')).map(s => s.src),
    ].filter(Boolean);

    srcs.forEach(src => {
      const url = resolveUrl(src);
      if (!url || seen.has(url)) return;
      seen.add(url);
      // blob: 可能是 MSE 流，不能直接下载，跳过
      if (url.startsWith('blob:')) return;
      if (!isVideoUrl(url) && !url.includes('googlevideo') && !url.includes('videoplayback')) return;

      videos.push({
        url,
        type:    getType(url),
        title:   el.title || document.title || '',
        quality: extractQuality(url),
        poster:  el.poster || '',
      });
    });
  });

  // <a> 链接
  document.querySelectorAll('a[href]').forEach(el => {
    const url = resolveUrl(el.href);
    if (!url || seen.has(url)) return;
    if (!isVideoUrl(url)) return;
    seen.add(url);
    videos.push({
      url,
      type:    getType(url),
      title:   el.textContent.trim() || el.title || url,
      quality: extractQuality(url),
      poster:  '',
    });
  });

  // meta og:video
  const ogVideo = document.querySelector('meta[property="og:video"]')?.content;
  if (ogVideo) {
    const url = resolveUrl(ogVideo);
    if (url && !seen.has(url) && isVideoUrl(url)) {
      seen.add(url);
      videos.push({
        url,
        type:    getType(url),
        title:   document.title,
        quality: extractQuality(url),
        poster:  document.querySelector('meta[property="og:image"]')?.content || '',
      });
    }
  }

  return videos;
}

function resolveUrl(src) {
  try {
    return new URL(src, location.href).href;
  } catch {
    return null;
  }
}

function getType(url) {
  const u = url.toLowerCase();
  if (u.includes('.m3u8')) return 'HLS';
  if (u.includes('.mpd'))  return 'DASH';
  if (u.includes('.mp4'))  return 'MP4';
  if (u.includes('.webm')) return 'WebM';
  if (u.includes('.ts'))   return 'TS';
  return 'Stream';
}

function extractQuality(url) {
  const m = url.match(/(\d{3,4})[pP]/) || url.match(/quality=(\d+)/);
  return m ? m[1] + 'p' : 'unknown';
}

// ── 消息监听 ─────────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'scan-videos') {
    const platform = detectPlatform();
    const videos   = scanDomVideos();
    sendResponse({
      videos,
      platformInfo: platform ? {
        platform,
        title:      document.title,
        pageUrl:    location.href,
        isPlaylist: /playlist|list=|/i.test(location.href),
      } : null,
    });
    return true;
  }

  if (msg.action === 'copy-url') {
    navigator.clipboard.writeText(msg.url || location.href).catch(() => {});
    sendResponse({ success: true });
    return true;
  }
});
