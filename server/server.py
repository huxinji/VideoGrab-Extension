#!/usr/bin/env python3
"""VideoGrab Pro - 本地下载服务 v6.1"""

import os, sys, uuid, time, json, queue, threading, subprocess, tempfile, logging, platform
from pathlib import Path

try:
    from flask import Flask, request, jsonify, Response, stream_with_context
    from flask_cors import CORS
    import yt_dlp
except ImportError as e:
    print(f"缺少依赖: {e}\n请运行: pip3 install flask flask-cors yt-dlp")
    sys.exit(1)

PORT        = int(os.environ.get('VIDEOGRAB_PORT', 7788))
DEFAULT_DIR = str(Path.home() / 'Downloads' / 'VideoGrab')
VERSION     = '2.0.1'
PLATFORM    = platform.system()   # 'Windows' | 'Darwin' | 'Linux'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('videograb')

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": "*"}})

# ─────────────────────────────────────────────────────────────────────────────
# TaskManager
# ─────────────────────────────────────────────────────────────────────────────
class TaskManager:
    def __init__(self):
        self._tasks: dict = {}
        self._deleted: set = set()       # 已删除的 task_id 集合
        self._procs: dict = {}
        self._lock = threading.Lock()
        self._subs: list = []
        self._subs_lock = threading.Lock()

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=512)
        with self._subs_lock:
            self._subs.append(q)
        return q

    def unsubscribe(self, q: queue.Queue):
        with self._subs_lock:
            try:
                self._subs.remove(q)
            except ValueError:
                pass

    def _broadcast(self, task_id: str):
        with self._lock:
            if task_id in self._deleted:
                return
            t = self._tasks.get(task_id)
            if not t:
                return
            payload = json.dumps(t)
        with self._subs_lock:
            dead = []
            for q in self._subs:
                try:
                    q.put_nowait(payload)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self._subs.remove(q)

    def create(self, url: str, title: str, download_path: str) -> dict:
        tid = str(uuid.uuid4())
        task = {
            'id':           tid,
            'url':          url,
            'title':        title or url,
            'status':       'pending',
            'progress':     0.0,
            'speed':        '',
            'eta':          '',
            'error':        '',
            'file_path':    '',
            'created_at':   time.time(),
            'completed_at': None,
            'download_path': download_path,
        }
        with self._lock:
            self._tasks[tid] = task
        self._broadcast(tid)
        return task

    def update(self, tid: str, **kwargs):
        """更新任务字段。若任务已被删除，直接忽略（防止重现）。"""
        with self._lock:
            if tid in self._deleted:
                return          # ★ 关键：已删除则不写回
            if tid not in self._tasks:
                return
            self._tasks[tid].update(kwargs)
        self._broadcast(tid)

    def get(self, tid: str) -> dict | None:
        with self._lock:
            if tid in self._deleted:
                return None
            t = self._tasks.get(tid)
            return dict(t) if t else None

    def is_deleted(self, tid: str) -> bool:
        with self._lock:
            return tid in self._deleted

    def all_tasks(self) -> list:
        with self._lock:
            return sorted(
                [t for tid, t in self._tasks.items() if tid not in self._deleted],
                key=lambda x: x.get('created_at', 0), reverse=True
            )

    def register_proc(self, tid: str, proc):
        with self._lock:
            self._procs[tid] = proc

    def kill_proc(self, tid: str):
        with self._lock:
            proc = self._procs.pop(tid, None)
        if proc and proc.poll() is None:
            try:
                if PLATFORM == 'Windows':
                    subprocess.run(
                        ['taskkill', '/PID', str(proc.pid), '/T', '/F'],
                        capture_output=True, timeout=5
                    )
                else:
                    proc.terminate()
                    try:
                        proc.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        proc.kill()
            except Exception as ex:
                log.warning(f'kill proc failed: {ex}')

    def delete(self, tid: str):
        """永久删除任务，加入黑名单防止重现。"""
        with self._lock:
            self._deleted.add(tid)          # ★ 先加黑名单
            self._tasks.pop(tid, None)      # 再移除数据
            self._procs.pop(tid, None)
        # 广播一个特殊的删除事件，让前端知道要移除此 ID
        payload = json.dumps({'id': tid, '__deleted__': True})
        with self._subs_lock:
            dead = []
            for q in self._subs:
                try:
                    q.put_nowait(payload)
                except queue.Full:
                    dead.append(q)
            for q in dead:
                self._subs.remove(q)


mgr = TaskManager()


# ─────────────────────────────────────────────────────────────────────────────
# Cookie 工具
# ─────────────────────────────────────────────────────────────────────────────
def write_cookie_file(cookies_data: dict) -> str | None:
    if not cookies_data:
        return None
    netscape    = cookies_data.get('netscapeCookies', '')
    cookie_list = cookies_data.get('cookies', [])
    lines       = ['# Netscape HTTP Cookie File']

    if netscape and netscape.strip():
        lines.append(netscape.strip())
    elif cookie_list:
        for c in cookie_list:
            domain = c.get('domain', '')
            if not domain:
                continue
            sub    = 'TRUE' if domain.startswith('.') else 'FALSE'
            path   = c.get('path', '/')
            secure = 'TRUE' if c.get('secure') else 'FALSE'
            exp    = str(int(c.get('expirationDate') or 0))
            name   = c.get('name', '')
            value  = c.get('value', '')
            lines.append(f'{domain}\t{sub}\t{path}\t{secure}\t{exp}\t{name}\t{value}')

    if len(lines) <= 1:
        return None

    tmp = tempfile.NamedTemporaryFile(
        mode='w', suffix='.txt', prefix='vg_ck_',
        delete=False, encoding='utf-8'
    )
    tmp.write('\n'.join(lines))
    tmp.close()
    return tmp.name


def cleanup_file(path: str):
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except Exception:
        pass


def cleanup_temp_files(directory: str):
    try:
        TEMP_SUFFIXES = ('.part', '.ytdl', '.temp', '.frag', '.fragtmp')
        removed = []
        for fname in os.listdir(directory):
            if any(fname.endswith(s) for s in TEMP_SUFFIXES):
                fpath = os.path.join(directory, fname)
                try:
                    os.remove(fpath)
                    removed.append(fname)
                except Exception:
                    pass
        if removed:
            log.info(f'清理了 {len(removed)} 个临时文件: {removed}')
    except Exception:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# 格式字符串构建（多级 fallback，解决 YouTube "format not available"）
# ─────────────────────────────────────────────────────────────────────────────
def build_format_string(requested: str, url: str, remove_wm: bool) -> str:
    """
    将前端传来的简单格式标识转换为健壮的 yt-dlp 格式字符串。
    核心原则：每个选项都以 /best 或 /bestaudio 兜底，确保不抛 "format not available"。

    YouTube 下载经验：
    - bestvideo 优先取 mp4 编码流，因为和 m4a/aac 合并兼容性最好
    - 若没有 mp4 流则取任意最优视频流（vp9/av1），合并为 mp4 由 ffmpeg 处理
    - bestaudio 优先取 m4a（兼容性好），其次 webm/opus
    """
    url_lower = url.lower()
    is_youtube = 'youtube.com' in url_lower or 'youtu.be' in url_lower

    # TikTok / 抖音去水印
    if remove_wm and ('tiktok.com' in url_lower or 'douyin.com' in url_lower):
        return 'download_without_watermark/bestvideo+bestaudio/best'

    # 前端传来的是具体 format_id（来自格式选择界面），直接使用，加 /best 兜底
    KNOWN_SELECTORS = {'best', 'bestvideo+bestaudio/best', 'bestaudio/best',
                       'bestaudio', 'bestvideo', 'worst'}
    if requested not in KNOWN_SELECTORS and '+' not in requested and '/' not in requested:
        # 具体 format_id，如 "137+140"
        return f'{requested}/bestvideo+bestaudio/best'

    # 高质量音频
    if requested == 'bestaudio/best' or requested == 'bestaudio':
        return 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best'

    # 解析高度限制
    height = None
    if '[height<=' in requested:
        try:
            height = int(requested.split('[height<=')[1].split(']')[0])
        except Exception:
            pass

    if is_youtube:
        # YouTube 专用格式串：优先 mp4+m4a 组合（ffmpeg 合并零问题），
        # 再退到任意 bestvideo+bestaudio，最终兜底 best
        if height:
            return (
                f'bestvideo[height<={height}][ext=mp4]+bestaudio[ext=m4a]'
                f'/bestvideo[height<={height}]+bestaudio[ext=m4a]'
                f'/bestvideo[height<={height}]+bestaudio'
                f'/bestvideo[ext=mp4]+bestaudio[ext=m4a]'
                f'/bestvideo+bestaudio'
                f'/best[height<={height}]'
                f'/best'
            )
        else:
            # "最高画质" 或 "best"
            return (
                'bestvideo[ext=mp4]+bestaudio[ext=m4a]'
                '/bestvideo+bestaudio[ext=m4a]'
                '/bestvideo+bestaudio'
                '/best'
            )
    else:
        # 非 YouTube：通用格式，宽松一些
        if height:
            return (
                f'bestvideo[height<={height}]+bestaudio'
                f'/best[height<={height}]'
                f'/bestvideo+bestaudio'
                f'/best'
            )
        return 'bestvideo+bestaudio/best'


# ─────────────────────────────────────────────────────────────────────────────
# yt-dlp 选项
# ─────────────────────────────────────────────────────────────────────────────
def build_opts(format_id, out_dir, cookies_file, embed_subs, proxy, progress_hook,
               http_headers=None):
    os.makedirs(out_dir, exist_ok=True)
    opts = {
        'format':                   format_id,
        'outtmpl':                  os.path.join(out_dir, '%(title)s.%(ext)s'),
        'merge_output_format':      'mp4',
        'no_part':                  True,
        'keepvideo':                False,
        'writethumbnail':           False,
        'writesubtitles':           False,
        'writeautomaticsub':        False,
        'quiet':                    True,
        'no_warnings':              True,
        'ignoreerrors':             False,
        'noplaylist':               True,
        'concurrent_fragment_downloads': 4,
        'postprocessors':           [],
    }

    # Cookie：优先使用扩展传来的显式 cookie 文件
    if cookies_file:
        opts['cookiefile'] = cookies_file
    else:
        # 尝试从 Chrome 读取（yt-dlp >= 2022.10.4 支持，参数名为 cookiesfrombrowser）
        try:
            opts['cookiesfrombrowser'] = ('chrome', None, None, None)
        except Exception:
            pass

    if proxy:
        opts['proxy'] = proxy
    if progress_hook:
        opts['progress_hooks'] = [progress_hook]
    if http_headers:
        opts['http_headers'] = http_headers

    if embed_subs:
        opts.update({
            'writesubtitles':    True,
            'writeautomaticsub': True,
            'subtitleslangs':    ['zh-Hans', 'zh-Hant', 'zh', 'en'],
        })
        opts['postprocessors'].append({
            'key': 'FFmpegEmbedSubtitle',
            'already_have_subtitle': False,
        })
    return opts


# ─────────────────────────────────────────────────────────────────────────────
# 下载线程
# ─────────────────────────────────────────────────────────────────────────────
def do_download(tid: str, data: dict):
    ck_file = None
    try:
        # ★ 下载开始前先检查是否已被删除
        if mgr.is_deleted(tid):
            return

        url        = (data.get('url') or '').strip()
        out_dir    = data.get('download_path') or DEFAULT_DIR
        embed_subs = bool(data.get('embed_subs', False))
        proxy      = data.get('proxy', '')
        remove_wm  = bool(data.get('remove_watermark', True))

        # ★ 使用健壮的格式字符串（多级 fallback）
        raw_format = build_format_string(
            data.get('format_id') or 'best',
            url,
            remove_wm,
        )
        log.info(f'格式字符串: {raw_format!r}  URL: {url[:60]}')

        ck_file = write_cookie_file(data.get('cookies'))

        http_headers = {}
        if data.get('referer'):
            http_headers['Referer'] = data['referer']
        if data.get('user_agent'):
            http_headers['User-Agent'] = data['user_agent']
        http_headers = http_headers or None

        final_info = [None]

        def hook(d):
            # ★ 每次回调先检查是否已删除/取消
            if mgr.is_deleted(tid):
                raise Exception('任务已删除')
            t = mgr.get(tid)
            if t and t['status'] == 'cancelled':
                raise Exception('用户取消下载')

            if d['status'] == 'downloading':
                total = d.get('total_bytes') or d.get('total_bytes_estimate') or 0
                dl    = d.get('downloaded_bytes') or 0
                pct   = round(dl / total * 100, 1) if total > 0 else 0
                spd   = d.get('speed') or 0
                eta   = d.get('eta') or 0
                title = d.get('info_dict', {}).get('title', '')
                update = dict(
                    status='downloading',
                    progress=pct,
                    speed=(fmt_bytes(spd) + '/s') if spd > 0 else '',
                    eta=fmt_eta(int(eta)) if eta > 0 else '',
                )
                if title:
                    update['title'] = title
                mgr.update(tid, **update)
            elif d['status'] == 'finished':
                mgr.update(tid, progress=100, speed='', eta='')
            elif d['status'] == 'error':
                mgr.update(tid, status='error', error=str(d.get('error', '下载失败')))

        opts = build_opts(raw_format, out_dir, ck_file, embed_subs, proxy, hook, http_headers)
        mgr.update(tid, status='downloading')

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
            if info:
                final_info[0] = info
                # ★ 用 prepare_filename 获取最终合并后的文件名
                try:
                    fname = ydl.prepare_filename(info)
                    # yt-dlp 合并后统一为 .mp4
                    base  = os.path.splitext(fname)[0]
                    for ext in ['.mp4', '.mkv', '.webm', '.flv', '.mov']:
                        candidate = base + ext
                        if os.path.exists(candidate):
                            fname = candidate
                            break
                except Exception:
                    fname = ''
                mgr.update(tid, title=info.get('title', ''), file_path=fname)

        cleanup_temp_files(out_dir)

        if not mgr.is_deleted(tid):
            t = mgr.get(tid)
            if t and t['status'] not in ('error', 'cancelled'):
                mgr.update(tid, status='completed', progress=100, completed_at=time.time())

        log.info(f'完成: {tid[:8]} — {url[:60]}')

    except Exception as e:
        err_msg = str(e)
        if mgr.is_deleted(tid):
            return      # 已删除，静默退出
        t = mgr.get(tid)
        is_cancel = (t and t.get('status') == 'cancelled') or '用户取消' in err_msg or '任务已删除' in err_msg
        if is_cancel:
            log.info(f'已取消/删除: {tid[:8]}')
            if not mgr.is_deleted(tid):
                t = mgr.get(tid)
                if t and t['status'] != 'cancelled':
                    mgr.update(tid, status='cancelled', progress=0, speed='', eta='')
        elif isinstance(e, yt_dlp.utils.DownloadError):
            err = clean_err(err_msg)
            log.error(f'下载错误 {tid[:8]}: {err}')
            mgr.update(tid, status='error', error=err)
        else:
            log.exception(f'异常 {tid[:8]}')
            if not mgr.is_deleted(tid):
                t = mgr.get(tid)
                if t and t.get('status') not in ('cancelled',):
                    mgr.update(tid, status='error', error=err_msg[:200])
    finally:
        cleanup_file(ck_file)
        mgr.kill_proc(tid)


# ─────────────────────────────────────────────────────────────────────────────
# CORS
# ─────────────────────────────────────────────────────────────────────────────
@app.after_request
def add_cors(resp):
    resp.headers['Access-Control-Allow-Origin']  = '*'
    resp.headers['Access-Control-Allow-Methods'] = 'GET, POST, DELETE, OPTIONS'
    resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    return resp


# ─────────────────────────────────────────────────────────────────────────────
# SSE
# ─────────────────────────────────────────────────────────────────────────────
@app.route('/events')
def sse_events():
    q = mgr.subscribe()

    def generate():
        # 推送现有任务快照（已删除的已被过滤）
        for t in mgr.all_tasks():
            yield f"data: {json.dumps(t)}\n\n"
        # 持续推送 + 心跳
        while True:
            try:
                payload = q.get(timeout=20)
                yield f"data: {payload}\n\n"
            except queue.Empty:
                yield ": heartbeat\n\n"

    def stream():
        try:
            yield from generate()
        finally:
            mgr.unsubscribe(q)

    return Response(
        stream_with_context(stream()),
        mimetype='text/event-stream',
        headers={
            'Cache-Control':               'no-cache',
            'X-Accel-Buffering':           'no',
            'Access-Control-Allow-Origin': '*',
        }
    )


# ─────────────────────────────────────────────────────────────────────────────
# API
# ─────────────────────────────────────────────────────────────────────────────
@app.route('/api/status')
def api_status():
    ytdlp_ver = 'unknown'
    try:
        ytdlp_ver = yt_dlp.version.__version__
    except Exception:
        pass
    ffmpeg_ok = False
    try:
        r = subprocess.run(['ffmpeg', '-version'], capture_output=True, timeout=5)
        ffmpeg_ok = (r.returncode == 0)
    except Exception:
        pass
    return jsonify({
        'status':        'running',
        'version':       VERSION,
        'ytdlp_version': ytdlp_ver,
        'ffmpeg':        ffmpeg_ok,
        'port':          PORT,
    })


@app.route('/api/formats', methods=['POST', 'OPTIONS'])
def api_formats():
    if request.method == 'OPTIONS':
        return '', 204
    data = request.get_json(silent=True) or {}
    url  = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': '请提供视频 URL'}), 400

    ck_file = write_cookie_file(data.get('cookies'))
    try:
        opts = {
            'quiet': True, 'no_warnings': True,
            'skip_download': True, 'noplaylist': True,
        }
        if ck_file:
            opts['cookiefile'] = ck_file
        else:
            try:
                opts['cookiesfrombrowser'] = ('chrome', None, None, None)
            except Exception:
                pass
        if data.get('proxy'):
            opts['proxy'] = data['proxy']

        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)

        if not info:
            return jsonify({'error': '无法获取视频信息'}), 400

        fmts = []
        for f in (info.get('formats') or []):
            if f.get('vcodec', 'none') == 'none' and f.get('acodec', 'none') == 'none':
                continue
            fmts.append({
                'format_id':  f.get('format_id', ''),
                'ext':        f.get('ext', ''),
                'height':     f.get('height'),
                'resolution': f.get('resolution') or (f"{f['height']}p" if f.get('height') else 'audio'),
                'filesize':   f.get('filesize') or f.get('filesize_approx'),
                'vcodec':     f.get('vcodec', 'none'),
                'acodec':     f.get('acodec', 'none'),
                'tbr':        f.get('tbr'),
                'fps':        f.get('fps'),
            })
        fmts.sort(key=lambda x: x.get('height') or 0, reverse=True)
        return jsonify({
            'title':     info.get('title', ''),
            'thumbnail': info.get('thumbnail', ''),
            'duration':  info.get('duration'),
            'uploader':  info.get('uploader', ''),
            'formats':   fmts,
        })
    except Exception as e:
        log.exception('formats error')
        return jsonify({'error': str(e)}), 500
    finally:
        cleanup_file(ck_file)


@app.route('/api/download', methods=['POST', 'OPTIONS'])
def api_download():
    if request.method == 'OPTIONS':
        return '', 204
    data = request.get_json(silent=True) or {}
    url  = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': '请提供 URL'}), 400

    out_dir = data.get('download_path') or DEFAULT_DIR
    task    = mgr.create(url, data.get('title') or url, out_dir)
    tid     = task['id']

    threading.Thread(
        target=do_download, args=(tid, data), daemon=True, name=f'dl-{tid[:8]}'
    ).start()
    return jsonify({'task_id': tid, 'status': 'pending'})


@app.route('/api/task/<tid>')
def api_get_task(tid):
    t = mgr.get(tid)
    return jsonify(t) if t else (jsonify({'error': '任务不存在'}), 404)


@app.route('/api/tasks')
def api_get_tasks():
    return jsonify({'tasks': mgr.all_tasks()[:100]})


@app.route('/api/cancel/<tid>', methods=['POST', 'OPTIONS'])
def api_cancel(tid):
    if request.method == 'OPTIONS':
        return '', 204
    t = mgr.get(tid)
    if not t:
        return jsonify({'error': '任务不存在'}), 404
    mgr.update(tid, status='cancelled', speed='', eta='')
    mgr.kill_proc(tid)
    return jsonify({'success': True})


@app.route('/api/delete/<tid>', methods=['POST', 'OPTIONS'])
def api_delete(tid):
    """永久删除任务记录（黑名单机制，防止重现）"""
    if request.method == 'OPTIONS':
        return '', 204
    mgr.kill_proc(tid)   # 先杀进程
    mgr.delete(tid)      # 再加黑名单删除（会广播 __deleted__ 事件）
    return jsonify({'success': True})


@app.route('/api/open/<tid>', methods=['POST', 'OPTIONS'])
def api_open(tid):
    """在文件管理器中定位下载文件"""
    if request.method == 'OPTIONS':
        return '', 204
    t = mgr.get(tid)
    if not t:
        # 任务已删除时，尝试打开默认下载目录
        target = DEFAULT_DIR
        file_path = ''
    else:
        file_path = t.get('file_path', '')
        target    = t.get('download_path') or DEFAULT_DIR

    try:
        if PLATFORM == 'Darwin':
            if file_path and os.path.isfile(file_path):
                # open -R 在 Finder 中高亮选中文件
                result = subprocess.run(['open', '-R', file_path],
                                        capture_output=True, timeout=10)
            else:
                # 打开文件夹
                folder = target if os.path.isdir(target) else DEFAULT_DIR
                os.makedirs(folder, exist_ok=True)
                result = subprocess.run(['open', folder],
                                        capture_output=True, timeout=10)
            if result.returncode != 0:
                log.warning(f'open failed: {result.stderr}')
                # fallback：直接打开下载目录
                subprocess.Popen(['open', DEFAULT_DIR])

        elif PLATFORM == 'Windows':
            if file_path and os.path.isfile(file_path):
                subprocess.Popen(['explorer', '/select,', os.path.normpath(file_path)])
            else:
                folder = target if os.path.isdir(target) else DEFAULT_DIR
                os.makedirs(folder, exist_ok=True)
                subprocess.Popen(['explorer', os.path.normpath(folder)])

        else:  # Linux
            folder = os.path.dirname(file_path) if file_path and os.path.isfile(file_path) else target
            if not os.path.isdir(folder):
                folder = DEFAULT_DIR
            os.makedirs(folder, exist_ok=True)
            subprocess.Popen(['xdg-open', folder])

        return jsonify({'success': True})
    except Exception as e:
        log.exception('open folder error')
        return jsonify({'error': str(e)}), 500


@app.route('/api/playlist', methods=['POST', 'OPTIONS'])
def api_playlist():
    if request.method == 'OPTIONS':
        return '', 204
    data = request.get_json(silent=True) or {}
    url  = (data.get('url') or '').strip()
    if not url:
        return jsonify({'error': '请提供 URL'}), 400

    ck_file = write_cookie_file(data.get('cookies'))
    try:
        opts = {
            'quiet': True, 'no_warnings': True,
            'extract_flat': 'in_playlist',
            'skip_download': True, 'playlistend': 500,
        }
        if ck_file:           opts['cookiefile'] = ck_file
        if data.get('proxy'): opts['proxy']      = data['proxy']
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
        if not info:
            return jsonify({'error': '无法解析播放列表'}), 400
        entries = [
            {'title': e.get('title', ''), 'url': e.get('url') or e.get('webpage_url', ''), 'duration': e.get('duration')}
            for e in (info.get('entries') or []) if e
        ]
        return jsonify({'title': info.get('title', ''), 'entries': entries, 'playlist_count': len(entries)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
    finally:
        cleanup_file(ck_file)


@app.route('/api/update', methods=['POST'])
def api_update():
    try:
        r = subprocess.run(
            [sys.executable, '-m', 'pip', 'install', '--upgrade', 'yt-dlp'],
            capture_output=True, text=True, timeout=120
        )
        return jsonify({'success': r.returncode == 0, 'log': r.stdout + r.stderr})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ─────────────────────────────────────────────────────────────────────────────
# 工具
# ─────────────────────────────────────────────────────────────────────────────
def fmt_bytes(n):
    for unit in ['B', 'KB', 'MB', 'GB']:
        if n < 1024:
            return f'{n:.1f}{unit}'
        n /= 1024
    return f'{n:.1f}TB'

def fmt_eta(s):
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f'{h}:{m:02d}:{sec:02d}' if h else f'{m}:{sec:02d}'

def clean_err(msg):
    for line in msg.split('\n'):
        if 'ERROR:' in line:
            return line.replace('ERROR:', '').strip()
    return msg[:300]


# ─────────────────────────────────────────────────────────────────────────────
# 启动
# ─────────────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    print(f'\n╔══════════════════════════════════════╗')
    print(f'║  VideoGrab Pro  本地服务 v{VERSION}  ║')
    print(f'╚══════════════════════════════════════╝')
    try:
        print(f'  yt-dlp  版本: {yt_dlp.version.__version__}')
    except Exception:
        pass
    print(f'  系统平台: {PLATFORM}')
    print(f'  服务地址: http://127.0.0.1:{PORT}')
    print(f'  SSE 端点: http://127.0.0.1:{PORT}/events')
    print(f'  下载目录: {DEFAULT_DIR}')
    try:
        r = subprocess.run(['ffmpeg', '-version'], capture_output=True, timeout=5)
        status = '✅ 已安装' if r.returncode == 0 else '⚠️  未找到'
    except Exception:
        status = '⚠️  未找到（合并视频/音频需要它）'
    print(f'  ffmpeg : {status}')
    print()
    os.makedirs(DEFAULT_DIR, exist_ok=True)
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)
