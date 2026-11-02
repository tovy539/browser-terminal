import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import type { Express, NextFunction, Request, Response } from 'express';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';
import { resolveSpawnSpec, type PaneConnection } from './ssh-spawn.js';

const SESSION_TTL_MS = 30 * 60 * 1000;

interface UploadSession {
  id: string;
  reqId: string;
  /** 触发上传的客户端连接：取消时通知它停止写 stdin */
  ws: import('ws').WebSocket | null;
  /** 窗口会话 id（客户端按它过滤消息） */
  sessionId: string;
  connection: PaneConnection;
  remote: boolean;
  /** 目标目录（本地绝对路径 / 远端 POSIX 路径） */
  dir: string;
  state: 'waiting' | 'streaming' | 'done' | 'error' | 'cancelled';
  bytes: number;
  files: string[];
  error?: string;
  /** 取消当前正在写入的文件 */
  abort?: () => void;
  createdAt: number;
}

const sessions = new Map<string, UploadSession>();
const byReqId = new Map<string, string>();

export function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  res.status(401).json({ error: '未登录或登录已过期，请刷新页面后重试' });
}

/** 远端跑一条命令，等它结束 */
function runRemote(
  connection: PaneConnection,
  script: string,
  timeoutMs = 25_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  const spec = resolveSpawnSpec(connection, { skipSetup: true, command: script });
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, { env: spec.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < 4096) out += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < 4096) err += d.toString();
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

/** 终端里执行 upload：建一个上传会话，等浏览器把文件逐个发过来 */
export function createUploadSession(
  connection: PaneConnection,
  reqId: string,
  cwd: string,
  subdir: string,
  ws: import('ws').WebSocket | null = null,
  sessionId = '',
): { id: string; dir: string } {
  const remote = connection.kind !== 'local';
  let dir: string;
  if (remote) {
    const base = cwd.startsWith('/') ? cwd : '/';
    dir = path.posix.resolve(base, subdir || '.');
  } else {
    const base = cwd.startsWith('/') ? cwd : process.cwd();
    dir = path.resolve(base, subdir || '.');
  }
  const id = crypto.randomBytes(18).toString('base64url');
  sessions.set(id, {
    id,
    reqId,
    ws,
    sessionId,
    connection,
    remote,
    dir,
    state: 'waiting',
    bytes: 0,
    files: [],
    createdAt: Date.now(),
  });
  byReqId.set(reqId, id);
  return { id, dir };
}

function markCancelled(session: UploadSession): void {
  session.state = 'cancelled';
  try {
    session.abort?.();
  } catch {
    /* ignore */
  }
  byReqId.delete(session.reqId);
  // 通知浏览器端：立刻中止 XHR，并且不要再往终端 stdin 写进度
  if (session.ws && session.ws.readyState === 1) {
    try {
      session.ws.send(
        JSON.stringify({
          type: 'upload_cancel',
          sessionId: session.sessionId,
          id: session.id,
          reqId: session.reqId,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}

/** Ctrl+C：取消对应的上传 */
export function abortUploadByReqId(reqId: string): boolean {
  const id = byReqId.get(reqId);
  if (!id) return false;
  const session = sessions.get(id);
  if (!session) {
    byReqId.delete(reqId);
    return false;
  }
  markCancelled(session);
  return true;
}

/** 文件名安全校验：只允许单段文件名 */
function safeName(raw: string): string | null {
  let name = raw.trim();
  if (!name) return null;
  name = path.basename(name);
  if (name === '' || name === '.' || name === '..') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  if (Buffer.byteLength(name, 'utf8') > 255) return null;
  return name;
}

export function registerUploadRoutes(app: Express): void {
  // 浏览器把选中的文件逐个 POST 过来（body 是文件原始字节，不能先被 JSON 解析）
  app.post('/api/ul/:id/file', requireAuth, async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: '上传会话不存在或已过期' });
      return;
    }
    if (session.state === 'cancelled') {
      res.status(410).json({ error: '上传已取消' });
      return;
    }
    const rawName = req.header('x-bt-name') ?? '';
    let decoded = rawName;
    try {
      decoded = decodeURIComponent(rawName);
    } catch {
      /* 保留原值 */
    }
    const name = safeName(decoded);
    if (!name) {
      res.status(422).json({ error: `文件名无效: ${decoded || '(空)'}` });
      return;
    }
    const target = session.remote
      ? path.posix.join(session.dir, name)
      : path.join(session.dir, name);

    // 目标目录可能不存在（upload <子目录> 的情况）
    if (session.remote) {
      const made = await runRemote(
        session.connection,
        `mkdir -p ${q(session.dir)}`,
      );
      if (!made.ok) {
        res.status(500).json({ error: `创建目录失败: ${made.err.trim() || session.dir}` });
        return;
      }
    } else {
      try {
        fs.mkdirSync(session.dir, { recursive: true });
      } catch (e) {
        res.status(500).json({ error: `创建目录失败: ${e instanceof Error ? e.message : ''}` });
        return;
      }
    }

    session.state = 'streaming';
    session.createdAt = Date.now();
    let finished = false;
    let error: string | null = null;
    let written = 0;

    const reply = (status: number, body: Record<string, unknown>): void => {
      if (finished) return;
      finished = true;
      session.abort = undefined;
      if (res.writableEnded || res.destroyed) return;
      res.status(status).json(body);
    };

    const fail = (message: string): void => {
      if (finished) return;
      error = message;
      if (session.remote) {
        void runRemote(session.connection, `rm -f ${q(target)}`);
      } else {
        fs.unlink(target, () => {
          /* ignore */
        });
      }
      reply(500, { error: message });
    };

    if (session.remote) {
      const spec = resolveSpawnSpec(session.connection, {
        skipSetup: true,
        command: `mkdir -p ${q(session.dir)} && cat > ${q(target)}`,
      });
      const child = spawn(spec.file, spec.args, {
        env: spec.env,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      session.abort = () => {
        if (!child.killed) child.kill('SIGTERM');
        req.unpipe();
        req.destroy();
        void runRemote(session.connection, `rm -f ${q(target)}`);
      };
      child.on('error', (err) => fail(err.message));
      child.on('close', (code) => {
        if (error) return;
        if (code === 0) {
          session.files.push(name);
          session.bytes += written;
          reply(200, { ok: true, name, size: written });
        } else {
          fail(stderr.trim().split('\n').slice(-1)[0] || `ssh 退出码 ${code}`);
        }
      });
      req.on('data', (chunk: Buffer) => {
        written += chunk.byteLength;
      });
      req.pipe(child.stdin);
    } else {
      const stream = fs.createWriteStream(target);
      session.abort = () => {
        stream.destroy();
        req.unpipe();
        req.destroy();
        fs.unlink(target, () => {
          /* ignore */
        });
      };
      stream.on('error', (err) => fail(err.message));
      stream.on('finish', () => {
        if (error) return;
        session.files.push(name);
        session.bytes += written;
        reply(200, { ok: true, name, size: written });
      });
      req.on('data', (chunk: Buffer) => {
        written += chunk.byteLength;
      });
      req.pipe(stream);
    }
  });

  app.get('/api/ul/:id/status', requireAuth, (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      res.status(404).json({ error: '上传会话不存在或已过期' });
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      state: session.state,
      bytes: session.bytes,
      files: session.files,
      dir: session.dir,
      error: session.error,
    });
  });

  // 浏览器传完后收尾（可选）：把会话标成完成，方便 CLI 侧查询
  app.post('/api/ul/:id/done', requireAuth, (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (session) {
      session.state = session.state === 'cancelled' ? 'cancelled' : 'done';
      byReqId.delete(session.reqId);
      setTimeout(() => sessions.delete(session.id), 60_000).unref?.();
    }
    res.json({ ok: true });
  });

  app.post('/api/ul/:id/cancel', requireAuth, (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (session) markCancelled(session);
    res.json({ ok: true });
  });

  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of [...sessions]) {
      if (now - session.createdAt > SESSION_TTL_MS) {
        if (session.state === 'streaming') markCancelled(session);
        sessions.delete(id);
        byReqId.delete(session.reqId);
      }
    }
  }, 60 * 1000).unref();
}
