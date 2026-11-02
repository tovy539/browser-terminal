import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import type { Express, NextFunction, Request, Response } from 'express';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';
import {
  broadcastToPane,
  paneCliInfo,
  setDownloadRequestHandler,
  type DownloadRequestInfo,
} from './pty-manager.js';
import { abortUploadByReqId, createUploadSession } from './upload-routes.js';
import { resolveSpawnSpec, type PaneConnection } from './ssh-spawn.js';

const SESSION_TTL_MS = 30 * 60 * 1000;
const PROBE_TIMEOUT_MS = 25_000;

type Source =
  | { kind: 'file'; filePath: string; temp?: boolean }
  | { kind: 'remote-file'; connection: PaneConnection; remotePath: string }
  | { kind: 'remote-tar'; connection: PaneConnection; root: string; names: string[] };

interface DownloadSession {
  source: Source;
  label: string;
  size: number | null;
  createdAt: number;
  /** 供终端里的 download 命令查询进度 */
  state: 'streaming' | 'done' | 'error' | 'cancelled';
  bytes: number;
  error?: string;
  /** 终端里 download 命令的请求 id（用于 Ctrl+C 取消） */
  reqId?: string;
  /** 取消正在进行的传输（关响应/杀 ssh） */
  abort?: () => void;
}

interface Prepared {
  source: Source;
  label: string;
  size: number | null;
}

const sessions = new Map<string, DownloadSession>();

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
  res.status(401).type('text/plain').send('未登录或登录已过期，请刷新页面后重试');
}

function paneTokenOk(pane: string, token: string): boolean {
  const info = pane ? paneCliInfo(pane) : null;
  if (!info || !token || token.length !== info.token.length) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(info.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 文件名转成 Content-Disposition 里的 filename*（UTF-8）与 ASCII 兜底 */
function disposition(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 单引号转义（远端 sh 用） */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** 用系统 tar 把目录/多文件打包成 tar.gz，返回临时文件路径 */
function packTarGz(cwd: string, names: string[], label: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `bt-dl-${crypto.randomBytes(6).toString('hex')}.tar.gz`);
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-czf', tmp, '--', ...names], { cwd });
    let err = '';
    child.stderr.on('data', (d: Buffer) => {
      err += d.toString();
    });
    child.on('error', (e) => reject(new Error(`打包失败: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(tmp);
      else reject(new Error(`打包失败: ${err.trim() || `tar 退出码 ${code}`}（${label}）`));
    });
  });
}

/** 在远端跑一小段 POSIX 脚本拿 stdout（探测文件是否存在/大小） */
function runRemote(
  connection: PaneConnection,
  script: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; out: string; err: string }> {
  const spec = resolveSpawnSpec(connection, { skipSetup: true, command: script });
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, {
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 8192) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 8192) err += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, out: '', err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, out, err });
    });
  });
}

function cleanTemp(source: Source): void {
  if (source.kind === 'file' && source.temp) {
    fs.unlink(source.filePath, () => {
      /* 忽略 */
    });
  }
}

/** 在远端探测每个路径：输出 `D <path>` / `F <size> <path>` / `M <path>` */
function probeScript(paths: string[]): string {
  return paths
    .map(
      (p) =>
        `if [ -d ${q(p)} ]; then printf 'D %s\\n' ${q(p)}; ` +
        `elif [ -f ${q(p)} ]; then printf 'F %s %s\\n' "$(wc -c < ${q(p)} | tr -d ' ')" ${q(p)}; ` +
        `else printf 'M %s\\n' ${q(p)}; fi`,
    )
    .join('\n');
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** 根据窗口连接类型（本机/SSH）解析路径并准备下载源 */
async function prepareDownload(
  connection: PaneConnection,
  rawCwd: string,
  rawPaths: string[],
): Promise<{ ok: true; data: Prepared } | { ok: false; status: number; error: string }> {
  if (connection.kind === 'local') {
    const cwd = rawCwd.startsWith('/') ? rawCwd : '';
    const absPaths = rawPaths.map((p) => (cwd ? path.resolve(cwd, p) : path.resolve(p)));
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(absPaths[0]);
    } catch {
      stat = null;
    }
    if (!stat) return { ok: false, status: 404, error: `文件不存在: ${rawPaths[0]}` };

    if (absPaths.length === 1 && stat.isFile()) {
      return {
        ok: true,
        data: {
          source: { kind: 'file', filePath: absPaths[0] },
          label: path.basename(absPaths[0]),
          size: stat.size,
        },
      };
    }

    const parent = path.dirname(absPaths[0]);
    const sameParent = absPaths.every((n) => path.dirname(n) === parent);
    const root = sameParent ? parent : cwd || process.cwd();
    const rel = absPaths.map((n) => path.relative(root, n));
    const label =
      absPaths.length === 1 ? `${path.basename(absPaths[0])}.tar.gz` : `download-${stamp()}.tar.gz`;
    try {
      const tmp = await packTarGz(root, rel, label);
      return { ok: true, data: { source: { kind: 'file', filePath: tmp, temp: true }, label, size: null } };
    } catch (e) {
      return { ok: false, status: 500, error: e instanceof Error ? e.message : '打包失败' };
    }
  }

  // 远端（SSH 窗口）：路径相对远端当前目录；先用一条远端脚本探测
  const cwd = rawCwd.startsWith('/') ? rawCwd : '/';
  const absPaths = rawPaths.map((p) => {
    if (p.startsWith('/')) return path.posix.normalize(p);
    return path.posix.normalize(`${cwd.replace(/\/+$/, '')}/${p}`);
  });
  const probe = await runRemote(connection, probeScript(absPaths));
  if (!probe.ok) {
    const detail = probe.err.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
    return { ok: false, status: 502, error: `读取远端文件失败: ${detail || 'ssh 执行失败'}` };
  }
  const lines = probe.out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const missing = lines.find((l) => l.startsWith('M '));
  if (missing) return { ok: false, status: 404, error: `文件不存在: ${missing.slice(2)}` };

  if (lines.length === 1 && lines[0].startsWith('F ')) {
    const sizeText = lines[0].split(' ')[1];
    const remotePath = absPaths[0];
    return {
      ok: true,
      data: {
        source: { kind: 'remote-file', connection, remotePath },
        label: path.posix.basename(remotePath),
        size: Number(sizeText) || null,
      },
    };
  }

  const parent = path.posix.dirname(absPaths[0]);
  const sameParent = absPaths.every((p) => path.posix.dirname(p) === parent);
  const root = sameParent ? parent : cwd;
  const names = absPaths.map((p) => path.posix.relative(root, p));
  const label = absPaths.length === 1 ? `${path.posix.basename(absPaths[0])}.tar.gz` : `download-${stamp()}.tar.gz`;
  return { ok: true, data: { source: { kind: 'remote-tar', connection, root, names }, label, size: null } };
}

/** reqId → 下载会话 id：Ctrl+C 时用它定位并取消 */
const byReqId = new Map<string, string>();
/** 还没开始流式传输就按了 Ctrl+C 的请求：准备好后不要再触发下载 */
const cancelledReqIds = new Set<string>();

/** 把一个服务器上的文件登记成可下载会话（无头浏览器下载转存用） */
export function registerServerFileDownload(
  filePath: string,
  name: string,
): { url: string; name: string } | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }
  const out = createSession({
    source: { kind: 'file', filePath },
    label: name,
    size: null,
  });
  return { url: out.url, name: out.name };
}

/** 新建会话并返回下载地址 */
function createSession(data: Prepared, reqId?: string): { url: string; name: string; id: string } {
  const id = crypto.randomBytes(18).toString('base64url');
  sessions.set(id, {
    ...data,
    createdAt: Date.now(),
    state: 'streaming',
    bytes: 0,
    reqId,
  });
  if (reqId) byReqId.set(reqId, id);
  return { id, url: `dl/${id}`, name: data.label };
}

function cancelByReqId(reqId: string): boolean {
  const id = byReqId.get(reqId);
  if (!id) {
    // 可能还在准备阶段（探测/打包）：记下来，准备完就丢弃
    cancelledReqIds.add(reqId);
    setTimeout(() => cancelledReqIds.delete(reqId), 60_000).unref?.();
    return false;
  }
  const session = sessions.get(id);
  if (!session) {
    byReqId.delete(reqId);
    return false;
  }
  session.state = 'cancelled';
  try {
    session.abort?.();
  } catch {
    /* ignore */
  }
  byReqId.delete(reqId);
  return true;
}

function readRequest(body: Record<string, unknown>): { cwd: string; paths: string[] } {
  const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
  const paths = Array.isArray(body.paths)
    ? body.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  return { cwd, paths };
}

/** 终端里的 download 命令（OSC 1339）：只把结果回给"刚敲键盘的那个客户端"，
    避免多端同步时每台电脑都弹下载 */
async function handleDownloadOsc(info: DownloadRequestInfo, payload: string): Promise<void> {
  const target = info.ws;
  if (!target || target.readyState !== 1) return;
  const send = (message: Record<string, unknown>): void => {
    try {
      target.send(JSON.stringify(message));
    } catch {
      /* ignore */
    }
  };
  let req: {
    cwd?: unknown;
    paths?: unknown;
    reqId?: unknown;
    cancel?: unknown;
    action?: unknown;
    subdir?: unknown;
  };
  try {
    req = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as typeof req;
  } catch {
    send({ type: 'download_error', sessionId: info.sessionId, error: '请求格式错误' });
    return;
  }
  if (typeof req.cancel === 'string') {
    // Ctrl+C：取消对应的下载 / 上传
    cancelByReqId(req.cancel);
    abortUploadByReqId(req.cancel);
    return;
  }
  const cwd = typeof req.cwd === 'string' ? req.cwd : '';
  const paths = Array.isArray(req.paths)
    ? req.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
    : [];
  const reqId = typeof req.reqId === 'string' ? req.reqId : '';
  if (req.action === 'upload') {
    // 上传：建会话，让该客户端弹文件选择框
    const subdir = typeof req.subdir === 'string' ? req.subdir : '';
    const created = createUploadSession(info.connection, reqId, cwd, subdir, target, info.sessionId);
    send({
      type: 'upload',
      sessionId: info.sessionId,
      id: created.id,
      reqId,
      dir: created.dir,
    });
    return;
  }
  if (paths.length === 0) {
    send({ type: 'download_error', sessionId: info.sessionId, error: '没有指定文件', reqId });
    return;
  }
  const prepared = await prepareDownload(info.connection, cwd, paths);
  if (cancelledReqIds.delete(reqId)) {
    // 准备期间用户已经 Ctrl+C，丢弃这次下载
    if (prepared.ok) cleanTemp(prepared.data.source);
    return;
  }
  if (!prepared.ok) {
    send({ type: 'download_error', sessionId: info.sessionId, error: prepared.error, reqId });
    return;
  }
  const out = createSession(prepared.data, reqId);
  send({
    type: 'download',
    sessionId: info.sessionId,
    url: out.url,
    name: out.name,
    id: out.id,
    reqId,
  });
}

export function registerDownloadRoutes(app: Express): void {
  setDownloadRequestHandler((info, payload) => {
    void handleDownloadOsc(info, payload);
  });

  // 浏览器端（终端 OSC 1339）调用：已登录即可，窗口 id 由客户端给出
  app.post('/api/dl/prepare', requireAuth, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pane = typeof body.pane === 'string' ? body.pane : '';
    const info = pane ? paneCliInfo(pane) : null;
    if (!info) {
      res.status(404).json({ error: '窗口不存在或已断开' });
      return;
    }
    const { cwd, paths } = readRequest(body);
    if (paths.length === 0) {
      res.status(400).json({ error: '缺少要下载的文件' });
      return;
    }
    const prepared = await prepareDownload(info.connection, cwd, paths);
    if (!prepared.ok) {
      res.status(prepared.status).json({ error: prepared.error });
      return;
    }
    res.json(createSession(prepared.data));
  });

  // 终端里的 download 命令（带窗口 token）：登记会话并通知该窗口的页面
  app.post('/api/dl/open', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === 'string' ? body.token : '';
    const pane = typeof body.pane === 'string' ? body.pane : '';
    if (!paneTokenOk(pane, token)) {
      res.status(403).json({ error: '无效的窗口凭据' });
      return;
    }
    const info = paneCliInfo(pane)!;
    const { cwd, paths } = readRequest(body);
    if (paths.length === 0) {
      res.status(400).json({ error: '缺少要下载的文件' });
      return;
    }
    const prepared = await prepareDownload(info.connection, cwd, paths);
    if (!prepared.ok) {
      res.status(prepared.status).json({ error: prepared.error });
      return;
    }
    const out = createSession(prepared.data);
    broadcastToPane(pane, {
      type: 'download',
      sessionId: `pane:${pane}`,
      url: out.url,
      name: out.name,
    } satisfies Record<string, unknown>);
    res.json(out);
  });

  // 下载进度（终端里的 download 命令轮询用）
  app.get('/api/dl/:id/status', requireAuth, (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: '下载会话不存在或已过期' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      state: session.state,
      bytes: session.bytes,
      total: session.size,
      error: session.error,
      name: session.label,
    });
  });

  // 下载本体：流式返回，带 Content-Disposition，浏览器直接落盘
  app.get('/dl/:id', requireAuth, (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).type('text/plain').send('下载链接已失效，请重新执行 download');
      return;
    }
    const source = session.source;

    if (source.kind === 'file') {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(source.filePath);
      } catch {
        sessions.delete(req.params.id);
        cleanTemp(source);
        res.status(404).type('text/plain').send('文件已不存在，请重新执行 download');
        return;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', disposition(session.label));
      res.setHeader('Content-Length', String(stat.size));
      res.setHeader('Cache-Control', 'no-store');
      const stream = fs.createReadStream(source.filePath);
      session.abort = () => {
        stream.destroy();
        res.destroy();
      };
      stream.on('data', (chunk: string | Buffer) => {
        session.bytes += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
      });
      stream.on('end', () => {
        session.state = 'done';
      });
      stream.on('error', (err: Error) => {
        session.state = 'error';
        session.error = err.message;
        res.destroy();
      });
      res.on('close', () => {
        if (session.state === 'streaming') session.state = 'error';
        cleanTemp(source);
        if (session.reqId) byReqId.delete(session.reqId);
        setTimeout(() => sessions.delete(req.params.id), 60_000);
      });
      stream.pipe(res);
      return;
    }

    // 远端文件 / 远端 tar：起一条 ssh 把数据流回浏览器（不要 PTY，避免污染二进制）
    const script =
      source.kind === 'remote-file'
        ? `exec cat -- ${q(source.remotePath)}`
        : `exec tar -czf - -C ${q(source.root)} -- ${source.names.map(q).join(' ')}`;
    const spec = resolveSpawnSpec(source.connection, { skipSetup: true, command: script });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', disposition(session.label));
    if (session.size !== null) res.setHeader('Content-Length', String(session.size));
    res.setHeader('Cache-Control', 'no-store');
    const child = spawn(spec.file, spec.args, {
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    session.abort = () => {
      if (!child.killed) child.kill('SIGTERM');
      res.destroy();
    };
    child.stdout.on('data', (chunk: Buffer) => {
      session.bytes += chunk.byteLength;
    });
    child.stdout.pipe(res);
    child.stderr.on('data', (d: Buffer) => {
      session.error = d.toString().trim().split('\n').slice(-1)[0] || session.error;
    });
    child.on('close', (code) => {
      session.state = code === 0 || code === null ? 'done' : 'error';
      if (code !== 0 && !session.error) session.error = `ssh 退出码 ${code}`;
    });
    res.on('close', () => {
      if (!child.killed) child.kill('SIGTERM');
      if (session.state === 'streaming') session.state = 'error';
      if (session.reqId) byReqId.delete(session.reqId);
      setTimeout(() => sessions.delete(req.params.id), 60_000);
    });
    child.on('error', (err: Error) => {
      session.state = 'error';
      session.error = err.message;
      res.destroy();
    });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of [...sessions]) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(id);
        cleanTemp(session.source);
      }
    }
  }, 60 * 1000).unref();
}
