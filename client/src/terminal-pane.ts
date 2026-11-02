import { Terminal } from '@xterm/xterm';
import { ImageAddon } from '@xterm/addon-image';
import { readTerminalThemeFromDocument } from './theme-color';
import { clampScrollbackLines } from './terminal-scrollback';
import type { TerminalAttachConnection } from './types';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { terminalSocket } from './ws-client';
import '@xterm/xterm/css/xterm.css';

/** 单次 term.write 的字符上限，超出的部分排队借 write 回调做背压 */
const MAX_WRITE_CHARS = 128 * 1024;

export type TerminalShortcutHandler = (ev: KeyboardEvent, paneId: string) => boolean;

type XtermCore = {
  _renderService: { clear: () => void; dimensions: { css: { cell: { width: number; height: number } } } };
  viewport: { scrollBarWidth: number; syncScrollArea: (immediate?: boolean) => void };
};

export class TerminalPane {
  readonly paneId: string;
  readonly container: HTMLDivElement;
  /** xterm 挂载点，fit 以其实际 clientHeight 为准 */
  private readonly host: HTMLDivElement;
  private term: Terminal;
  private sessionId: string | null = null;
  private unsub: (() => void) | null = null;
  private onFocus?: () => void;
  private onShortcut?: TerminalShortcutHandler;
  private getAttachConnection: () => Promise<TerminalAttachConnection | null>;
  private getScrollbackLines: () => number;
  private onCloseRequested?: () => void;
  private resizeObserver: ResizeObserver;
  private lastSentCols = 0;
  private lastSentRows = 0;
  private scrollbackApplied = false;
  private lastFitWidth = -1;
  private lastFitHeight = -1;
  private fitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** 右键按下时若有框选，xterm 可能在 contextmenu 前已清选区，需提前记下文本 */
  private rightClickSelectionText: string | null = null;
  /** 正在进行的上传：id → 取消函数（Ctrl+C 时服务端会通知） */
  private uploads = new Map<string, () => void>();
  /** 会话已结束（显示"[进程已结束]"），此时按 Enter 重新连接 */
  private exited = false;
  /** 跟随最新输出；用户向上滚动后为 false */
  private stickToBottom = true;
  private pendingScrollBottom = false;
  private scrollbackPending: string | null = null;
  private initialFitDone = false;
  private suppressScrollTracking = false;
  /** 仅在连续两帧容器尺寸一致且 fit 成功后才为 true，避免 flex 未稳定时锁死错误行数 */
  private fitReady = false;
  private stableSizeFrames = 0;
  private lastSeenWidth = -1;
  private lastSeenHeight = -1;
  private fitRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private stickBottomRaf = 0;
  private pendingOutput = '';
  private outputFlushRaf = 0;
  /** 待写入 xterm 的分片队列，保证写入顺序 */
  private writeQueue: Array<{ data: string; done?: () => void }> = [];
  private writeBusy = false;
  private disposed = false;
  /** sixel / iTerm2 内联图片支持（OSC 1337、DCS q） */
  private imageAddon: ImageAddon;

  constructor(
    paneId: string,
    onFocus?: () => void,
    onShortcut?: TerminalShortcutHandler,
    getAttachConnection?: () => Promise<TerminalAttachConnection | null>,
    getScrollbackLines?: () => number,
    onCloseRequested?: () => void,
  ) {
    this.paneId = paneId;
    this.onFocus = onFocus;
    this.onShortcut = onShortcut;
    this.getAttachConnection =
      getAttachConnection ?? (async () => ({ kind: 'local' }));
    this.getScrollbackLines =
      getScrollbackLines ?? (() => clampScrollbackLines(undefined));
    this.onCloseRequested = onCloseRequested;
    this.container = document.createElement('div');
    this.container.className = 'terminal-pane';
    this.container.dataset.paneId = paneId;
    this.host = document.createElement('div');
    this.host.className = 'terminal-host';
    this.container.appendChild(this.host);

    this.term = new Terminal({
      cursorBlink: true,
      rightClickSelectsWord: false,
      scrollback: clampScrollbackLines(this.getScrollbackLines()),
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1,
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    });
    this.imageAddon = new ImageAddon();
    this.term.loadAddon(this.imageAddon);
    // 终端里的网址：按住 Ctrl（macOS 上 Cmd 也行）点击才打开，避免误点
    this.term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (!event.ctrlKey && !event.metaKey) return;
        event.preventDefault();
        window.open(uri, '_blank', 'noopener');
      }),
    );
    // download 命令（OSC 1339）：终端里打印一个 base64(JSON) 控制序列，
    // 页面拿到后带登录态调用 /api/dl/prepare —— 远端窗口不需要有 curl、也不需要能访问服务端
    this.term.parser.registerOscHandler(1339, (payload) => {
      void this.handleDownloadRequest(payload);
      return true;
    });
    this.term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      if (this.exited && (ev.key === 'Enter' || ev.key === 'Return')) {
        this.exited = false;
        void this.reconnect();
        return false;
      }
      if (this.exited && ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        this.onCloseRequested?.();
        return false;
      }
      if (this.onShortcut?.(ev, this.paneId)) return false;
      return true;
    });

    this.container.addEventListener('mousedown', (ev) => {
      this.onFocus?.();
      this.term.focus();
      if (ev.button === 2 && this.term.hasSelection()) {
        const text = this.term.getSelection();
        this.rightClickSelectionText = text || null;
      } else if (ev.button !== 2) {
        this.rightClickSelectionText = null;
      }
    });

    this.term.onData((data) => {
      if (this.sessionId) {
        terminalSocket.input(this.sessionId, data);
      }
    });

    this.resizeObserver = new ResizeObserver(() => {
      if (this.fitDebounceTimer) clearTimeout(this.fitDebounceTimer);
      this.fitDebounceTimer = setTimeout(() => {
        this.fitDebounceTimer = null;
        this.fitAndResize();
      }, 80);
    });

    if (typeof document !== 'undefined' && document.fonts?.ready) {
      void document.fonts.ready.then(() => {
        if (this.mounted) this.fitAndResize();
      });
    }
  }

  private mounted = false;

  ensureOpen(): void {
    if (this.mounted) return;
    this.mounted = true;
    this.term.open(this.host);
    this.refreshTerminalTheme();
    this.bindClipboard();
    this.bindViewportScrollTracking();
    this.resizeObserver.observe(this.host);

    this.unsub = terminalSocket.onMessage((msg) => {
      if (
        msg.type === 'scrollback' &&
        msg.clientPaneId === this.paneId &&
        msg.data
      ) {
        if (!this.scrollbackApplied) {
          this.scrollbackPending = msg.data;
          this.stickToBottom = true;
          this.pendingScrollBottom = true;
          this.tryApplyScrollback();
        }
        return;
      }
      if (
        msg.type === 'ready' &&
        msg.sessionId &&
        msg.clientPaneId === this.paneId
      ) {
        this.sessionId = msg.sessionId;
        this.fitAndResize();
        this.syncViewportAndScrollBottom();
        return;
      }
      if (msg.type === 'output' && msg.sessionId === this.sessionId && msg.data) {
        this.enqueueTerminalOutput(msg.data);
      }
      if (
        msg.type === 'code_open' &&
        msg.sessionId === this.sessionId &&
        typeof msg.data === 'string' &&
        msg.data
      ) {
        // 终端里执行了 cs：交给 App 打开新标签页（跟的是文件时用 payload 让 code-server 打开该文件）
        window.dispatchEvent(
          new CustomEvent('bt-open-code', {
            detail: { url: msg.data, file: (msg as { file?: string }).file },
          }),
        );
        return;
      }
      if (
        msg.type === 'open_url' &&
        msg.sessionId === this.sessionId &&
        typeof msg.data === 'string' &&
        msg.data
      ) {
        window.dispatchEvent(new CustomEvent('bt-open-url', { detail: { url: msg.data } }));
        return;
      }
      if (msg.type === 'upload_cancel' && msg.sessionId === this.sessionId) {
        if (msg.id) this.uploads.get(msg.id)?.();
        return;
      }
      if (msg.type === 'upload' && msg.sessionId === this.sessionId && msg.id) {
        // 终端里执行 upload：弹文件选择框，选完逐个上传到该窗口的当前目录
        this.handleUploadRequest(msg.id, msg.reqId ?? '', msg.dir ?? '', msg.sessionId);
        return;
      }
      if (msg.type === 'download_error' && msg.sessionId === this.sessionId) {
        this.enqueueWrite(`\r\n\x1b[31m[download] ${msg.error ?? '下载失败'}\x1b[0m\r\n`);
        return;
      }
      if (
        msg.type === 'download' &&
        msg.sessionId === this.sessionId &&
        typeof msg.url === 'string' &&
        msg.url
      ) {
        // 终端里执行了 download：让页面触发浏览器下载（服务端只发给"敲命令的那个客户端"）
        window.dispatchEvent(
          new CustomEvent('bt-download', {
            detail: { url: msg.url, name: msg.name },
          }),
        );
        if (msg.reqId && msg.id) {
          void this.followDownloadProgress(msg.reqId, msg.id, msg.sessionId);
        }
        return;
      }
      if (msg.type === 'exit' && msg.sessionId === this.sessionId) {
        this.exited = true;
        this.enqueueWrite(
          '\r\n\x1b[33m[进程已结束]\x1b[0m  \x1b[2m按 Enter 重新连接 · Esc 关闭窗口\x1b[0m\r\n',
        );
      }
    });

    terminalSocket.connect();
    void this.attachWhenReady();
  }

  /**
   * 处理 terminal 里的 upload 命令：进入"接收拖拽"状态（不弹系统文件框），
   * 拖进来的文件逐个 POST 到 /api/ul/<id>/file；可以多次拖入，直到 Ctrl+C。
   */
  private handleUploadRequest(uploadId: string, reqId: string, dir: string, sessionId: string): void {
    const upload: { cancelled: boolean; xhr: XMLHttpRequest | null } = { cancelled: false, xhr: null };
    const write = (state: string, bytes: number, total: number | null, message?: string): void => {
      if (upload.cancelled) return;
      terminalSocket.input(sessionId, `${reqId}|${state}|${bytes}|${total ?? ''}|${message ?? ''}\n`);
    };

    const hint = document.createElement('div');
    hint.textContent = `把文件拖进窗口即可上传到 ${dir}（可多次拖入）`;
    hint.style.cssText =
      'position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:9999;' +
      'padding:8px 16px;border-radius:8px;border:1px dashed #3fb950;background:#0f2417;color:#7ee787;' +
      'font:14px ui-monospace,monospace;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.5)';
    document.body.appendChild(hint);

    let finished = false;
    let busy = false;
    const cleanup = (): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      this.container.classList.remove('upload-drop');
      hint.remove();
      this.uploads.delete(uploadId);
      document.body.style.cursor = '';
      document.documentElement.style.cursor = '';
      try {
        this.term.focus();
      } catch {
        /* ignore */
      }
    };

    const uploadFiles = async (files: File[]): Promise<void> => {
      if (finished || files.length === 0) return;
      busy = true;
      const total = files.reduce((sum, f) => sum + f.size, 0);
      const names: string[] = [];
      let uploaded = 0;
      for (const file of files) {
        if (finished) break;
        const ok = await new Promise<boolean>((resolve) => {
          const xhr = new XMLHttpRequest();
          const url = new URL(
            `api/ul/${encodeURIComponent(uploadId)}/file`,
            document.baseURI,
          ).toString();
          xhr.open('POST', url);
          xhr.withCredentials = true;
          xhr.setRequestHeader('x-bt-name', encodeURIComponent(file.name));
          xhr.setRequestHeader('Content-Type', 'application/octet-stream');
          let lastSent = 0;
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const now = Date.now();
            if (now - lastSent < 200) return;
            lastSent = now;
            write('progress', uploaded + e.loaded, total, file.name);
          };
          xhr.onload = () => {
            upload.xhr = null;
            if (finished) {
              resolve(false);
              return;
            }
            if (xhr.status >= 200 && xhr.status < 300) {
              uploaded += file.size;
              names.push(file.name);
              resolve(true);
              return;
            }
            let message = `HTTP ${xhr.status}`;
            try {
              const body = JSON.parse(xhr.responseText) as { error?: string };
              if (body.error) message = body.error;
            } catch {
              /* ignore */
            }
            write('error', uploaded, total, message);
            resolve(false);
          };
          xhr.onerror = () => {
            if (!finished) write('error', uploaded, total, '网络错误或已取消');
            resolve(false);
          };
          xhr.onabort = () => resolve(false);
          upload.xhr = xhr;
          xhr.send(file);
        });
        if (!ok) break;
      }
      if (!finished && names.length > 0) {
        write('batch', uploaded, total, `${names.length} ${names.join(' ')}`);
      }
      busy = false;
    };

    const onDragOver = (ev: DragEvent): void => {
      if (!ev.dataTransfer) return;
      if (!Array.from(ev.dataTransfer.types).includes('Files')) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
      this.container.classList.add('upload-drop');
    };
    const onDragLeave = (ev: DragEvent): void => {
      if (ev.relatedTarget === null) this.container.classList.remove('upload-drop');
    };
    const onDrop = (ev: DragEvent): void => {
      const files = Array.from(ev.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      ev.preventDefault();
      this.container.classList.remove('upload-drop');
      if (busy) return; // 上一批还没传完，忽略这次
      void uploadFiles(files);
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('dragleave', onDragLeave);
    document.addEventListener('drop', onDrop);

    // Ctrl+C（服务端会推 upload_cancel）：结束本次上传状态
    this.uploads.set(uploadId, () => {
      upload.cancelled = true;
      try {
        upload.xhr?.abort();
      } catch {
        /* ignore */
      }
      cleanup();
    });
  }

  /** 处理 terminal 里的 download 命令（OSC 1339，payload 是 base64 的 JSON） */
  private async handleDownloadRequest(payload: string): Promise<void> {
    const note = (text: string, ok = true): void => {
      this.enqueueWrite(`\r\n${ok ? '\x1b[32m' : '\x1b[31m'}${text}\x1b[0m\r\n`);
    };
    let req: { cwd?: unknown; paths?: unknown; reqId?: unknown };
    try {
      const raw = atob(payload.trim());
      const bytes = Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
      req = JSON.parse(new TextDecoder().decode(bytes)) as {
        cwd?: unknown;
        paths?: unknown;
        reqId?: unknown;
      };
    } catch {
      note('[download] 请求格式错误', false);
      return;
    }
    const reqId = typeof req.reqId === 'string' ? req.reqId : '';
    const paths = Array.isArray(req.paths)
      ? req.paths.filter((p): p is string => typeof p === 'string' && p.length > 0)
      : [];
    if (paths.length === 0) {
      note('[download] 没有指定文件', false);
      return;
    }
    try {
      const res = await fetch(new URL('api/dl/prepare', document.baseURI).toString(), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pane: this.paneId,
          cwd: typeof req.cwd === 'string' ? req.cwd : '',
          paths,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        url?: string;
        name?: string;
        id?: string;
        error?: string;
      };
      if (!res.ok || !body.url) {
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      window.dispatchEvent(
        new CustomEvent('bt-download', { detail: { url: body.url, name: body.name } }),
      );
      // 把进度回写到该窗口的 stdin：终端里的 download 命令会读取并渲染进度，
      // 等它看到 done/error 才退出（所以提示符不会提前出现）
      if (reqId && body.id && this.sessionId) {
        void this.followDownloadProgress(reqId, body.id, this.sessionId);
      }
    } catch (e) {
      note(`[download] ${e instanceof Error ? e.message : '下载失败'}`, false);
    }
  }

  /** 轮询下载进度并写入窗口 stdin，格式：`<reqId>|<state>|<bytes>|<total>` */
  private async followDownloadProgress(
    reqId: string,
    id: string,
    sessionId: string,
  ): Promise<void> {
    const url = new URL(`api/dl/${encodeURIComponent(id)}/status`, document.baseURI).toString();
    const write = (state: string, bytes: number, total: number | null, message?: string): void => {
      const line = `${reqId}|${state}|${bytes}|${total ?? ''}|${message ?? ''}\n`;
      terminalSocket.input(sessionId, line);
    };
    const started = Date.now();
    for (;;) {
      let status: { state?: string; bytes?: number; total?: number | null; error?: string } = {};
      try {
        const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
        if (res.status === 404) return; // 会话已结束/被取消
        status = (await res.json().catch(() => ({}))) as typeof status;
      } catch {
        /* 网络抖动：继续重试 */
      }
      const bytes = typeof status.bytes === 'number' ? status.bytes : 0;
      const total = typeof status.total === 'number' ? status.total : null;
      if (status.state === 'done') {
        write('done', bytes, total);
        return;
      }
      if (status.state === 'error') {
        write('error', bytes, total, status.error ?? '下载失败');
        return;
      }
      // 用户 Ctrl+C 取消（或会话已失效）：不要再往 stdin 写，避免污染 shell 提示符
      if (status.state === 'cancelled' || status.state === 'gone') {
        return;
      }
      write('progress', bytes, total);
      if (Date.now() - started > 30 * 60 * 1000) {
        write('error', bytes, total, '等待下载完成超时');
        return;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** 会话结束后按 Enter：重新 attach（服务端会为该窗口新建 PTY） */
  private async reconnect(): Promise<void> {
    this.sessionId = null;
    this.enqueueWrite('\r\n\x1b[2m[正在重新连接…]\x1b[0m\r\n');
    await this.attachWhenReady();
    this.term.focus();
  }

  private async attachWhenReady(): Promise<void> {
    const connection = await this.getAttachConnection();
    if (!connection) {
      this.enqueueWrite('\r\n\x1b[33m[已取消 SSH 连接]\x1b[0m\r\n');
      return;
    }
    requestAnimationFrame(() => {
      this.fitAndResize();
      terminalSocket.attach(
        this.paneId,
        this.sessionId ?? undefined,
        this.term.cols,
        this.term.rows,
        connection,
      );
    });
  }

  afterAttach(): void {
    this.ensureOpen();
    requestAnimationFrame(() => this.fitAndResize());
  }

  refreshTerminalTheme(): void {
    if (!this.mounted) return;
    const t = readTerminalThemeFromDocument();
    this.term.options.theme = {
      ...this.term.options.theme,
      background: t.background,
      foreground: t.foreground,
      cursor: t.cursor,
    };
  }

  fitResize(): void {
    requestAnimationFrame(() => this.fitAndResize());
  }

  /** 丢弃已缓存的 fit 结果，在 split 初次布局或标签页显示后调用 */
  forceLayout(): void {
    this.invalidateLayout();
    this.fitAndResize();
  }

  private invalidateLayout(): void {
    this.lastFitWidth = -1;
    this.lastFitHeight = -1;
    this.fitReady = false;
    this.initialFitDone = false;
    this.stableSizeFrames = 0;
    this.lastSeenWidth = -1;
    this.lastSeenHeight = -1;
  }

  private scheduleFitRetry(): void {
    if (this.fitRetryTimer) return;
    this.fitRetryTimer = setTimeout(() => {
      this.fitRetryTimer = null;
      this.lastFitWidth = -1;
      this.lastFitHeight = -1;
      this.fitAndResize();
    }, 48);
  }

  private noteStableSize(width: number, height: number): boolean {
    if (width === this.lastSeenWidth && height === this.lastSeenHeight) {
      this.stableSizeFrames += 1;
    } else {
      this.lastSeenWidth = width;
      this.lastSeenHeight = height;
      this.stableSizeFrames = 1;
    }
    return this.stableSizeFrames >= 2;
  }

  focus(): void {
    this.term.focus();
  }

  setActive(active: boolean): void {
    this.container.classList.toggle('active', active);
  }

  setScrollbackLines(lines: number): void {
    this.term.options.scrollback = clampScrollbackLines(lines);
  }

  private bindClipboard(): void {
    this.container.addEventListener('mouseup', (ev) => {
      if (ev.button !== 0) return;
      if (!this.term.hasSelection()) return;
      const text = this.term.getSelection();
      if (!text) return;
      void navigator.clipboard.writeText(text).catch(() => {
        this.copyFallback(text);
      });
    });

    this.container.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      this.onFocus?.();
      this.term.focus();
      void this.handleTerminalContextMenu();
    });
  }

  /** 有框选：仅复制并取消框选；无框选：从剪贴板粘贴 */
  private async handleTerminalContextMenu(): Promise<void> {
    const sel =
      this.rightClickSelectionText ??
      (this.term.hasSelection() ? this.term.getSelection() : '');
    this.rightClickSelectionText = null;

    if (sel) {
      try {
        await navigator.clipboard.writeText(sel);
      } catch {
        this.copyFallback(sel);
      }
      this.term.clearSelection();
      return;
    }

    try {
      const text = await navigator.clipboard.readText();
      if (text) this.term.paste(text);
    } catch {
      /* 浏览器未授权读取剪贴板 */
    }
  }

  private bindViewportScrollTracking(): void {
    const viewport = this.container.querySelector('.xterm-viewport');
    if (!viewport) return;
    viewport.addEventListener('scroll', () => {
      if (this.suppressScrollTracking) return;
      this.stickToBottom = this.isBufferAtBottom();
    });
  }

  private isBufferAtBottom(): boolean {
    const buf = this.term.buffer.active;
    return buf.viewportY >= buf.baseY;
  }

  private getCore(): XtermCore | undefined {
    return (this.term as unknown as { _core?: XtermCore })._core;
  }

  private syncViewport(immediate = false): void {
    this.getCore()?.viewport.syncScrollArea(immediate);
  }

  /** 按 host 真实像素 fit，避免多算一行导致底部被裁切 */
  private fitTerminal(): boolean {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w <= 0 || h <= 0) return false;

    const core = this.getCore();
    if (!core) return false;

    const cell = core._renderService.dimensions.css.cell;
    if (cell.width <= 0 || cell.height <= 0) return false;

    const scrollbarW =
      this.term.options.scrollback === 0 ? 0 : core.viewport.scrollBarWidth;
    let cols = Math.max(2, Math.floor((w - scrollbarW) / cell.width));
    let rows = Math.max(1, Math.floor(h / cell.height));
    while (rows > 1 && rows * cell.height > h + 0.5) {
      rows -= 1;
    }

    if (cols === this.term.cols && rows === this.term.rows) {
      return true;
    }

    core._renderService.clear();
    this.term.resize(cols, rows);
    return true;
  }

  /** 合并 WebSocket 输出到每帧一次 write，减轻 xterm 解析压力 */
  private enqueueTerminalOutput(data: string): void {
    this.pendingOutput += data;
    if (this.pendingOutput.length >= 512 * 1024) {
      this.flushTerminalOutput();
      return;
    }
    if (this.outputFlushRaf) return;
    this.outputFlushRaf = requestAnimationFrame(() => {
      this.outputFlushRaf = 0;
      this.flushTerminalOutput();
    });
  }

  private flushTerminalOutput(): void {
    if (this.outputFlushRaf) {
      cancelAnimationFrame(this.outputFlushRaf);
      this.outputFlushRaf = 0;
    }
    const chunk = this.pendingOutput;
    if (!chunk) return;
    this.pendingOutput = '';
    this.enqueueWrite(chunk);
    this.queueStickToBottom();
  }

  /**
   * 图片序列（sixel / IIP base64）单条可达数 MB，一次 write 会让主线程长时间同步解析。
   * 这里按 MAX_WRITE_CHARS 切片排队，并借 write 回调串行化，保证输出顺序不变。
   */
  private enqueueWrite(data: string, done?: () => void): void {
    if (!data) {
      done?.();
      return;
    }
    if (this.disposed) {
      done?.();
      return;
    }
    for (let offset = 0; offset < data.length; offset += MAX_WRITE_CHARS) {
      const end = Math.min(offset + MAX_WRITE_CHARS, data.length);
      this.writeQueue.push({
        data: data.slice(offset, end),
        done: end >= data.length ? done : undefined,
      });
    }
    this.pumpWrites();
  }

  private pumpWrites(): void {
    if (this.writeBusy || this.disposed) return;
    const item = this.writeQueue.shift();
    if (!item) return;
    this.writeBusy = true;
    this.term.write(item.data, () => {
      this.writeBusy = false;
      if (this.disposed) return;
      item.done?.();
      this.pumpWrites();
    });
  }

  /** 高频输出（TUI）时合并到每帧一次，避免 OpenCode 等刷屏卡死 */
  private queueStickToBottom(): void {
    if (!this.stickToBottom) return;
    if (this.stickBottomRaf) return;
    this.stickBottomRaf = requestAnimationFrame(() => {
      this.stickBottomRaf = 0;
      this.term.scrollToBottom();
    });
  }

  /** 须用 xterm 的 ydisp 贴底；勿直接改 viewport.scrollTop */
  private syncViewportAndScrollBottom(): void {
    this.suppressScrollTracking = true;
    this.stickToBottom = true;
    this.syncViewport(true);
    this.term.scrollToBottom();
    requestAnimationFrame(() => {
      this.syncViewport(true);
      this.term.scrollToBottom();
      this.suppressScrollTracking = false;
      this.stickToBottom = this.isBufferAtBottom();
    });
  }

  /** scrollback 须在首次 fit 后再写入，否则行数不准、底部会被裁切 */
  private tryApplyScrollback(): void {
    if (this.scrollbackApplied || !this.scrollbackPending) return;
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    if (w === 0 || h === 0 || !this.initialFitDone) return;

    this.scrollbackApplied = true;
    const data = this.scrollbackPending;
    this.scrollbackPending = null;
    // 走同一队列，避免与在途的实时输出乱序
    this.enqueueWrite(data, () => {
      this.syncViewportAndScrollBottom();
    });
  }

  private copyFallback(text: string): void {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } finally {
      ta.remove();
    }
  }

  private fitAndResize(): void {
    const width = this.host.clientWidth;
    const height = this.host.clientHeight;
    if (width === 0 || height === 0) {
      this.scheduleFitRetry();
      return;
    }

    const sameCommitted =
      this.fitReady && width === this.lastFitWidth && height === this.lastFitHeight;
    if (sameCommitted && !this.pendingScrollBottom && !this.stickToBottom) {
      return;
    }
    if (sameCommitted) {
      this.tryApplyScrollback();
      if (this.pendingScrollBottom || this.stickToBottom) {
        this.syncViewportAndScrollBottom();
        this.pendingScrollBottom = false;
      }
      return;
    }

    const sizeStable = this.noteStableSize(width, height);
    if (!sizeStable) {
      requestAnimationFrame(() => this.fitAndResize());
      return;
    }

    const colsBefore = this.term.cols;
    const rowsBefore = this.term.rows;
    const activeBuf = this.term.buffer.active;
    const savedViewportY = activeBuf.viewportY;
    const atBottom = this.stickToBottom || this.isBufferAtBottom();

    let fitted = false;
    try {
      fitted = this.fitTerminal();
    } catch {
      fitted = false;
    }

    if (!fitted) {
      this.scheduleFitRetry();
      return;
    }

    this.lastFitWidth = width;
    this.lastFitHeight = height;
    this.fitReady = true;
    this.initialFitDone = true;
    this.tryApplyScrollback();

    const colsChanged = this.term.cols !== colsBefore || this.term.rows !== rowsBefore;
    if (colsChanged) {
      const afterBuf = this.term.buffer.active;
      if (atBottom) {
        this.syncViewportAndScrollBottom();
        this.pendingScrollBottom = false;
      } else {
        const line = Math.min(savedViewportY, afterBuf.baseY);
        this.term.scrollToLine(line);
      }
    } else if (this.pendingScrollBottom || this.stickToBottom) {
      this.syncViewportAndScrollBottom();
      this.pendingScrollBottom = false;
    }

    if (
      this.sessionId &&
      (this.term.cols !== this.lastSentCols || this.term.rows !== this.lastSentRows)
    ) {
      this.lastSentCols = this.term.cols;
      this.lastSentRows = this.term.rows;
      terminalSocket.resize(this.sessionId, this.term.cols, this.term.rows);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.writeQueue = [];
    if (this.outputFlushRaf) cancelAnimationFrame(this.outputFlushRaf);
    if (this.stickBottomRaf) cancelAnimationFrame(this.stickBottomRaf);
    if (this.fitDebounceTimer) clearTimeout(this.fitDebounceTimer);
    this.resizeObserver.disconnect();
    this.unsub?.();
    if (this.sessionId) {
      terminalSocket.detach(this.sessionId);
    }
    this.term.dispose();
    this.container.remove();
  }
}
