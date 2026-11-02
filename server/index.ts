import express from 'express';
import fs from 'fs';
import {
  isAuthRequired,
  issueToken,
  verifyPassword,
  verifyToken,
} from './auth.js';
import {
  authCookieHeader,
  clearAuthCookieHeader,
  resolveAuthToken,
} from './cookies.js';
import { createServer as createHttpServer, type Server } from 'http';
import { createServer as createHttpsServer } from 'https';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  attachPane,
  cleanupPanes,
  detachPane,
  detachWsFromAllPanes,
  retrimAllPaneScrollbacks,
  resizePane,
  writeInput,
} from './pty-manager.js';
import { setTerminalScrollbackLines } from './scrollback-config.js';
import { registerHostMetricsRoutes } from './host-metrics-routes.js';
import { registerSshRoutes } from './ssh-routes.js';
import type { PaneConnection } from './ssh-spawn.js';
import { SharedAppState } from './shared-state.js';
import {
  bootstrapServiceManager,
  registerServiceManagerRoutes,
} from './service-manager-routes.js';
import { registerVideoRoutes } from './video-routes.js';
import { registerDownloadRoutes } from './download-routes.js';
import { registerUploadRoutes } from './upload-routes.js';
import { registerServerFileDownload } from './download-routes.js';
import { startSessionAudio, stopSessionAudio } from './browser-audio.js';
import {
  attachBrowserClient,
  browserInput,
  closeBrowserSession,
  closeBrowserTab,
  detachBrowserClient,
  newBrowserTab,
  NoBrowserError,
  switchBrowserTab,
  setBrowserSessionLimit,
  shutdownAllBrowsers,
  startBrowserSession,
} from './headless-browser.js';
import { registerCodeServerRoutes } from './code-server-routes.js';
import { registerProxyRoutes } from './proxy-routes.js';
import { configurePaneCli } from './pty-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const isProd = process.env.NODE_ENV === 'production';

const sharedState = new SharedAppState();
const syncClients = new Set<WebSocket>();

function applyScrollbackFromSharedState(): void {
  setTerminalScrollbackLines(sharedState.get().terminalScrollbackLines);
  retrimAllPaneScrollbacks();
}

applyScrollbackFromSharedState();

function useHttps(): boolean {
  if (process.env.HTTPS === '0') return false;
  if (process.env.HTTPS === '1') return true;
  const keyPath =
    process.env.TLS_KEY || path.join(__dirname, '../certs/server.key');
  const certPath =
    process.env.TLS_CERT || path.join(__dirname, '../certs/server.crt');
  return fs.existsSync(keyPath) && fs.existsSync(certPath);
}

function loadTlsOptions(): { key: Buffer; cert: Buffer } {
  const keyPath =
    process.env.TLS_KEY || path.join(__dirname, '../certs/server.key');
  const certPath =
    process.env.TLS_CERT || path.join(__dirname, '../certs/server.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.error(
      'HTTPS is enabled but certificate files are missing. Run: ./scripts/gen-cert.sh',
    );
    process.exit(1);
  }
  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

const httpsEnabled = useHttps();
const scheme = httpsEnabled ? 'https' : 'http';

function listLanAddresses(): string[] {
  const urls: string[] = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.push(`${scheme}://${net.address}:${PORT}`);
      }
    }
  }
  return urls;
}

function sendState(ws: WebSocket): void {
  ws.send(
    JSON.stringify({
      type: 'state',
      state: sharedState.get(),
      revision: sharedState.revision,
    }),
  );
}

function broadcastState(): void {
  const payload = JSON.stringify({
    type: 'state',
    state: sharedState.get(),
    revision: sharedState.revision,
  });
  for (const client of syncClients) {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  }
}

const app = express();
// 反代路径不能先做 body 解析：express.json 会把请求体读空，
// 转给上游时就只剩 Content-Length 没有数据，上游一直等 body（表现为页面"加载中…"卡死）
const jsonBody = express.json({ limit: '512kb' });
app.use((req, res, next) => {
  const url = req.url ?? '';
  if (url.startsWith('/svc/') || url.startsWith('/api/ul/')) {
    next();
    return;
  }
  jsonBody(req, res, next);
});

app.get('/api/auth/config', (_req, res) => {
  res.json({ required: isAuthRequired() });
});

app.get('/api/auth/check', (req, res) => {
  const token = resolveAuthToken(req.headers.cookie, req.headers.authorization);
  if (verifyToken(token)) {
    res.json({ ok: true });
    return;
  }
  res.status(401).json({ ok: false });
});

app.post('/api/login', (req, res) => {
  if (!isAuthRequired()) {
    const token = issueToken() ?? 'open';
    res.setHeader('Set-Cookie', authCookieHeader(token, httpsEnabled));
    res.json({ ok: true });
    return;
  }
  const password = String(req.body?.password ?? '');
  if (!verifyPassword(password)) {
    res.status(401).json({ error: '密码错误' });
    return;
  }
  const token = issueToken();
  if (!token) {
    res.status(500).json({ error: '服务未配置密码' });
    return;
  }
  res.setHeader('Set-Cookie', authCookieHeader(token, httpsEnabled));
  res.json({ ok: true });
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', clearAuthCookieHeader(httpsEnabled));
  res.json({ ok: true });
});

registerSshRoutes(app);
registerHostMetricsRoutes(app);
registerServiceManagerRoutes(app);
registerVideoRoutes(app);
registerDownloadRoutes(app);
registerUploadRoutes(app);

const httpServer: Server = httpsEnabled
  ? createHttpsServer(loadTlsOptions(), app)
  : createHttpServer(app);

registerCodeServerRoutes(app, httpServer);
registerProxyRoutes(app, httpServer);

// 本机窗口里的 cs 命令通过这个地址访问服务端（走 127.0.0.1，不经 nginx）
configurePaneCli(`${httpsEnabled ? 'https' : 'http'}://127.0.0.1:${PORT}`);

if (isProd) {
  const clientDir = path.join(__dirname, '../dist/client');
  app.use(express.static(clientDir));
  // 独立的无头浏览器页面（新窗口打开）
  app.get('/browser', (_req, res) => {
    res.sendFile(path.join(clientDir, 'browser.html'));
  });
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

// 自己分发 upgrade：ws 的 WebSocketServer 在 path 不匹配时会直接 abort 掉 socket（400），
// 那样会把 /code/* 的 code-server 代理连接一起打断。
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: { threshold: 256 },
});

httpServer.on('upgrade', (req, socket, head) => {
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname !== '/ws') return; // 其它路径（/code/*）留给 code-server 代理处理
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws, req) => {
  const boundSessions = new Set<string>();
  const ownedBrowsers = new Set<string>();
  let authed = !isAuthRequired();

  const onAuthed = (): void => {
    syncClients.add(ws);
    sendState(ws);
  };

  if (!authed) {
    const cookieToken = resolveAuthToken(req.headers.cookie, undefined);
    if (verifyToken(cookieToken)) {
      authed = true;
      ws.send(JSON.stringify({ type: 'auth_ok' }));
      onAuthed();
    }
  } else {
    onAuthed();
  }

  ws.on('message', (raw) => {
    let msg: {
      type: string;
      sessionId?: string;
      data?: string;
      cols?: number;
      rows?: number;
      token?: string;
      clientPaneId?: string;
      state?: unknown;
      baseRevision?: number;
      baseUrl?: string;
      connection?: unknown;
      width?: number;
      height?: number;
      targetId?: string;
      ok?: boolean;
      kind?: string;
      requestId?: string;
      id?: string;
      [key: string]: unknown;
    };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!authed) {
      if (msg.type === 'auth' && verifyToken(msg.token)) {
        authed = true;
        ws.send(JSON.stringify({ type: 'auth_ok' }));
        onAuthed();
        return;
      }
      ws.send(JSON.stringify({ type: 'auth_fail' }));
      return;
    }

    switch (msg.type) {
      case 'auth':
        return;
      case 'push_state': {
        if (msg.baseRevision == null) {
          sendState(ws);
          break;
        }
        const result = sharedState.tryUpdate(msg.state, msg.baseRevision);
        cleanupPanes(sharedState.collectAllPaneIds());
        if (result.ok) {
          applyScrollbackFromSharedState();
          setBrowserSessionLimit(sharedState.get().browserSessionLimit ?? 3);
          broadcastState();
        } else {
          sendState(ws);
        }
        break;
      }
      case 'attach': {
        const clientPaneId = msg.clientPaneId;
        if (!clientPaneId) return;
        const cols = msg.cols ?? 80;
        const rows = msg.rows ?? 24;
        const connection = (msg as { connection?: PaneConnection }).connection ?? {
          kind: 'local',
        };
        const baseUrl = typeof msg.baseUrl === 'string' ? msg.baseUrl : undefined;
        const sessionId = attachPane(clientPaneId, ws, cols, rows, connection, baseUrl);
        boundSessions.add(sessionId);
        ws.send(
          JSON.stringify({
            type: 'ready',
            sessionId,
            clientPaneId,
          }),
        );
        break;
      }
      case 'input': {
        if (!msg.sessionId || !msg.data) return;
        writeInput(msg.sessionId, msg.data, ws);
        break;
      }
      case 'resize': {
        if (!msg.sessionId || msg.cols == null || msg.rows == null) return;
        resizePane(msg.sessionId, msg.cols, msg.rows);
        break;
      }
      case 'browser_start': {
        const width = typeof msg.width === 'number' ? msg.width : 1280;
        const height = typeof msg.height === 'number' ? msg.height : 800;
        setBrowserSessionLimit(sharedState.get().browserSessionLimit ?? 3);
        void startBrowserSession(width, height, {
          send: (payload) => {
            if (ws.readyState === 1) ws.send(JSON.stringify(payload));
          },
          onDownload: (filePath, name) => {
            // 复制到独立临时目录：会话关闭会删掉整个 user-data-dir（含下载目录）。
            // 注意不能同步复制大文件：会阻塞 Node 事件循环，整个应用都会卡住。
            const dir = path.join(os.tmpdir(), 'bt-browser-downloads');
            const dest = path.join(dir, `${Date.now()}-${name}`);
            fs.mkdirSync(dir, { recursive: true });
            fs.promises
              .copyFile(filePath, dest)
              .then(() => {
                if (ws.readyState === 1) {
                  const registered = registerServerFileDownload(dest, name);
                  if (registered) {
                    ws.send(
                      JSON.stringify({
                        type: 'browser_download',
                        url: registered.url,
                        name: registered.name,
                      }),
                    );
                  }
                }
              })
              .catch(() => {
                const registered = registerServerFileDownload(filePath, name);
                if (registered && ws.readyState === 1) {
                  ws.send(
                    JSON.stringify({
                      type: 'browser_download',
                      url: registered.url,
                      name: registered.name,
                    }),
                  );
                }
              });
            return null; // 异步返回
          },
        })
          .then((info) => {
            ownedBrowsers.add(info.id);
            void attachBrowserClient(info.id, ws);
            if (ws.readyState === 1) {
              ws.send(
                JSON.stringify({
                  type: 'browser_started',
                  id: info.id,
                  width: info.width,
                  height: info.height,
                  requestId: msg.requestId,
                }),
              );
            }
          })
          .catch((e: unknown) => {
            if (ws.readyState !== 1) return;
            if (e instanceof NoBrowserError) {
              ws.send(
                JSON.stringify({
                  type: 'browser_error',
                  code: e.code,
                  message: e.message,
                  downloadUrl: e.downloadUrl,
                  installCommand: e.installCommand,
                  searched: e.searched,
                  requestId: msg.requestId,
                }),
              );
              return;
            }
            ws.send(
              JSON.stringify({
                type: 'browser_error',
                message: e instanceof Error ? e.message : '启动浏览器失败',
                requestId: msg.requestId,
              }),
            );
          });
        break;
      }
      case 'browser_attach': {
        if (typeof msg.id !== 'string') return;
        ownedBrowsers.add(msg.id);
        void attachBrowserClient(msg.id, ws).then((ok) => {
          if (!ok && ws.readyState === 1) {
            ws.send(
              JSON.stringify({
                type: 'browser_closed',
                id: msg.id,
                reason: '浏览器会话已失效，请重新打开',
              }),
            );
          }
        });
        break;
      }
      case 'browser_audio_start': {
        if (typeof msg.id !== 'string') return;
        void startSessionAudio(msg.id, (chunk) => {
          if (ws.readyState === 1) ws.send(chunk, { binary: true });
        }).then((ok) => {
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'browser_audio', id: msg.id, ok }));
          }
        });
        break;
      }
      case 'browser_audio_stop': {
        if (typeof msg.id !== 'string') return;
        stopSessionAudio(msg.id);
        break;
      }
      case 'browser_switch_tab': {
        if (typeof msg.id !== 'string' || typeof msg.targetId !== 'string') return;
        void switchBrowserTab(msg.id, msg.targetId);
        break;
      }
      case 'browser_close_tab': {
        if (typeof msg.id !== 'string' || typeof msg.targetId !== 'string') return;
        void closeBrowserTab(msg.id, msg.targetId);
        break;
      }
      case 'browser_new_tab': {
        if (typeof msg.id !== 'string') return;
        void newBrowserTab(msg.id, typeof msg.url === 'string' ? msg.url : 'about:blank');
        break;
      }
      case 'browser_input': {
        if (typeof msg.id !== 'string') return;
        void browserInput(msg.id, msg as unknown as Record<string, unknown>);
        break;
      }
      case 'browser_close': {
        if (typeof msg.id !== 'string') return;
        ownedBrowsers.delete(msg.id);
        void closeBrowserSession(msg.id, '客户端关闭');
        break;
      }
      case 'detach': {
        if (!msg.sessionId) return;
        boundSessions.delete(msg.sessionId);
        detachPane(msg.sessionId, ws);
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    syncClients.delete(ws);
    for (const id of ownedBrowsers) detachBrowserClient(id);
    ownedBrowsers.clear();
    for (const sessionId of boundSessions) {
      detachPane(sessionId, ws);
    }
    boundSessions.clear();
    detachWsFromAllPanes(ws);
  });
});

httpServer.listen(PORT, HOST, () => {
      console.log(`Server listening on ${scheme}://${HOST}:${PORT}`);
      console.log(`Local: ${scheme}://localhost:${PORT}`);
      const lan = listLanAddresses();
      if (lan.length) {
        console.log('LAN:');
        for (const url of lan) console.log(`  ${url}`);
      }
      if (httpsEnabled) {
        console.log('TLS: self-signed (browser may warn on first visit)');
      }
      console.log('Multi-client sync: enabled (shared layout + terminal sessions)');
      if (!isProd) {
        console.log('Dev: run Vite on :5173 (0.0.0.0) with WebSocket on this port');
      }
      if (isAuthRequired()) {
        console.log('Access password: enabled');
      } else {
        console.warn('Access password: disabled (set ACCESS_PASSWORD or .access_password)');
      }
});

// 先对外监听，再在后台认领已有服务：远端 SSH 不可达时认领会阻塞十几秒，
// 之前放在 listen 之前会让重启后的服务在这段时间内完全连不上。
void bootstrapServiceManager()
  .then(() => {
    console.log('[Service Manager] 嵌入初始化完成');
  })
  .catch((err) => {
    console.error('[Service Manager] 嵌入初始化失败:', err);
  });
