import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import type { Express, NextFunction, Request, Response } from 'express';
import type { Server } from 'http';
import crypto from 'crypto';
import httpProxy from 'http-proxy';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';
import { getSshProfile } from './ssh-profiles.js';
import { resolveSpawnSpec, wrapRemoteSh, type PaneConnection } from './ssh-spawn.js';
import { broadcastToPane, paneCliInfo } from './pty-manager.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根目录（.run/ 就在它下面） */
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * code-server 集成：在"当前标签页指向的设备"上跑一个 code-server，
 * 通过本服务的 HTTPS 端口按路径前缀反代给浏览器（同一 origin，复用登录 cookie）。
 *
 * 本机：直接 spawn code-server，绑 127.0.0.1:<随机端口>。
 * SSH：在远端 nohup 起 code-server（Open VSX 作为插件市场），再 ssh -L 把远端端口
 *      转发到本机，然后同样按路径前缀反代。
 */

const CODE_SERVER_BIN = process.env.CODE_SERVER_BIN || 'code-server';
/** 显式指定 Open VSX 插件市场（code-server 默认就是它，这里写明避免受环境影响） */
const OPEN_VSX_GALLERY =
  '{"serviceUrl":"https://open-vsx.org/api","cacheUrl":"https://open-vsx.org/api/-/version"}';
const DATA_ROOT = path.join(REPO_ROOT, '.run', 'code-server');
const READY_TIMEOUT_LOCAL_MS = 40_000;
const READY_TIMEOUT_REMOTE_MS = 120_000;
const IDLE_STOP_MS = 60 * 60 * 1000;

interface CodeInstance {
  key: string;
  target: 'local' | 'remote';
  label: string;
  /** 本机反代目标端口（本地实例=code-server 端口；远端实例=ssh -L 的本地端口） */
  port: number;
  remotePort?: number;
  /** 打开哪个目录：本机用 $HOME，远端用远端 $HOME */
  folder: string;
  procs: ChildProcess[];
  ready: boolean;
  startError?: string;
  lastUsed: number;
  startPromise: Promise<void> | null;
}

const instances = new Map<string, CodeInstance>();

const proxy = httpProxy.createProxyServer({ ws: true, changeOrigin: true, xfwd: false });

/** 定长比较，避免时序侧信道 */
function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
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
  res.status(401).json({ error: '未授权' });
}

function targetKey(connection: PaneConnection | undefined): string {
  if (!connection || connection.kind === 'local') return 'local';
  return `ssh-${connection.profileId}`;
}

function targetLabel(connection: PaneConnection | undefined): string {
  if (!connection || connection.kind === 'local') return '本机';
  const profile = getSshProfile(connection.profileId);
  return profile ? profile.name : 'SSH';
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('无法分配端口'))));
    });
  });
}

function codeServerEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EXTENSIONS_GALLERY: OPEN_VSX_GALLERY,
    // 别让服务端自己的 PORT 把 code-server 的监听端口顶掉
  };
  delete env.PORT;
  return env;
}

/** 单次探活（用于判断已有实例是否还活着——远端可能被 OOM 杀掉了） */
function probeHealth(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/healthz', timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

function waitHealthy(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = (): void => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/healthz', timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve(true);
          else retry();
        },
      );
      req.on('error', retry);
      req.on('timeout', () => {
        req.destroy();
        retry();
      });
    };
    const retry = (): void => {
      if (Date.now() > deadline) resolve(false);
      else setTimeout(tick, 500);
    };
    tick();
  });
}

async function startInstance(inst: CodeInstance, connection: PaneConnection | undefined): Promise<void> {
  inst.port = await freePort();
  const dataDir = path.join(DATA_ROOT, inst.key);
  // 本地实例的日志文件就写在这个目录里，首次运行必须先建出来，否则 openSync 会 ENOENT
  fs.mkdirSync(dataDir, { recursive: true });
  const folder = process.env.HOME || REPO_ROOT;

  if (inst.target === 'local') {
    const env = { ...codeServerEnv(), HOME: process.env.HOME || '/' };
    const child = spawn(
      CODE_SERVER_BIN,
      [
        '--auth', 'none',
        '--bind-addr', `127.0.0.1:${inst.port}`,
        '--disable-telemetry',
        '--disable-update-check',
        '--disable-workspace-trust',
        '--user-data-dir', path.join(dataDir, 'data'),
        '--extensions-dir', path.join(dataDir, 'extensions'),
        folder,
      ],
      { env, stdio: ['ignore', 'ignore', fs.openSync(path.join(dataDir, 'code-server.log'), 'a')] },
    );
    inst.procs.push(child);
    child.on('error', (err) => {
      inst.ready = false;
      if (instances.get(inst.key) === inst) instances.delete(inst.key);
      inst.startError = `无法执行 ${CODE_SERVER_BIN}：${err.message}`;
    });
    child.on('exit', () => {
      if (instances.get(inst.key) === inst) {
        inst.ready = false;
        instances.delete(inst.key);
      }
    });
    if (!(await waitHealthy(inst.port, READY_TIMEOUT_LOCAL_MS))) {
      throw new Error(inst.startError || 'code-server 启动超时（本机）');
    }
    inst.ready = true;
    return;
  }

  // 远端：先确认装了 code-server
  const ssh = connection as Extract<PaneConnection, { kind: 'ssh' }>;
  const spec = resolveSpawnSpec(ssh, { skipSetup: true });
  const discover = [
    'BIN="$(command -v code-server 2>/dev/null)"',
    'if [ -z "$BIN" ]; then for p in "$HOME/.local/bin/code-server" /usr/local/bin/code-server /usr/bin/code-server; do if [ -x "$p" ]; then BIN="$p"; break; fi; done; fi',
    'if [ -n "$BIN" ]; then echo "BIN=$BIN"; else echo NOTFOUND; fi',
  ].join('; ');
  const found = await sshRun(spec, discover, 20_000);
  const m = /^BIN=(.+)$/m.exec(found);
  if (!m || m[1].trim().endsWith('NOTFOUND')) {
    throw new Error(
      '远端未安装 code-server。可在远端执行：curl -fsSL https://code-server.dev/install.sh | sh',
    );
  }
  if (process.env.CODE_DEBUG) console.log('[code] remote discover raw=', JSON.stringify(found.slice(0, 200)));
  const remoteBin = m[1].trim().replace(/'/g, `'\\''`);
  if (process.env.CODE_DEBUG) console.log('[code] remoteBin=', JSON.stringify(remoteBin));

  const remoteHome = (await sshRun(spec, 'echo "$HOME"', 15_000).catch(() => '')).trim();
  if (remoteHome.startsWith('/')) inst.folder = remoteHome;

  // 同设备可能已经有遗留实例（App 重启/上次失败留下的），先按 key 清掉，避免把内存吃满。
  // 注意：ssh 会话自己的 shell 命令行里也含这个串，必须排除 $$（以及 pgrep 自己）。
  if (inst.key !== 'local') {
    const cleanup = [
      `for pid in $(pgrep -f 'code-server-${inst.key}' 2>/dev/null); do [ "$pid" = "$$" ] && continue; kill "$pid" 2>/dev/null; done`,
      'sleep 0.3',
      'echo cleaned',
    ].join('; ');
    await sshRun(spec, cleanup, 20_000).catch(() => '');
  }

  inst.remotePort = await freePort();
  const remoteDir = `$HOME/.local/share/code-server-${inst.key}`;
  const remoteCmd = [
    `d="${remoteDir}"`,
    'mkdir -p "$d"',
    `EXTENSIONS_GALLERY='${OPEN_VSX_GALLERY}' nohup '${remoteBin}' --auth none --bind-addr 127.0.0.1:${inst.remotePort} --disable-telemetry --disable-update-check --disable-workspace-trust --user-data-dir "$d/data" --extensions-dir "$d/extensions" ~ >> "$d/code-server.log" 2>&1 &`,
    'echo $! > "$d/pid"',
    'echo started',
  ].join('\n');
  const started = await sshRun(spec, remoteCmd, 30_000);
  if (!started.includes('started')) throw new Error(`远端 code-server 启动失败：${started.slice(0, 200)}`);
  inst.procs.push({ remotePidMarker: true } as unknown as ChildProcess);

  // ssh -L 把远端端口转发到本机
  const args = [...spec.args];
  const host = args.pop();
  if (!host) throw new Error('SSH 参数异常');
  const tunnel = spawn(
    spec.file,
    [...args, '-N', '-L', `127.0.0.1:${inst.port}:127.0.0.1:${inst.remotePort}`, host],
    { env: spec.env, stdio: ['ignore', 'ignore', 'ignore'] },
  );
  inst.procs.push(tunnel);
  tunnel.on('error', (err) => {
    inst.startError = `ssh 端口转发失败：${err.message}`;
  });
  tunnel.on('exit', () => {
    if (instances.get(inst.key) === inst) {
      inst.ready = false;
      instances.delete(inst.key);
    }
  });
  if (!(await waitHealthy(inst.port, READY_TIMEOUT_REMOTE_MS))) {
    const tail = await sshRun(
      spec,
      `tail -n 4 "${remoteDir}/code-server.log" 2>/dev/null | tr '\\n' ' '`,
      15_000,
    ).catch(() => '');
    throw new Error(
      inst.startError ||
        `code-server 启动超时（远端）。远端日志：${tail.trim().slice(0, 300) || '（空）'}`,
    );
  }
  inst.ready = true;
}

/** 跑一条远端命令，收集 stdout（用 spec 里的 ssh/sshpass 参数） */
function sshRun(
  spec: { file: string; args: string[]; env: NodeJS.ProcessEnv },
  command: string,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, [...spec.args, wrapRemoteSh(command)], {
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('远端命令超时'));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out || err);
    });
  });
}

async function ensureInstance(connection: PaneConnection | undefined): Promise<CodeInstance> {
  const key = targetKey(connection);
  const existing = instances.get(key);
  if (existing?.ready && (await probeHealth(existing.port))) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing?.ready) {
    // 进程已经不响应了（例如远端内存不够被 OOM 杀掉），清掉重来
    stopInstance(existing, connection);
  }
  if (existing?.startPromise) {
    await existing.startPromise;
    existing.lastUsed = Date.now();
    return existing;
  }
  const inst: CodeInstance =
    existing ??
    {
      key,
      target: connection?.kind === 'ssh' ? 'remote' : 'local',
      label: targetLabel(connection),
      port: 0,
      folder: process.env.HOME || '/',
      procs: [],
      ready: false,
      lastUsed: Date.now(),
      startPromise: null,
    };
  instances.set(key, inst);
  inst.startPromise = startInstance(inst, connection).catch((e) => {
    instances.delete(key);
    throw e;
  });
  try {
    await inst.startPromise;
  } finally {
    inst.startPromise = null;
  }
  return inst;
}

function stopInstance(inst: CodeInstance, connection?: PaneConnection): void {
  instances.delete(inst.key);
  for (const p of inst.procs) {
    const marker = p as unknown as { remotePidMarker?: boolean };
    if (marker.remotePidMarker) continue;
    try {
      p.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  if (inst.target === 'remote' && connection) {
    const spec = resolveSpawnSpec(connection, { skipSetup: true });
    const kill = [
      `for pid in $(pgrep -f 'code-server-${inst.key}' 2>/dev/null); do [ "$pid" = "$$" ] && continue; kill "$pid" 2>/dev/null; done`,
      'echo done',
    ].join('; ');
    void sshRun(spec, kill, 10_000).catch(() => undefined);
  }
}

/** 把 code-server 返回的绝对 Location/重定向改写到我们的前缀下 */
function rewriteLocation(location: string, key: string, port: number): string {
  const origin = `http://127.0.0.1:${port}`;
  if (location.startsWith(origin)) {
    return `/code/${key}${location.slice(origin.length)}`;
  }
  return location;
}

export function registerCodeServerRoutes(app: Express, server: Server): void {
  app.post('/api/code/open', requireAuth, async (req, res) => {
    const body = (req.body ?? {}) as { connection?: unknown };
    const connection = parseConnection(body.connection);
    try {
      const inst = await ensureInstance(connection);
      const folder = inst.folder ? `?folder=${encodeURIComponent(inst.folder)}` : '';
      res.json({ url: `/code/${inst.key}/${folder}`, label: inst.label });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : '启动失败' });
    }
  });

  // code-server 会校验 WS 的 Origin 与 Host 是否同源：我们把两者都改成内部地址，避免 403/1006
  const alignOrigin = (
    proxyReq: http.ClientRequest,
    req: http.IncomingMessage,
  ): void => {
    const port = (req as unknown as { codePort?: number }).codePort;
    if (port && proxyReq.getHeader('origin')) {
      proxyReq.setHeader('origin', `http://127.0.0.1:${port}`);
    }
  };
  proxy.on('proxyReq', alignOrigin);
  proxy.on('proxyReqWs', alignOrigin);

  // 终端里的 cs 命令：带上该窗口注入的 token，按窗口的目标设备 + 当前目录打开 code-server
  app.post('/api/code/open-pane', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      token?: unknown;
      pane?: unknown;
      folder?: unknown;
      file?: unknown;
    };
    const token = typeof body.token === 'string' ? body.token : '';
    const pane = typeof body.pane === 'string' ? body.pane : '';
    const wantFile = typeof body.file === 'string' ? body.file.trim() : '';
    // 跟的是文件时，打开它所在目录，并用 payload 打开该文件
    const folder =
      typeof body.folder === 'string'
        ? body.folder.trim()
        : wantFile
          ? path.dirname(wantFile)
          : '';
    const info = pane ? paneCliInfo(pane) : null;
    if (!info || !token || token.length !== info.token.length || !timingSafeEqual(token, info.token)) {
      res.status(403).json({ error: '无效的窗口凭据（cs 只能在本机窗口中运行）' });
      return;
    }
    if (!folder || !folder.startsWith('/') || folder.includes('\0')) {
      res.status(400).json({ error: '目录必须是绝对路径' });
      return;
    }
    if (!folder.startsWith('/') || folder.includes('\0')) {
      res.status(400).json({ error: '目录必须是绝对路径' });
      return;
    }
    if (wantFile && (!wantFile.startsWith('/') || wantFile.includes('\0'))) {
      res.status(400).json({ error: '文件必须是绝对路径' });
      return;
    }
    if (info.connection.kind === 'local') {
      try {
        if (!fs.statSync(folder).isDirectory()) throw new Error('not a directory');
        if (wantFile && !fs.statSync(wantFile).isFile()) throw new Error('not a file');
      } catch {
        res.status(400).json({ error: `路径不存在: ${wantFile || folder}` });
        return;
      }
    }
    try {
      const inst = await ensureInstance(info.connection);
      const url = `/code/${inst.key}/?folder=${encodeURIComponent(folder)}`;
      broadcastToPane(pane, {
        type: 'code_open',
        sessionId: `pane:${pane}`,
        data: url,
        file: wantFile || undefined,
      });
      res.json({ url, label: inst.label, folder, file: wantFile || undefined });
    } catch (e) {
      res.status(502).json({ error: e instanceof Error ? e.message : '启动失败' });
    }
  });

  proxy.on('proxyRes', (proxyRes, req) => {
    const meta = (req as Request & { codeKey?: string; codePort?: number });
    const loc = proxyRes.headers.location;
    if (loc && meta.codeKey && meta.codePort) {
      proxyRes.headers.location = rewriteLocation(loc, meta.codeKey, meta.codePort);
    }
    // 允许同源 iframe/新标签打开
    delete proxyRes.headers['x-frame-options'];
    delete proxyRes.headers['content-security-policy'];
  });

  app.use('/code/:key', (req: Request, res: Response) => {
    const inst = instances.get(req.params.key);
    if (!inst?.ready) {
      res.status(503).send('code-server 未运行，请回到终端重新点击按钮');
      return;
    }
    inst.lastUsed = Date.now();
    (req as Request & { codeKey?: string; codePort?: number }).codeKey = inst.key;
    (req as Request & { codeKey?: string; codePort?: number }).codePort = inst.port;
    proxy.web(req, res, { target: `http://127.0.0.1:${inst.port}` }, (err) => {
      if (!res.headersSent) res.status(502).end(`代理失败: ${err.message}`);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/code/')) return;
    if (process.env.CODE_DEBUG) console.log('[code] upgrade', url.slice(0, 80));
    if (isAuthRequired()) {
      const token = resolveAuthToken(req.headers.cookie, undefined);
      if (!verifyToken(token)) {
        socket.destroy();
        return;
      }
    }
    const key = url.split('/')[2] ?? '';
    const inst = instances.get(key);
    if (process.env.CODE_DEBUG) console.log('[code] key=', key, 'ready=', !!inst?.ready);
    if (!inst?.ready) {
      socket.destroy();
      return;
    }
    inst.lastUsed = Date.now();
    (req as Request & { codeKey?: string; codePort?: number }).codeKey = inst.key;
    (req as Request & { codeKey?: string; codePort?: number }).codePort = inst.port;
    // 升级请求不经过 express，路径里的 /code/<key> 前缀要自己剥掉再转给 code-server
    req.url = url.slice(`/code/${key}`.length) || '/';
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${inst.port}` }, (err) => {
      if (process.env.CODE_DEBUG) console.log('[code] ws proxy error', err.message);
      socket.destroy();
    });
  });

  // 闲置回收：一小时没人访问就关掉，避免一直占内存
  setInterval(() => {
    const now = Date.now();
    for (const inst of [...instances.values()]) {
      if (now - inst.lastUsed > IDLE_STOP_MS) stopInstance(inst);
    }
  }, 5 * 60 * 1000).unref();
}

function parseConnection(raw: unknown): PaneConnection | undefined {
  if (!raw || typeof raw !== 'object') return { kind: 'local' };
  const c = raw as Record<string, unknown>;
  if (c.kind === 'local') return { kind: 'local' };
  if (c.kind === 'ssh' && typeof c.profileId === 'string' && c.profileId) {
    return {
      kind: 'ssh',
      profileId: c.profileId,
      sessionPassword:
        typeof c.sessionPassword === 'string' ? c.sessionPassword : undefined,
    };
  }
  return { kind: 'local' };
}
