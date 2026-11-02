import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Express, NextFunction, Request, Response } from 'express';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';
import { broadcastToPane, paneCliInfo } from './pty-manager.js';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthRequired()) {
    next();
    return;
  }
  const token = resolveAuthToken(req.headers.cookie, req.headers.authorization);
  if (verifyToken(token)) {
    next();
    return;
  }
  res.status(401).json({ error: '未授权' });
}

/** 只放行音视频容器，避免这个接口变成通用文件读取口子 */
const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.oga': 'audio/ogg',
  '.gif': 'image/gif',
};

interface ByteRange {
  start: number;
  end: number;
}

/** 解析 Range 头；返回 null 表示无 Range，'invalid' 表示不可满足 */
function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return 'invalid';
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return 'invalid';

  let start: number;
  let end: number;
  if (rawStart === '') {
    // 后缀范围: bytes=-N
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
  if (start > end || start >= size) return 'invalid';
  return { start, end: Math.min(end, size - 1) };
}

function resolveVideoPath(raw: string): string {
  const withoutScheme = raw.startsWith('file://') ? raw.slice('file://'.length) : raw;
  return path.resolve(decodeURIComponent(withoutScheme));
}

/** vidopen 打开的播放页（token → 文件），2 小时后过期 */
interface PlaySession {
  filePath: string;
  label: string;
  createdAt: number;
}

const PLAY_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const playSessions = new Map<string, PlaySession>();

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function playerHtml(session: PlaySession): string {
  const name = path.basename(session.filePath);
  const isAudio = (MIME_BY_EXT[path.extname(session.filePath).toLowerCase()] ?? '').startsWith('audio/');
  const src = `/api/video?path=${encodeURIComponent(session.filePath)}`;
  const media = isAudio
    ? `<audio src="${src}" controls autoplay></audio>`
    : `<video src="${src}" controls autoplay playsinline></video>`;
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(name)}</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; background: #101010; color: #ddd;
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  body { display: flex; flex-direction: column; }
  header { padding: 8px 14px; background: #1b1b1b; border-bottom: 1px solid #2c2c2c;
    display: flex; gap: 10px; align-items: baseline; }
  header .name { color: #eee; font-weight: 600; }
  header .dir { color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  main { flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 12px; }
  video, audio { max-width: 100%; max-height: 100%; background: #000; }
  audio { width: min(720px, 100%); }
</style></head>
<body>
  <header><span class="name">${escapeHtml(name)}</span><span class="dir">${escapeHtml(path.dirname(session.filePath))}</span></header>
  <main>${media}</main>
</body></html>`;
}

export function registerVideoRoutes(app: Express): void {
  /**
   * 终端内视频叠加层取流接口（支持 HTTP Range，便于进度条拖动/边下边播）。
   * 需要登录 cookie，与其它 /api 接口一致。
   */
  app.get('/api/video', requireAuth, (req: Request, res: Response) => {
    const raw = typeof req.query.path === 'string' ? req.query.path : '';
    if (!raw) {
      res.status(400).json({ error: '缺少 path' });
      return;
    }

    const filePath = resolveVideoPath(raw);
    const mime = MIME_BY_EXT[path.extname(filePath).toLowerCase()];
    if (!mime) {
      res.status(415).json({ error: '不支持的媒体格式' });
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      res.status(404).json({ error: '文件不存在' });
      return;
    }
    if (!stat.isFile()) {
      res.status(404).json({ error: '不是普通文件' });
      return;
    }

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'private, max-age=0');

    const range = parseRange(req.headers.range, stat.size);
    if (range === 'invalid') {
      res.setHeader('Content-Range', `bytes */${stat.size}`);
      res.status(416).end();
      return;
    }

    if (!range) {
      res.setHeader('Content-Length', String(stat.size));
      fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
      return;
    }

    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    fs.createReadStream(filePath, { start: range.start, end: range.end })
      .on('error', () => res.destroy())
      .pipe(res);
  });

  // 终端里的 vidopen 命令：带窗口 token，校验后给该窗口开一个播放页（新标签页）
  app.post('/api/vid/open', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { token?: unknown; pane?: unknown; path?: unknown };
    const token = typeof body.token === 'string' ? body.token : '';
    const pane = typeof body.pane === 'string' ? body.pane : '';
    const rawPath = typeof body.path === 'string' ? body.path.trim() : '';
    const info = pane ? paneCliInfo(pane) : null;
    if (!info || !token || token.length !== info.token.length) {
      res.status(403).json({ error: '无效的窗口凭据' });
      return;
    }
    const a = Buffer.from(token);
    const b = Buffer.from(info.token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.status(403).json({ error: '无效的窗口凭据' });
      return;
    }
    if (info.connection.kind !== 'local') {
      res.status(400).json({ error: 'vidopen 目前只支持本机窗口（SSH 窗口暂不支持）' });
      return;
    }
    if (!rawPath.startsWith('/')) {
      res.status(400).json({ error: '路径必须是绝对路径' });
      return;
    }
    const filePath = resolveVideoPath(rawPath);
    if (!MIME_BY_EXT[path.extname(filePath).toLowerCase()]) {
      res.status(415).json({ error: `不支持的媒体格式: ${path.extname(filePath) || '(无扩展名)'}` });
      return;
    }
    try {
      if (!fs.statSync(filePath).isFile()) throw new Error('not a file');
    } catch {
      res.status(404).json({ error: `文件不存在: ${filePath}` });
      return;
    }
    const id = crypto.randomBytes(12).toString('base64url');
    playSessions.set(id, { filePath, label: path.basename(filePath), createdAt: Date.now() });
    const url = `/video/${id}`;
    broadcastToPane(pane, { type: 'open_url', sessionId: `pane:${pane}`, data: url });
    res.json({ url, label: path.basename(filePath) });
  });

  // 播放页本身（同一个 HTTPS 端口，复用登录 cookie）
  app.get('/video/:id', requireAuth, (req: Request, res: Response) => {
    const session = playSessions.get(req.params.id);
    if (!session) {
      res.status(404).type('text/plain').send('播放链接已失效，请重新执行 vidopen');
      return;
    }
    res.type('text/html').send(playerHtml(session));
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of [...playSessions]) {
      if (now - session.createdAt > PLAY_SESSION_TTL_MS) playSessions.delete(id);
    }
  }, 10 * 60 * 1000).unref();
}
