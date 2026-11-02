import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pty from 'node-pty';
import type { WebSocket } from 'ws';
import {
  getScrollbackByteBudget,
  trimScrollbackString,
} from './scrollback-config.js';
import { type PaneConnection, resolveSpawnSpec } from './ssh-spawn.js';
import { ensureRemoteBin } from './remote-bin.js';

/** PTY 输出合并后再广播，减轻 TUI 刷屏时的 JSON/WebSocket 开销 */
const OUTPUT_COALESCE_MS = 12;
const OUTPUT_COALESCE_MAX_CHARS = 256 * 1024;

interface PaneSession {
  paneId: string;
  sessionId: string;
  pty: pty.IPty;
  wsSet: Set<WebSocket>;
  scrollback: string;
  connection: PaneConnection;
  cols: number;
  rows: number;
  scrollbackTrimTimer?: ReturnType<typeof setTimeout>;
  /** 全屏 TUI（备用屏）期间不累积 scrollback，避免 OpenCode 等占满内存 */
  altScreen: boolean;
  outputCoalesce: string;
  outputCoalesceTimer?: ReturnType<typeof setTimeout>;
  /** 本机窗口注入的 cs 命令凭据（ssh 窗口没有） */
  cliToken?: string;
  /** 最近一次向该窗口输入数据的客户端连接（download 请求只回给它，避免多端重复触发） */
  lastInputWs?: import('ws').WebSocket | null;
}

const paneSessions = new Map<string, PaneSession>();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 仓库里的 bin/：imgcat / vidcat / termvid / cs 的入口，终端会话会把它加到 PATH 最前 */
const REPO_BIN_DIR = path.resolve(__dirname, '..', 'bin');

/** 由 index.ts 启动时设置：本机窗口里 cs 命令要访问的服务端地址 */
let paneCliOrigin: string | null = null;

export function configurePaneCli(origin: string): void {
  paneCliOrigin = origin;
}

/** 查某个窗口的 cs 凭据与目标设备 */
export function paneCliInfo(
  paneId: string,
): { token: string; connection: PaneConnection } | null {
  const session = paneSessions.get(paneId);
  if (!session?.cliToken) return null;
  return { token: session.cliToken, connection: session.connection };
}

/** 给某个窗口的客户端推消息 */
export function broadcastToPane(paneId: string, payload: Record<string, unknown>): void {
  const session = paneSessions.get(paneId);
  if (session) broadcast(session, payload);
}

function scheduleScrollbackTrim(session: PaneSession): void {
  if (session.scrollbackTrimTimer) return;
  session.scrollbackTrimTimer = setTimeout(() => {
    session.scrollbackTrimTimer = undefined;
    session.scrollback = trimScrollbackString(session.scrollback);
  }, 400);
}

function updateAltScreenFromChunk(session: PaneSession, data: string): void {
  if (
    data.includes('\x1b[?1049h') ||
    data.includes('\x1b[?1047h') ||
    data.includes('\x1b[?47h')
  ) {
    session.altScreen = true;
    session.scrollback = '';
    if (session.scrollbackTrimTimer) {
      clearTimeout(session.scrollbackTrimTimer);
      session.scrollbackTrimTimer = undefined;
    }
  }
  if (
    data.includes('\x1b[?1049l') ||
    data.includes('\x1b[?1047l') ||
    data.includes('\x1b[?47l')
  ) {
    session.altScreen = false;
  }
}

/** 整屏刷新类输出写入 scrollback 无意义且极耗内存 */
function looksLikeFullTuiRedraw(data: string): boolean {
  if (data.length < 4096 || !data.includes('\x1b[')) return false;
  return (
    data.includes('\x1b[2J') ||
    data.includes('\x1b[H') ||
    data.includes('\x1b[1;1H') ||
    data.includes('\x1b[?25l')
  );
}

/**
 * 终端内视频叠加层（OSC 9998）是瞬时 UI：重连时回放旧序列会让视频"自己又弹出来"，
 * 也会白占 scrollback 体积，因此不进 scrollback。
 */
/** 临时控制序列（不进 scrollback，否则重连回放会重复触发）：
    9998 = 终端内提示，1339 = download 请求 */
function stripTransientOsc(data: string): string {
  if (!data.includes('\x1b]9998;') && !data.includes('\x1b]1339;')) return data;
  return data
    .replace(/\x1b\](?:9998|1339);[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\](?:9998|1339);[^\x07\x1b]*$/g, '');
}

function appendScrollback(session: PaneSession, data: string): void {
  if (session.altScreen || looksLikeFullTuiRedraw(data)) return;
  session.scrollback += stripTransientOsc(data);
  const budget = getScrollbackByteBudget();
  // 留 25% 余量再裁：裁剪本身要扫一遍字符串，避免每个小块输出都触发
  if (session.scrollback.length > budget + (budget >> 2)) {
    session.scrollback = trimScrollbackString(session.scrollback);
    return;
  }
  if (session.scrollback.length > budget * 0.6) {
    scheduleScrollbackTrim(session);
  }
}

/** download 命令的 OSC 1339 控制序列（服务端自己处理，不再下发给浏览器） */
const DOWNLOAD_OSC_RE = /\x1b\]1339;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export type DownloadRequestInfo = {
  paneId: string;
  sessionId: string;
  connection: PaneConnection;
  /** 最近在该窗口敲键盘的客户端；null 表示不知道 */
  ws: import('ws').WebSocket | null;
};

let downloadRequestHandler: ((info: DownloadRequestInfo, payload: string) => void) | null = null;

/** 由 download-routes 注册：收到终端里的 download 请求时处理 */
export function setDownloadRequestHandler(
  handler: ((info: DownloadRequestInfo, payload: string) => void) | null,
): void {
  downloadRequestHandler = handler;
}

function flushCoalescedOutput(session: PaneSession): void {
  if (session.outputCoalesceTimer) {
    clearTimeout(session.outputCoalesceTimer);
    session.outputCoalesceTimer = undefined;
  }
  let data = session.outputCoalesce;
  if (!data) return;
  session.outputCoalesce = '';
  if (downloadRequestHandler && data.includes('\x1b]1339;')) {
    const payloads = [...data.matchAll(DOWNLOAD_OSC_RE)].map((m) => m[1]);
    data = data.replace(DOWNLOAD_OSC_RE, '');
    for (const payload of payloads) {
      // 优先回给刚敲键盘的客户端；它若已断开，退回任意一个还连着的客户端
      let target = session.lastInputWs ?? null;
      if (!target || target.readyState !== 1) {
        target = null;
        for (const client of session.wsSet) {
          if (client.readyState === 1) {
            target = client;
            break;
          }
        }
      }
      downloadRequestHandler(
        {
          paneId: session.paneId,
          sessionId: session.sessionId,
          connection: session.connection,
          ws: target,
        },
        payload,
      );
    }
    if (!data) return;
  }
  appendScrollback(session, data);
  broadcast(session, { type: 'output', sessionId: session.sessionId, data });
}

function enqueuePtyOutput(session: PaneSession, data: string): void {
  updateAltScreenFromChunk(session, data);
  session.outputCoalesce += data;
  if (session.outputCoalesce.length >= OUTPUT_COALESCE_MAX_CHARS) {
    flushCoalescedOutput(session);
    return;
  }
  if (!session.outputCoalesceTimer) {
    session.outputCoalesceTimer = setTimeout(() => {
      flushCoalescedOutput(session);
    }, OUTPUT_COALESCE_MS);
  }
}

export function retrimAllPaneScrollbacks(): void {
  for (const session of paneSessions.values()) {
    session.scrollback = trimScrollbackString(session.scrollback);
  }
}

function broadcast(session: PaneSession, payload: Record<string, unknown>): void {
  const raw = JSON.stringify(payload);
  for (const client of session.wsSet) {
    if (client.readyState === 1) client.send(raw);
  }
}

export function attachPane(
  paneId: string,
  ws: WebSocket,
  cols: number,
  rows: number,
  connection: PaneConnection = { kind: 'local' },
  baseUrl?: string,
): string {
  let session = paneSessions.get(paneId);
  if (!session) {
    const sessionId = `pane:${paneId}`;
    // 终端会话的 PATH 最前面加上仓库的 bin/（imgcat / vidcat / termvid / cs）
    const withRepoBin = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
      ...env,
      PATH: `${REPO_BIN_DIR}:${env.PATH ?? ''}`,
    });
    const cliToken = crypto.randomBytes(16).toString('hex');
    let spec;
    let spawnEnv: NodeJS.ProcessEnv;
    if (connection.kind === 'local') {
      spec = resolveSpawnSpec(connection);
      spawnEnv = paneCliOrigin
        ? withRepoBin({
            ...spec.env,
            BT_APP_URL: paneCliOrigin,
            BT_CODE_TOKEN: cliToken,
            BT_PANE_ID: paneId,
          })
        : withRepoBin(spec.env);
    } else {
      // SSH：后台把 bin/ 同步到远端，并把 PATH + 凭据通过会话启动命令注入
      ensureRemoteBin(connection);
      const appUrl = (baseUrl || paneCliOrigin || '').replace(/\/+$/, '');
      spec = resolveSpawnSpec(connection, {
        remoteEnv: {
          ...(appUrl ? { BT_APP_URL: appUrl } : {}),
          BT_CODE_TOKEN: cliToken,
          BT_PANE_ID: paneId,
        },
      });
      spawnEnv = spec.env;
    }
    const ptyProcess = pty.spawn(spec.file, spec.args, {
      name: 'xterm-256color',
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 2),
      cwd: process.env.HOME || process.cwd(),
      env: spawnEnv,
    });
    spec.cleanup?.();

    session = {
      paneId,
      sessionId,
      pty: ptyProcess,
      wsSet: new Set(),
      scrollback: '',
      connection,
      cols: Math.max(cols, 2),
      rows: Math.max(rows, 2),
      altScreen: false,
      outputCoalesce: '',
      cliToken,
    };
    paneSessions.set(paneId, session);

    ptyProcess.onData((data) => {
      enqueuePtyOutput(session!, data);
    });

    ptyProcess.onExit(() => {
      broadcast(session!, { type: 'exit', sessionId });
      paneSessions.delete(paneId);
    });
  } else {
    const nextCols = Math.max(cols, 2);
    const nextRows = Math.max(rows, 2);
    if (nextCols !== session.cols || nextRows !== session.rows) {
      session.cols = nextCols;
      session.rows = nextRows;
      session.pty.resize(nextCols, nextRows);
    }
  }

  const wsAlreadyAttached = session.wsSet.has(ws);
  session.wsSet.add(ws);

  if (!wsAlreadyAttached && session.scrollback && !session.altScreen) {
    session.scrollback = trimScrollbackString(session.scrollback);
    ws.send(
      JSON.stringify({
        type: 'scrollback',
        sessionId: session.sessionId,
        clientPaneId: paneId,
        data: session.scrollback,
      }),
    );
  }

  return session.sessionId;
}

export function detachPane(sessionId: string, ws: WebSocket): void {
  for (const session of paneSessions.values()) {
    if (session.sessionId !== sessionId) continue;
    session.wsSet.delete(ws);
    return;
  }
}

export function writeInput(
  sessionId: string,
  data: string,
  ws?: import('ws').WebSocket,
): void {
  for (const session of paneSessions.values()) {
    if (session.sessionId === sessionId) {
      if (ws) session.lastInputWs = ws;
      session.pty.write(data);
      return;
    }
  }
}

export function resizePane(sessionId: string, cols: number, rows: number): void {
  const nextCols = Math.max(cols, 2);
  const nextRows = Math.max(rows, 2);
  for (const session of paneSessions.values()) {
    if (session.sessionId === sessionId) {
      if (nextCols === session.cols && nextRows === session.rows) return;
      session.cols = nextCols;
      session.rows = nextRows;
      session.pty.resize(nextCols, nextRows);
      return;
    }
  }
}

export function cleanupPanes(validPaneIds: Set<string>): void {
  for (const [paneId, session] of paneSessions) {
    if (!validPaneIds.has(paneId)) {
      if (session.scrollbackTrimTimer) clearTimeout(session.scrollbackTrimTimer);
      if (session.outputCoalesceTimer) clearTimeout(session.outputCoalesceTimer);
      flushCoalescedOutput(session);
      session.pty.kill();
      paneSessions.delete(paneId);
    }
  }
}

export function detachWsFromAllPanes(ws: WebSocket): void {
  for (const session of paneSessions.values()) {
    session.wsSet.delete(ws);
  }
}
