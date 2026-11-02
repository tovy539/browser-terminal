import crypto from 'crypto';
import fs from 'fs';
import { audioEnvFor, createSessionSink, destroySessionSink } from './browser-audio.js';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import WebSocket from 'ws';

/**
 * 服务端无头浏览器：Chromium + CDP。
 * - 画面：Page.startScreencast 推 JPEG 帧给浏览器端（ack 做背压）
 * - 输入：鼠标/滚轮/键盘/文本 → Input.*
 * - 下载：落到服务器临时目录，再登记成 dl/<id> 让浏览器下载
 */

const CHROME_CANDIDATES = [
  process.env.BT_CHROME,
  path.join(os.homedir(), '.cache/ms-playwright'),
].filter(Boolean) as string[];

/** 找一个可用的 Chromium：优先环境变量，其次官方 Chrome（带 H.264/AAC），再次 playwright 缓存，最后系统包 */
/** 服务器上没有可用浏览器时抛这个，前端据此提示用户先安装 */
export class NoBrowserError extends Error {
  readonly code = 'no-browser';
  readonly downloadUrl =
    'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';
  readonly installCommand =
    'wget -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && apt-get install -y /tmp/chrome.deb';
  readonly searched: string[];
  constructor(searched: string[]) {
    super('服务器上没有可用的 Chrome / Chromium，请先下载并安装');
    this.searched = searched;
  }
}

/** 候选路径（也用于"没找到"时提示查找过哪些位置） */
export function chromeCandidates(): string[] {
  const list: string[] = [];
  if (process.env.BT_CHROME) list.push(`$BT_CHROME=${process.env.BT_CHROME}`);
  list.push('/opt/google/chrome/chrome', '/opt/google/chrome/google-chrome');
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  try {
    for (const dir of fs.readdirSync(cache).filter((d) => d.startsWith('chromium-'))) {
      list.push(path.join(cache, dir, 'chrome-linux', 'chrome'));
    }
  } catch {
    /* ignore */
  }
  list.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');
  return list;
}

export function findChrome(): string | null {
  // 运维开关：BT_BROWSER_DISABLE=1 时禁用无头浏览器（前端会提示先安装）
  if (process.env.BT_BROWSER_DISABLE === '1') return null;
  if (process.env.BT_CHROME && fs.existsSync(process.env.BT_CHROME)) return process.env.BT_CHROME;
  // 官方 Google Chrome 自带 H.264/AAC 解码；开源 Chromium 构建没有，MP4 会放不了
  for (const bin of ['/opt/google/chrome/chrome', '/opt/google/chrome/google-chrome']) {
    if (fs.existsSync(bin)) return bin;
  }
  const cache = path.join(os.homedir(), '.cache/ms-playwright');
  try {
    const dirs = fs
      .readdirSync(cache)
      .filter((d) => d.startsWith('chromium-'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      const bin = path.join(cache, dir, 'chrome-linux', 'chrome');
      if (fs.existsSync(bin)) return bin;
    }
  } catch {
    /* ignore */
  }
  for (const bin of [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ]) {
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

type Json = Record<string, unknown>;

/** 极简 CDP 客户端（扁平会话模式） */
class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  onEvent: (method: string, params: Json, sessionId?: string) => void = () => {};
  closed = false;

  constructor(url: string) {
    this.ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10_000);
      this.ws.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      this.ws.on('message', (raw) => {
        let msg: Json;
        try {
          msg = JSON.parse(String(raw)) as Json;
        } catch {
          return;
        }
        if (typeof msg.id === 'number') {
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          if (msg.error) pending.reject(new Error(String((msg.error as Json).message ?? 'CDP 错误')));
          else pending.resolve((msg.result ?? {}) as Json);
          return;
        }
        if (typeof msg.method === 'string') {
          this.onEvent(msg.method, (msg.params ?? {}) as Json, msg.sessionId as string | undefined);
        }
      });
      this.ws.on('close', () => {
        this.closed = true;
        for (const { reject } of this.pending.values()) reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
      });
    });
  }

  send(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = this.nextId++;
    const payload: Json = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload), (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export interface BrowserSessionInfo {
  id: string;
  width: number;
  height: number;
}

export interface BrowserEvents {
  /** 推给发起会话的客户端 */
  send: (payload: Json) => void;
  /** 下载完成：登记成 dl/<id> 并通知客户端 */
  onDownload: (filePath: string, name: string) => { url: string; name: string } | null;
}

interface BrowserTab {
  targetId: string;
  pageSession: string;
  title: string;
  url: string;
}

interface BrowserSession {
  id: string;
  /** 会话里打开的页面（弹窗会变成新标签页） */
  tabs: BrowserTab[];
  activeTargetId: string;
  /** 当前绑定的客户端连接（WS 重连后会换成新的） */
  ws: WebSocket | null;
  /** 客户端断开后等待重连的定时器 */
  pendingClose: ReturnType<typeof setTimeout> | null;
  /** JPEG 画质（客户端可切换：平铺 85 / 原始像素 95） */
  quality: number;
  /** 上一次鼠标位置（拖动时插值用） */
  lastMouse: { x: number; y: number } | null;
  /** 是否手机模式（启用移动端视口/触摸/UA） */
  mobile: boolean;
  /** 桌面 / 移动端 UA */
  desktopUa: string;
  mobileUa: string;
  /** 画面帧看门狗：长时间没有新帧就重启 screencast */
  watchdog: ReturnType<typeof setInterval> | null;
  /** 导航后重启 screencast 的防抖定时器 */
  restartTimer: ReturnType<typeof setTimeout> | null;
  lastFrameAt: number;
  width: number;
  height: number;
  proc: ReturnType<typeof spawn>;
  cdp: Cdp;
  pageSession: string;
  userDataDir: string;
  downloadDir: string;
  events: BrowserEvents;
  closed: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 进行中的下载：guid → 文件名 */
  downloads: Map<string, string>;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

const sessions = new Map<string, BrowserSession>();
let sessionLimit = 3;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export function setBrowserSessionLimit(limit: number): void {
  sessionLimit = Math.max(1, Math.min(8, Math.trunc(limit) || 3));
}

export function browserSessionCount(): number {
  return sessions.size;
}

function emit(session: BrowserSession, payload: Json): void {
  if (session.closed) return;
  const raw = JSON.stringify(payload);
  if (session.ws && session.ws.readyState === 1) {
    try {
      session.ws.send(raw);
      return;
    } catch {
      /* 落到下面的兜底 */
    }
  }
  try {
    session.events.send(payload);
  } catch {
    /* ignore */
  }
}

function touch(session: BrowserSession): void {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  if (session.pendingClose) clearTimeout(session.pendingClose);
  if (session.watchdog) clearInterval(session.watchdog);
  if (session.restartTimer) clearTimeout(session.restartTimer);
  session.idleTimer = setTimeout(() => void closeBrowserSession(session.id, '空闲超时'), IDLE_TIMEOUT_MS);
}

function emitTabs(session: BrowserSession): void {
  emit(session, {
    type: 'browser_tabs',
    id: session.id,
    activeTargetId: session.activeTargetId,
    tabs: session.tabs.map((t) => ({ targetId: t.targetId, title: t.title, url: t.url })),
  });
}

function sendState(session: BrowserSession): void {
  emit(session, {
    type: 'browser_state',
    id: session.id,
    url: session.url,
    title: session.title,
    loading: session.loading,
    canGoBack: session.canGoBack,
    canGoForward: session.canGoForward,
  });
}

/** 启动一个无头浏览器会话 */
export async function startBrowserSession(
  width: number,
  height: number,
  events: BrowserEvents,
): Promise<BrowserSessionInfo> {
  if (sessions.size >= sessionLimit) {
    throw new Error(`浏览器会话数已达上限（${sessionLimit}），请先关闭一个`);
  }
  const bin = findChrome();
  if (!bin) throw new NoBrowserError(chromeCandidates());

  const w = Math.max(320, Math.min(2560, Math.trunc(width) || 1280));
  const h = Math.max(240, Math.min(1600, Math.trunc(height) || 800));
  const id = crypto.randomBytes(9).toString('base64url');
  const userDataDir = path.join(os.tmpdir(), `bt-browser-${id}`);
  const downloadDir = path.join(userDataDir, 'downloads');
  fs.mkdirSync(downloadDir, { recursive: true });

  // 每个会话一个独立的 null sink，Chrome 的声音输出到它，前端按需录这个 sink
  const sinkName = await createSessionSink(id);
  const chromeEnv = audioEnvFor(id, sinkName);

  const proc = spawn(
    bin,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--lang=zh-CN',
      // 允许无用户手势自动播放（否则视频/音乐不会出声）
      '--autoplay-policy=no-user-gesture-required',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--password-store=basic',
      '--force-device-scale-factor=1',
      // 窗口开得比任何可选视口都大：screencast 不会超过窗口表面尺寸，
      // 否则 1920×1080 或 390×844 的帧会被整体缩小、画面发虚
      `--window-size=${Math.max(2560, w)},${Math.max(1600, h)}`,
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env: chromeEnv },
  );

  const devtoolsUrl = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('启动 Chromium 超时')), 20_000);
    const onData = (chunk: Buffer): void => {
      buf += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stderr.on('data', onData);
    proc.stdout.on('data', onData);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chromium 退出，code=${code}`));
    });
  });

  const cdp = new Cdp(devtoolsUrl);
  await cdp.ready();

  const session: BrowserSession = {
    id,
    tabs: [],
    activeTargetId: '',
    ws: null,
    pendingClose: null,
    quality: 85,
    lastMouse: null,
    mobile: false,
    desktopUa: '',
    mobileUa: '',
    watchdog: null,
    restartTimer: null,
    lastFrameAt: Date.now(),
    width: w,
    height: h,
    proc,
    cdp,
    pageSession: '',
    userDataDir,
    downloadDir,
    events,
    closed: false,
    idleTimer: null,
    downloads: new Map(),
    url: 'about:blank',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  sessions.set(id, session);

  // 页面会话
  const target = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const targetId = String(target.targetId ?? '');
  const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  session.pageSession = String(attached.sessionId ?? '');
  session.activeTargetId = targetId;
  session.tabs.push({
    targetId,
    pageSession: session.pageSession,
    title: '',
    url: 'about:blank',
  });

  // 下载落到服务器目录
  await cdp
    .send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    })
    .catch(() => undefined);

  cdp.onEvent = (method, params, sessionId) => {
    if (method === 'Page.screencastFrame') {
      const data = String(params.data ?? '');
      const meta = (params.metadata ?? {}) as Json;
      const frameSession = Number(params.sessionId ?? 0);
      if (data) {
        session.lastFrameAt = Date.now();
        emit(session, {
          type: 'browser_frame',
          id: session.id,
          data,
          width: Number(meta.deviceWidth ?? session.width),
          height: Number(meta.deviceHeight ?? session.height),
        });
      }
      if (frameSession) {
        void cdp
          .send('Page.screencastFrameAck', { sessionId: frameSession }, sessionId)
          .catch(() => undefined);
      }
      return;
    }
    // 页面弹 alert/confirm 会阻塞渲染与输入：自动确认掉，避免"卡住点不了"
    if (method === 'Page.javascriptDialogOpening') {
      void cdp
        .send('Page.handleJavaScriptDialog', { accept: true }, sessionId)
        .catch(() => undefined);
      return;
    }
    // 渲染进程崩溃 / 页面被关：结束会话并告诉客户端
    if (method === 'Inspector.targetCrashed') {
      void closeBrowserSession(session.id, '页面崩溃了，请重新打开');
      return;
    }
    if (method === 'Page.frameNavigated') {
      const frame = (params.frame ?? {}) as Json;
      if (frame.parentId === undefined) {
        const url = String(frame.url ?? '');
        const tab = session.tabs.find((t) => t.pageSession === sessionId);
        if (tab && url) tab.url = url;
        if (session.pageSession === sessionId) {
          session.url = url || session.url;
          if (typeof frame.name === 'string') session.title = frame.name;
        }
        emitTabs(session);
      }
      return;
    }
    if (method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading') {
      session.loading = false;
      void refreshHistory(session);
      // 导航后 screencast 往往不再产帧：重启并补一张快照，避免"地址变了画面不动"
      if (!session.restartTimer) {
        session.restartTimer = setTimeout(() => {
          session.restartTimer = null;
          restartScreencast(session);
        }, 200);
      }
      return;
    }
    // SPA 路由切换（pushState/replaceState）不会触发 load，同样要补画面
    if (method === 'Page.navigatedWithinDocument') {
      session.url = String(params.url ?? session.url);
      void refreshHistory(session);
      if (!session.restartTimer) {
        session.restartTimer = setTimeout(() => {
          session.restartTimer = null;
          restartScreencast(session);
        }, 150);
      }
      return;
    }
    if (method === 'Target.attachedToTarget') {
      const info = (params.targetInfo ?? {}) as Json;
      const targetId = String(info.targetId ?? '');
      const openerId = String(info.openerId ?? '');
      const childSession = String(params.sessionId ?? '');
      // 只接管由本会话页面打开的新页面（忽略自身页面、扩展后台页/UI target）
      if (info.type !== 'page' || !targetId || !childSession) return;
      if (session.tabs.some((t) => t.targetId === targetId)) return;
      if (!openerId || !session.tabs.some((t) => t.targetId === openerId)) return;
      const url = String(info.url ?? 'about:blank');
      session.tabs.push({ targetId, pageSession: childSession, title: String(info.title ?? ''), url });
      void (async () => {
        try {
          await cdp.send('Page.enable', {}, childSession);
          await cdp.send('Runtime.enable', {}, childSession);
        } catch {
          /* ignore */
        }
        await applyViewport(session, childSession);
        await setActiveTab(session, targetId);
        // 新标签的导航事件可能在 enable 之前就发生了，补一次历史
        try {
          const history = await cdp.send('Page.getNavigationHistory', {}, childSession);
          const entries = (history.entries ?? []) as Json[];
          const current = entries[Number(history.currentIndex ?? 0)];
          const tab = session.tabs.find((t) => t.targetId === targetId);
          if (tab && current) {
            if (typeof current.url === 'string' && current.url) tab.url = current.url;
            if (typeof current.title === 'string' && current.title) tab.title = current.title;
            emitTabs(session);
          }
        } catch {
          /* ignore */
        }
      })();
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      const closedSession = String(params.sessionId ?? '');
      if (!closedSession) return;
      const tab = session.tabs.find((t) => t.pageSession === closedSession);
      if (!tab) return;
      session.tabs = session.tabs.filter((t) => t.targetId !== tab.targetId);
      if (session.tabs.length === 0) {
        void closeBrowserSession(session.id, '页面已全部关闭');
        return;
      }
      if (session.activeTargetId === tab.targetId) {
        void setActiveTab(session, session.tabs[session.tabs.length - 1].targetId);
      } else {
        emitTabs(session);
      }
      return;
    }
    if (method === 'Page.frameStartedLoading') {
      session.loading = true;
      sendState(session);
      return;
    }
    if (method === 'Browser.downloadWillBegin') {
      const guid = String(params.guid ?? '');
      const name = String(params.suggestedFilename ?? 'download');
      if (guid) session.downloads.set(guid, name);
      return;
    }
    if (method === 'Browser.downloadProgress') {
      const guid = String(params.guid ?? '');
      const state = String(params.state ?? '');
      const name = session.downloads.get(guid);
      if (state === 'completed' && name) {
        session.downloads.delete(guid);
        const filePath = path.join(session.downloadDir, name);
        const registered = session.events.onDownload(filePath, name);
        if (registered) {
          emit(session, {
            type: 'browser_download',
            id: session.id,
            url: registered.url,
            name: registered.name,
          });
        }
      }
      return;
    }
  };

  // 弹窗（window.open / target=_blank）会自动 attach 成新的 page target：
  // 把它变成标签页，而不是悄悄消失
  await cdp
    .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    .catch(() => undefined);

  await cdp.send('Page.enable', {}, session.pageSession);
  await cdp.send('Inspector.enable', {}, session.pageSession).catch(() => undefined);

  // 很多站点（如 ip.cn）会识别 "HeadlessChrome" UA 并做反爬跳转（302 到 127.0.0.1）：
  // 把 UA 里的 HeadlessChrome 换成 Chrome，并按中文环境设置语言
  try {
    const version = await cdp.send('Browser.getVersion');
    const ua = String(version.userAgent ?? '')
      .replace(/HeadlessChrome/g, 'Chrome')
      .replace(/headless/gi, '');
    if (ua) {
      session.desktopUa = ua;
      // 移动端 UA：让站点走手机版布局/自适应
      const version2 = /Chrome\/(\d+)/.exec(ua)?.[1] ?? '131';
      session.mobileUa = `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version2} Mobile Safari/537.36`;
      await cdp.send(
        'Emulation.setUserAgentOverride',
        { userAgent: ua, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' },
        session.pageSession,
      );
    }
  } catch {
    /* 失败就算了，不影响基本功能 */
  }
  await cdp.send('Runtime.enable', {}, session.pageSession);
  await applyViewport(session);
  await cdp.send(
    'Page.startScreencast',
    { format: 'jpeg', quality: session.quality, maxWidth: w, maxHeight: h, everyNthFrame: 2 },
    session.pageSession,
  );

  proc.once('exit', () => {
    if (!session.closed) void closeBrowserSession(id, '浏览器进程已退出');
  });

  // 看门狗：20 秒没有新帧就重启一次 screencast（ack 丢失/渲染卡住时能自愈）
  session.watchdog = setInterval(() => {
    if (session.closed) return;
    if (Date.now() - session.lastFrameAt < 20_000) return;
    session.lastFrameAt = Date.now();
    restartScreencast(session);
  }, 10_000);

  touch(session);
  await refreshHistory(session);
  sendState(session);
  return { id, width: w, height: h };
}

/** 应用视口设置：桌面/手机模式（设备尺寸、触摸、UA） */
async function applyViewport(
  session: BrowserSession,
  pageSession = session.pageSession,
): Promise<void> {
  const { cdp } = session;
  try {
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: session.width,
        height: session.height,
        deviceScaleFactor: session.mobile ? 2 : 1,
        mobile: session.mobile,
      },
      pageSession,
    );
    await cdp
      .send(
        'Emulation.setTouchEmulationEnabled',
        { enabled: session.mobile, maxTouchPoints: session.mobile ? 5 : 1 },
        pageSession,
      )
      .catch(() => undefined);
    const ua = session.mobile ? session.mobileUa : session.desktopUa;
    if (ua) {
      await cdp
        .send(
          'Emulation.setUserAgentOverride',
          { userAgent: ua, acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8' },
          pageSession,
        )
        .catch(() => undefined);
    }
  } catch {
    /* ignore */
  }
}

/** 切换标签页：停掉旧页面的 screencast，切到新页面并补一张快照 */
async function setActiveTab(session: BrowserSession, targetId: string): Promise<void> {
  const tab = session.tabs.find((t) => t.targetId === targetId);
  if (!tab || session.closed) return;
  const prev = session.pageSession;
  if (prev && prev !== tab.pageSession) {
    try {
      await session.cdp.send('Page.stopScreencast', {}, prev);
    } catch {
      /* ignore */
    }
  }
  session.pageSession = tab.pageSession;
  session.activeTargetId = targetId;
  await applyViewport(session, tab.pageSession);
  try {
    await session.cdp.send('Page.bringToFront', {}, tab.pageSession);
  } catch {
    /* ignore */
  }
  try {
    await session.cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: session.quality,
        maxWidth: session.width,
        maxHeight: session.height,
        everyNthFrame: 2,
      },
      tab.pageSession,
    );
  } catch {
    /* ignore */
  }
  session.url = tab.url;
  session.title = tab.title;
  sendState(session);
  emitTabs(session);
  await pushSnapshot(session);
  await refreshHistory(session);
}

/** 立刻抓一张图推给客户端：静态页面导航后 screencast 不再产帧，靠它保证画面切过去 */
async function pushSnapshot(session: BrowserSession): Promise<void> {
  if (session.closed) return;
  try {
    const shot = await session.cdp.send(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: 92, fromSurface: true },
      session.pageSession,
    );
    const data = String(shot.data ?? '');
    if (!data) return;
    session.lastFrameAt = Date.now();
    emit(session, {
      type: 'browser_frame',
      id: session.id,
      data,
      width: session.width,
      height: session.height,
    });
  } catch {
    /* 忽略 */
  }
}

/** 导航后重启 screencast（旧文档的 screencast 在导航后基本不再产帧） */
function restartScreencast(session: BrowserSession): void {
  if (session.closed) return;
  void (async () => {
    try {
      await session.cdp.send('Page.stopScreencast', {}, session.pageSession);
    } catch {
      /* ignore */
    }
    try {
      const r = await session.cdp.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: session.quality,
          maxWidth: session.width,
          maxHeight: session.height,
          everyNthFrame: 2,
        },
        session.pageSession,
      );
      void r;
    } catch {
      /* ignore */
    }
    await pushSnapshot(session);
  })();
}

async function refreshHistory(session: BrowserSession): Promise<void> {
  try {
    const history = await session.cdp.send('Page.getNavigationHistory', {}, session.pageSession);
    const entries = (history.entries ?? []) as Json[];
    const index = Number(history.currentIndex ?? 0);
    session.canGoBack = index > 0;
    session.canGoForward = index < entries.length - 1;
    const current = entries[index];
    if (current && typeof current.url === 'string' && current.url) session.url = current.url;
    if (current && typeof current.title === 'string') session.title = current.title;
    const tab = session.tabs.find((t) => t.targetId === session.activeTargetId);
    if (tab) {
      if (typeof current?.url === 'string' && current.url) tab.url = current.url;
      if (typeof current?.title === 'string' && current.title) tab.title = current.title;
    }
    emitTabs(session);
    sendState(session);
  } catch {
    /* ignore */
  }
}

/** 切换标签页 */
export async function switchBrowserTab(id: string, targetId: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  touch(session);
  await setActiveTab(session, targetId);
}

/** 关闭标签页 */
export async function closeBrowserTab(id: string, targetId: string): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  touch(session);
  const tab = session.tabs.find((t) => t.targetId === targetId);
  if (!tab) return;
  try {
    await session.cdp.send('Target.closeTarget', { targetId });
  } catch {
    /* ignore */
  }
}

/** 新开标签页 */
export async function newBrowserTab(id: string, url = 'about:blank'): Promise<void> {
  const session = sessions.get(id);
  if (!session || session.closed) return;
  touch(session);
  try {
    const created = await session.cdp.send('Target.createTarget', { url });
    const targetId = String(created.targetId ?? '');
    if (!targetId) return;
    // 新 target 会通过 autoAttach 到达；但它是我们自己建的（没有 openerId），这里主动接管
    if (session.tabs.some((t) => t.targetId === targetId)) return;
    const attached = await session.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const pageSession = String(attached.sessionId ?? '');
    if (!pageSession) return;
    session.tabs.push({ targetId, pageSession, title: '', url });
    await session.cdp.send('Page.enable', {}, pageSession).catch(() => undefined);
    await session.cdp.send('Runtime.enable', {}, pageSession).catch(() => undefined);
    // 新标签页默认用浏览器窗口大小，必须补上和会话一致的视口，否则分辨率不对
    await applyViewport(session, pageSession);
    await setActiveTab(session, targetId);
  } catch {
    /* ignore */
  }
}

/** 处理来自前端的输入/导航命令 */
export async function browserInput(id: string, msg: Json): Promise<void> {
  const session = sessions.get(id);
  if (!session) return;
  touch(session);
  const page = session.pageSession;
  const kind = String(msg.kind ?? '');
  // 页面可能因为 auto-attach 变成"后台"目标：先抢一次前台，否则输入可能被忽略
  if (kind === 'mouse' || kind === 'key' || kind === 'wheel' || kind === 'text') {
    void session.cdp.send('Page.bringToFront', {}, page).catch(() => undefined);
  }
  try {
    switch (kind) {
      case 'mouse': {
        const type = String(msg.event ?? 'moved'); // moved | pressed | released
        const x = Number(msg.x ?? 0);
        const y = Number(msg.y ?? 0);
        const buttons = Number(msg.buttons ?? 0);
        const modifiers = Number(msg.modifiers ?? 0);
        const dispatch = (kind: string, px: number, py: number, bs: number): Promise<unknown> => {
          // 拖动过程中 mouseMoved 必须带按下的键（button: left + buttons: 1），
          // 否则 Chrome 不会做文字选择/拖拽（只有按钮为 none 时会被当成悬停）
          const params: Record<string, unknown> = {
            type: kind,
            x: px,
            y: py,
            button:
              kind === 'mouseMoved'
                ? bs
                  ? String(msg.button ?? 'left')
                  : 'none'
                : String(msg.button ?? 'left'),
            buttons: bs,
            modifiers,
            pointerType: 'mouse',
          };
          if (kind !== 'mouseMoved') params.clickCount = Number(msg.clickCount ?? 1);
          return session.cdp.send('Input.dispatchMouseEvent', params, page);
        };

        if (type === 'moved' && buttons === 1 && session.lastMouse) {
          // 拖动中：把这一跳拆成若干小步并平滑发出，轨迹更像真人（滑块验证码会看轨迹）
          const from = session.lastMouse;
          const dx = x - from.x;
          const dy = y - from.y;
          const dist = Math.hypot(dx, dy);
          const steps = Math.min(8, Math.max(1, Math.round(dist / 6)));
          for (let i = 1; i <= steps; i += 1) {
            const t = i / steps;
            await dispatch('mouseMoved', Math.round(from.x + dx * t), Math.round(from.y + dy * t), 1);
            if (steps > 1) await new Promise((resolve) => setTimeout(resolve, 4));
          }
        } else {
          const cdpType =
            type === 'pressed'
              ? 'mousePressed'
              : type === 'released'
                ? 'mouseReleased'
                : 'mouseMoved';
          await dispatch(cdpType, x, y, buttons);
        }
        session.lastMouse = { x, y };
        break;
      }
      case 'wheel': {
        await session.cdp.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseWheel',
            x: Number(msg.x ?? 0),
            y: Number(msg.y ?? 0),
            deltaX: Number(msg.deltaX ?? 0),
            deltaY: Number(msg.deltaY ?? 0),
          },
          page,
        );
        break;
      }
      case 'key': {
        const type = String(msg.event ?? 'down');
        const cdpType = type === 'up' ? 'keyUp' : msg.text ? 'keyDown' : 'rawKeyDown';
        await session.cdp.send(
          'Input.dispatchKeyEvent',
          {
            type: cdpType,
            key: String(msg.key ?? ''),
            code: String(msg.code ?? ''),
            text: typeof msg.text === 'string' ? msg.text : undefined,
            unmodifiedText: typeof msg.text === 'string' ? msg.text : undefined,
            windowsVirtualKeyCode: Number(msg.vk ?? 0) || undefined,
            nativeVirtualKeyCode: Number(msg.vk ?? 0) || undefined,
            modifiers: Number(msg.modifiers ?? 0),
          },
          page,
        );
        break;
      }
      case 'text': {
        await session.cdp.send('Input.insertText', { text: String(msg.text ?? '') }, page);
        break;
      }
      case 'quality': {
        const q = Math.max(50, Math.min(100, Math.trunc(Number(msg.quality)) || session.quality));
        if (q !== session.quality) {
          session.quality = q;
          restartScreencast(session);
        }
        break;
      }
      case 'resize': {
        const w = Math.max(320, Math.min(2560, Math.trunc(Number(msg.width)) || session.width));
        const h = Math.max(240, Math.min(1600, Math.trunc(Number(msg.height)) || session.height));
        session.width = w;
        session.height = h;
        if (msg.mobile !== undefined) session.mobile = Boolean(msg.mobile);
        await applyViewport(session);
        // 先 stop 再 start（内部还会补一张快照），避免 "Screencast is already active"
        restartScreencast(session);
        break;
      }
      case 'navigate': {
        const raw = String(msg.url ?? '').trim();
        if (!raw) return;
        const url = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
        session.loading = true;
        sendState(session);
        await session.cdp.send('Page.navigate', { url }, page);
        break;
      }
      case 'back': {
        const history = await session.cdp.send('Page.getNavigationHistory', {}, page);
        const entries = (history.entries ?? []) as Json[];
        const index = Number(history.currentIndex ?? 0);
        if (index > 0) {
          await session.cdp.send(
            'Page.navigateToHistoryEntry',
            { entryId: Number(entries[index - 1].id) },
            page,
          );
        }
        break;
      }
      case 'forward': {
        const history = await session.cdp.send('Page.getNavigationHistory', {}, page);
        const entries = (history.entries ?? []) as Json[];
        const index = Number(history.currentIndex ?? 0);
        if (index < entries.length - 1) {
          await session.cdp.send(
            'Page.navigateToHistoryEntry',
            { entryId: Number(entries[index + 1].id) },
            page,
          );
        }
        break;
      }
      case 'reload': {
        await session.cdp.send('Page.reload', {}, page);
        break;
      }
      default:
        break;
    }
  } catch (e) {
    emit(session, {
      type: 'browser_error',
      id,
      message: e instanceof Error ? e.message : '浏览器操作失败',
    });
  }
}

/** 关闭会话（幂等） */
export async function closeBrowserSession(id: string, reason = '已关闭'): Promise<void> {
  destroySessionSink(id);
  const session = sessions.get(id);
  if (!session) return;
  session.closed = true;
  sessions.delete(id);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  emit(session, { type: 'browser_closed', id, reason });
  try {
    if (!session.proc.killed) session.proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  session.cdp.close();
  fs.rm(session.userDataDir, { recursive: true, force: true }, () => {
    /* ignore */
  });
}

/** 客户端（重新）连接上来：把画面/状态改发给它，并重启 screencast */
export async function attachBrowserClient(id: string, ws: WebSocket): Promise<boolean> {
  const session = sessions.get(id);
  if (!session || session.closed) return false;
  session.ws = ws;
  if (session.pendingClose) {
    clearTimeout(session.pendingClose);
    session.pendingClose = null;
  }
  session.lastFrameAt = 0; // 让看门狗尽快补一帧
  touch(session);
  try {
    await session.cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: session.quality,
        maxWidth: session.width,
        maxHeight: session.height,
        everyNthFrame: 2,
      },
      session.pageSession,
    );
  } catch {
    /* ignore */
  }
  await refreshHistory(session);
  await pushSnapshot(session);
  return true;
}

/** 客户端断开：宽限 60 秒等它重连，超时才真正关闭 */
export function detachBrowserClient(id: string): void {
  const session = sessions.get(id);
  if (!session || session.closed) return;
  session.ws = null;
  if (session.pendingClose) clearTimeout(session.pendingClose);
  session.pendingClose = setTimeout(() => {
    void closeBrowserSession(id, '客户端长时间未重连');
  }, 60_000);
}

export async function shutdownAllBrowsers(): Promise<void> {
  for (const id of [...sessions.keys()]) await closeBrowserSession(id, '服务关闭');
}
