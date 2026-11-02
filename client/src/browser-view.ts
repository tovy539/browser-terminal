import type { TerminalSocket, WsMessage } from './ws-client';

/** 独立页面里的无头浏览器视图：画面 + 标签栏 + 工具栏 + 输入转发 */
export class BrowserPage {
  private socket: TerminalSocket;
  private root: HTMLElement;
  private tabsEl: HTMLElement;
  private canvas: HTMLImageElement;
  private urlInput: HTMLInputElement;
  private backBtn: HTMLButtonElement;
  private forwardBtn: HTMLButtonElement;
  private statusEl: HTMLElement;
  private sizeEl: HTMLSelectElement;
  private toastEl: HTMLElement;
  private loadingEl: HTMLElement;

  private sessionId: string | null = null;
  private viewport = { width: 1280, height: 800 };
  private pendingFrame: { data: string; width: number; height: number } | null = null;
  private decoding = false;
  private mouseDown = false;
  private lastMove = 0;
  private closed = false;
  private attaching = false;
  private startedOnce = false;
  /** 显示模式：tile=平铺（缩放到窗口），pixel=原始像素（1:1，不缩放） */
  private mode: 'tile' | 'pixel' =
    localStorage.getItem('bt-browser-mode') === 'pixel' ? 'pixel' : 'tile';
  /** 画质：auto=跟随显示模式（平铺85/原始像素95） */
  private quality: 'auto' | number = (() => {
    const saved = localStorage.getItem('bt-browser-quality');
    if (!saved || saved === 'auto') return 'auto';
    const n = Number(saved);
    return Number.isFinite(n) ? n : 'auto';
  })();
  private stageEl: HTMLElement;
  /** 声音：开启后用 MediaSource 播服务端推来的 fMP4/AAC 音频流 */
  private audioEl: HTMLAudioElement | null = null;
  private mediaSource: MediaSource | null = null;
  private sourceBuffer: SourceBuffer | null = null;
  private audioQueue: ArrayBuffer[] = [];
  private audioOn = false;
  /** 手机模式：窄视口时启用移动端渲染（viewport/触摸/UA） */
  private mobile = false;
  private deviceEl: HTMLSelectElement;

  constructor(root: HTMLElement, socket: TerminalSocket, width: number, height: number) {
    this.socket = socket;
    this.root = root;
    this.viewport = { width, height };
    root.innerHTML = `
      <div class="browser-shell browser-page-shell">
        <div class="browser-tabs"></div>
        <div class="browser-toolbar">
          <button type="button" class="browser-tool" data-act="back" title="后退">←</button>
          <button type="button" class="browser-tool" data-act="forward" title="前进">→</button>
          <button type="button" class="browser-tool" data-act="reload" title="刷新">⟳</button>
          <input class="browser-url" type="text" spellcheck="false" placeholder="输入网址后回车" />
          <span class="browser-status"></span>
          <button type="button" class="browser-tool browser-audio-btn" data-act="audio" title="声音（开/关）">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>
          </button>
          <button type="button" class="browser-tool" data-act="settings" title="设置">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
          <button type="button" class="browser-tool browser-close" title="关闭">×</button>
        </div>
        <div class="browser-stage">
          <img class="browser-canvas" alt="" draggable="false" tabindex="0" />
          <div class="browser-loading">连接中…</div>
        </div>
      </div>
      <div class="browser-settings" hidden>
        <div class="browser-settings-panel" role="dialog" aria-label="浏览器设置">
          <div class="browser-settings-head">
            <span>浏览器设置</span>
            <button type="button" class="browser-settings-close" aria-label="关闭">×</button>
          </div>
          <label class="browser-settings-row">
            <span>设备模式</span>
            <select class="browser-device">
              <option value="desktop">电脑模式</option>
              <option value="mobile">手机模式</option>
            </select>
          </label>
          <label class="browser-settings-row">
            <span>分辨率</span>
            <select class="browser-res"></select>
          </label>
          <div class="browser-settings-row browser-custom-res" hidden>
            <span>自定义尺寸</span>
            <span class="browser-custom-res-inputs">
              <input class="browser-custom-w" type="number" min="320" max="2560" placeholder="宽" />
              <span>×</span>
              <input class="browser-custom-h" type="number" min="240" max="1600" placeholder="高" />
            </span>
          </div>
          <label class="browser-settings-row">
            <span>显示方式</span>
            <select class="browser-display">
              <option value="tile">平铺（缩放到窗口）</option>
              <option value="pixel">原始像素（1:1 不缩放）</option>
            </select>
          </label>
          <label class="browser-settings-row">
            <span>画质</span>
            <select class="browser-quality">
              <option value="auto">自动</option>
              <option value="70">流畅（70）</option>
              <option value="85">标准（85）</option>
              <option value="95">高清（95）</option>
            </select>
          </label>
          <div class="browser-settings-hint">手机类分辨率会自动启用移动端视口与触摸。</div>
          <div class="browser-settings-actions">
            <button type="button" class="btn-secondary browser-settings-cancel">取消</button>
            <button type="button" class="btn-primary browser-settings-ok">确定</button>
          </div>
        </div>
      </div>
      <div class="browser-toast" hidden></div>
    `;

    this.tabsEl = root.querySelector<HTMLElement>('.browser-tabs')!;
    this.canvas = root.querySelector<HTMLImageElement>('.browser-canvas')!;
    this.urlInput = root.querySelector<HTMLInputElement>('.browser-url')!;
    this.statusEl = root.querySelector<HTMLElement>('.browser-status')!;
    this.sizeEl = root.querySelector<HTMLSelectElement>('.browser-res')!;
    this.deviceEl = root.querySelector<HTMLSelectElement>('.browser-device')!;
    this.toastEl = root.querySelector<HTMLElement>('.browser-toast')!;
    this.loadingEl = root.querySelector<HTMLElement>('.browser-loading')!;
    this.stageEl = root.querySelector<HTMLElement>('.browser-stage')!;
    this.backBtn = root.querySelector<HTMLButtonElement>('[data-act="back"]')!;
    this.forwardBtn = root.querySelector<HTMLButtonElement>('[data-act="forward"]')!;

    document.title = '无头浏览器';
    this.bind();
    socket.onMessage((msg) => this.onMessage(msg));
    socket.onBinary((data) => this.onAudioChunk(data));
    // 刷新页面后尽量接回原会话
    const stored = sessionStorage.getItem('bt-browser-session');
    if (stored) this.attaching = true;
    socket.onOpen(() => {
      if (this.sessionId) {
        socket.send({ type: 'browser_attach', id: this.sessionId });
        if (this.audioOn) {
          // 重连后旧的音频流已经断了，重新开一条
          this.teardownAudio();
          this.audioOn = false;
          void this.toggleAudio(true);
        }
        return;
      }
      if (this.closed) return;
      const saved = sessionStorage.getItem('bt-browser-session');
      if (saved && !this.startedOnce) {
        this.attaching = true;
        socket.send({ type: 'browser_attach', id: saved });
        return;
      }
      this.start();
    });
    socket.connect();
  }

  /** 应用显示模式：平铺=缩放铺满；原始像素=按视口 1:1 显示（不缩放、不模糊） */
  /** 让"设备模式"下拉与当前 mobile 状态一致 */
  private syncDeviceSelect(): void {
    this.deviceEl.value = this.mobile ? 'mobile' : 'desktop';
  }

  private syncResSelect(width: number, height: number): void {
    const preset = `${width}×${height}`;
    if (![...this.sizeEl.options].some((o) => o.value === preset)) {
      const opt = document.createElement('option');
      opt.value = preset;
      opt.textContent = `${width} × ${height}`;
      this.sizeEl.appendChild(opt);
    }
    this.sizeEl.value = preset;
  }

  private applyQuality(): void {
    const q = this.quality === 'auto' ? (this.mode === 'pixel' ? 95 : 85) : this.quality;
    this.sendInput({ kind: 'quality', quality: q });
  }

  private applyMode(): void {
    this.stageEl.classList.toggle('mode-tile', this.mode === 'tile');
    this.stageEl.classList.toggle('mode-pixel', this.mode === 'pixel');
    if (this.mode === 'pixel') {
      this.canvas.style.width = `${this.viewport.width}px`;
      this.canvas.style.height = `${this.viewport.height}px`;
      this.canvas.style.maxWidth = 'none';
      this.canvas.style.maxHeight = 'none';
      this.canvas.style.imageRendering = 'auto';
    } else {
      this.canvas.style.width = '';
      this.canvas.style.height = '';
      this.canvas.style.maxWidth = '';
      this.canvas.style.maxHeight = '';
    }
  }

  private setMode(mode: 'tile' | 'pixel'): void {
    if (this.mode === mode) return;
    this.mode = mode;
    localStorage.setItem('bt-browser-mode', mode);
    this.applyMode();
    // 自动画质跟随模式（原始像素 95 / 平铺 85）；手动选过画质则保持
    this.applyQuality();
  }

  private start(): void {
    this.mobile = this.viewport.width <= 500;
    this.syncDeviceSelect();
    this.loadingEl.textContent = '连接中…';
    this.loadingEl.hidden = false;
    this.sessionId = null;
    this.canvas.width = this.viewport.width;
    this.canvas.height = this.viewport.height;
    this.canvas.removeAttribute('src');
    this.syncResSelect(this.viewport.width, this.viewport.height);
    this.socket.send({
      type: 'browser_start',
      width: this.viewport.width,
      height: this.viewport.height,
    });
  }

  private toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    window.setTimeout(() => {
      this.toastEl.hidden = true;
    }, 3500);
  }

  private onMessage(msg: WsMessage): void {
    switch (msg.type) {
      case 'browser_started': {
        this.sessionId = msg.id ?? null;
        this.startedOnce = true;
        this.attaching = false;
        if (this.sessionId) sessionStorage.setItem('bt-browser-session', this.sessionId);
        const w = msg.width ?? this.viewport.width;
        const h = msg.height ?? this.viewport.height;
        this.viewport = { width: w, height: h };
        this.canvas.width = w;
        this.canvas.height = h;
        this.syncResSelect(w, h);
        this.syncDeviceSelect();
        this.loadingEl.hidden = true;
        this.canvas.focus();
        this.applyMode();
        this.applyQuality();
        if (!this.audioOn && localStorage.getItem('bt-browser-sound') === '1') {
          void this.toggleAudio(true);
        }
        // 手机尺寸：让远端切到移动端视口/触摸/UA，避免桌面布局被裁切
        if (this.mobile) {
          this.sendInput({
            kind: 'resize',
            width: this.viewport.width,
            height: this.viewport.height,
            mobile: true,
          });
        }
        break;
      }
      case 'browser_frame': {
        if (!this.sessionId || this.closed) return;
        const data = msg.data ?? '';
        if (!data) return;
        this.queueFrame({
          data,
          width: msg.width ?? this.viewport.width,
          height: msg.height ?? this.viewport.height,
        });
        break;
      }
      case 'browser_state': {
        if (!this.sessionId) return;
        if (msg.url && document.activeElement !== this.urlInput) this.urlInput.value = msg.url;
        this.statusEl.textContent = msg.loading ? '加载中…' : (msg.title ?? '');
        this.backBtn.disabled = !msg.canGoBack;
        this.forwardBtn.disabled = !msg.canGoForward;
        if (msg.title) document.title = msg.title;
        break;
      }
      case 'browser_tabs': {
        this.renderTabs(msg.tabs ?? [], msg.activeTargetId ?? '');
        break;
      }
      case 'browser_closed': {
        if (this.attaching && !this.startedOnce) {
          // 旧会话已失效：清掉记录，重新开一个
          this.attaching = false;
          sessionStorage.removeItem('bt-browser-session');
          this.start();
          return;
        }
        if (this.closed) return;
        this.closed = true;
        this.sessionId = null;
        sessionStorage.removeItem('bt-browser-session');
        this.teardownAudio();
        this.loadingEl.textContent = msg.reason ?? '浏览器已关闭';
        this.loadingEl.hidden = false;
        this.canvas.style.opacity = '0.25';
        this.toast(msg.reason ?? '浏览器已关闭');
        window.setTimeout(() => window.close(), 800);
        break;
      }
      case 'browser_error': {
        if (msg.code === 'no-browser') {
          this.showInstallPrompt(
            msg.message ?? '服务器上没有可用的浏览器',
            msg.downloadUrl,
            msg.installCommand,
            msg.searched,
          );
          break;
        }
        this.statusEl.textContent = msg.message ?? '浏览器操作失败';
        this.toast(msg.message ?? '浏览器操作失败');
        break;
      }
      case 'browser_audio': {
        if (msg.ok === false) {
          this.toast('服务器音频不可用');
          this.audioOn = false;
          this.root.querySelector('[data-act="audio"]')?.classList.remove('active');
          this.teardownAudio();
        }
        break;
      }
      case 'browser_download': {
        if (!msg.url) return;
        window.dispatchEvent(
          new CustomEvent('bt-download', { detail: { url: msg.url, name: msg.name } }),
        );
        this.toast(`下载已开始：${msg.name ?? ''}`);
        break;
      }
      default:
        break;
    }
  }

  private queueFrame(frame: { data: string; width: number; height: number }): void {
    this.pendingFrame = frame;
    if (this.decoding) return;
    void this.drainFrames();
  }

  private async drainFrames(): Promise<void> {
    this.decoding = true;
    while (this.pendingFrame) {
      const frame = this.pendingFrame;
      this.pendingFrame = null;
      try {
        if (this.canvas.width !== frame.width) this.canvas.width = frame.width;
        if (this.canvas.height !== frame.height) this.canvas.height = frame.height;
        this.canvas.src = `data:image/jpeg;base64,${frame.data}`;
        this.loadingEl.hidden = true;
      } catch {
        /* 忽略坏帧 */
      }
      if (this.pendingFrame) await new Promise((resolve) => setTimeout(resolve, 30));
    }
    this.decoding = false;
  }

  /** 声音开关：开=请求服务端录音并用 MediaSource 播放，关=停止 */
  private async toggleAudio(on: boolean): Promise<void> {
    if (on === this.audioOn) return;
    this.audioOn = on;
    localStorage.setItem('bt-browser-sound', on ? '1' : '0');
    const btn = this.root.querySelector('[data-act="audio"]');
    btn?.classList.toggle('active', on);
    if (!on) {
      if (this.sessionId) this.socket.send({ type: 'browser_audio_stop', id: this.sessionId });
      this.teardownAudio();
      return;
    }
    if (!this.sessionId) {
      this.audioOn = false;
      btn?.classList.remove('active');
      return;
    }
    if (!('MediaSource' in window)) {
      this.toast('这个浏览器不支持流式音频');
      this.audioOn = false;
      btn?.classList.remove('active');
      return;
    }
    this.audioQueue = [];
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    const audio = new Audio();
    audio.className = 'browser-audio-el';
    audio.style.display = 'none';
    document.body.appendChild(audio);
    audio.src = URL.createObjectURL(mediaSource);
    audio.autoplay = true;
    audio.volume = 0.9;
    this.audioEl = audio;
    mediaSource.addEventListener('sourceopen', () => {
      try {
        // WebM/Opus：开源 Chromium 也能播（AAC 只有官方 Chrome 支持）
        const sb = mediaSource.addSourceBuffer('audio/webm; codecs="opus"');
        sb.mode = 'segments';
        sb.addEventListener('updateend', () => this.pumpAudio());
        this.sourceBuffer = sb;
        this.pumpAudio();
      } catch {
        this.toast('音频初始化失败');
      }
    });
    // 先请求数据再播放：没有数据时 play() 的 Promise 会一直挂起
    this.socket.send({ type: 'browser_audio_start', id: this.sessionId });
    audio.play().catch(() => {
      /* 自动播放被拦时等用户再点一次 */
    });
  }

  private onAudioChunk(data: ArrayBuffer): void {
    if (!this.audioOn) return;
    this.audioQueue.push(data);
    this.pumpAudio();
  }

  private pumpAudio(): void {
    const sb = this.sourceBuffer;
    if (!sb || sb.updating || this.audioQueue.length === 0) return;
    const chunk = this.audioQueue.shift();
    if (!chunk) return;
    try {
      sb.appendBuffer(new Uint8Array(chunk));
    } catch {
      this.audioQueue.shift();
    }
    // 保持接近直播边缘，避免越积越多
    const audio = this.audioEl;
    if (audio && sb.buffered.length > 0) {
      const end = sb.buffered.end(sb.buffered.length - 1);
      if (end - audio.currentTime > 1.5) audio.currentTime = end - 0.4;
    }
  }

  private teardownAudio(): void {
    this.audioQueue = [];
    this.sourceBuffer = null;
    if (this.mediaSource) {
      try {
        if (this.mediaSource.readyState === 'open') this.mediaSource.endOfStream();
      } catch {
        /* ignore */
      }
      this.mediaSource = null;
    }
    if (this.audioEl) {
      try {
        this.audioEl.pause();
        URL.revokeObjectURL(this.audioEl.src);
        this.audioEl.remove();
      } catch {
        /* ignore */
      }
      this.audioEl = null;
    }
  }

  private renderTabs(
    tabs: { targetId: string; title?: string; url?: string }[],
    active: string,
  ): void {
    this.tabsEl.innerHTML = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = `browser-tab${tab.targetId === active ? ' active' : ''}`;
      el.title = tab.url ?? '';
      const label = document.createElement('span');
      label.className = 'browser-tab-label';
      const raw = (tab.title && tab.title.trim()) || tab.url || '新标签页';
      label.textContent = raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'browser-tab-close';
      close.textContent = '×';
      close.title = '关闭标签页';
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!this.sessionId) return;
        this.socket.send({ type: 'browser_close_tab', id: this.sessionId, targetId: tab.targetId });
      });
      el.append(label, close);
      el.addEventListener('click', () => {
        if (!this.sessionId || tab.targetId === active) return;
        this.socket.send({ type: 'browser_switch_tab', id: this.sessionId, targetId: tab.targetId });
      });
      this.tabsEl.appendChild(el);
    }
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'browser-tab-add';
    add.title = '新标签页';
    add.textContent = '+';
    add.addEventListener('click', () => {
      if (!this.sessionId) return;
      this.socket.send({ type: 'browser_new_tab', id: this.sessionId });
    });
    this.tabsEl.appendChild(add);
  }

  private showInstallPrompt(
    message: string,
    downloadUrl?: string,
    installCommand?: string,
    searched?: string[],
  ): void {
    document.querySelector('.browser-install-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.className = 'browser-install-overlay modal-overlay';
    overlay.innerHTML = `
      <div class="modal browser-install-dialog" role="dialog" aria-labelledby="install-title">
        <header class="modal-header">
          <div class="modal-header-text"><h2 id="install-title">未找到浏览器</h2></div>
          <button type="button" class="modal-close" aria-label="关闭">×</button>
        </header>
        <div class="modal-body">
          <p class="browser-install-text">${this.escape(message)}</p>
          <p class="browser-install-text">在服务器的终端窗口（任意「本机」窗口）里执行下面的命令即可安装官方 Chrome（自带 H.264/AAC，能播 MP4）：</p>
          <pre class="browser-install-cmd"></pre>
          <p class="browser-install-hint">或者在你自己的电脑下载后，用 <code>upload</code> 拖进来再安装：<br />
            <code>apt-get install -y ./google-chrome-stable_current_amd64.deb</code></p>
          ${
            downloadUrl
              ? `<p class="browser-install-hint">下载地址：<a class="browser-install-link" target="_blank" rel="noreferrer">${this.escape(downloadUrl)}</a></p>`
              : ''
          }
          ${
            searched && searched.length
              ? `<p class="browser-install-searched">已查找：${searched.map((x) => `<code>${this.escape(x)}</code>`).join('、')}</p>`
              : ''
          }
          <div class="modal-footer">
            <button type="button" class="btn-secondary browser-install-close">关闭</button>
            <button type="button" class="btn-primary browser-install-copy">复制安装命令</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cmd = overlay.querySelector<HTMLElement>('.browser-install-cmd')!;
    cmd.textContent = installCommand ?? '';
    const link = overlay.querySelector<HTMLAnchorElement>('.browser-install-link');
    if (link && downloadUrl) link.href = downloadUrl;
    const close = (): void => overlay.remove();
    overlay.querySelector('.modal-close')?.addEventListener('click', close);
    overlay.querySelector('.browser-install-close')?.addEventListener('click', close);
    overlay.addEventListener('mousedown', (ev) => {
      if (ev.target === overlay) close();
    });
    overlay.querySelector('.browser-install-copy')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(installCommand ?? '').then(
        () => this.toast('安装命令已复制，到终端粘贴执行即可'),
        () => this.toast('复制失败，请手动选中命令复制'),
      );
    });
  }

  private escape(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 屏幕坐标 → 远端视口坐标。
   * 画面用 object-fit: contain 显示，元素盒子可能比实际画面大（有黑边），
   * 所以要先按比例算出真正绘制区域（scale + 居中偏移），否则平铺模式下点击会偏。
   */
  private coords(ev: MouseEvent | WheelEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const vw = Math.max(1, this.viewport.width);
    const vh = Math.max(1, this.viewport.height);
    const scale = Math.min(rect.width / vw, rect.height / vh) || 1;
    const drawW = vw * scale;
    const drawH = vh * scale;
    const offX = rect.left + (rect.width - drawW) / 2;
    const offY = rect.top + (rect.height - drawH) / 2;
    const x = (ev.clientX - offX) / scale;
    const y = (ev.clientY - offY) / scale;
    return { x: Math.round(x), y: Math.round(y) };
  }

  private modifiers(ev: MouseEvent | KeyboardEvent): number {
    return (ev.altKey ? 1 : 0) | (ev.ctrlKey ? 2 : 0) | (ev.metaKey ? 4 : 0) | (ev.shiftKey ? 8 : 0);
  }

  private sendInput(payload: Record<string, unknown>): void {
    if (!this.sessionId || this.closed) return;
    this.socket.send({ type: 'browser_input', id: this.sessionId, ...payload });
  }

  private bind(): void {
    // 分辨率下拉（运行中也能改，服务端 resize 远端视口并补快照）
    const presets: [string, number, number][] = [
      ['1920 × 1080', 1920, 1080],
      ['1440 × 900', 1440, 900],
      ['1280 × 720', 1280, 720],
      ['1024 × 768', 1024, 768],
      ['800 × 600', 800, 600],
      ['640 × 480', 640, 480],
      ['430 × 932（手机）', 430, 932],
      ['414 × 896（手机）', 414, 896],
      ['390 × 844（手机）', 390, 844],
      ['375 × 667（手机）', 375, 667],
      ['360 × 640（手机）', 360, 640],
    ];
    this.sizeEl.innerHTML =
      presets.map(([label, w, h]) => `<option value="${w}×${h}">${label}</option>`).join('') +
      '<option value="custom">自定义…</option>';
    // 设置弹框：改完点「确定」才生效
    const qualityEl = this.root.querySelector<HTMLSelectElement>('.browser-quality')!;
    const displayEl = this.root.querySelector<HTMLSelectElement>('.browser-display')!;
    const customRow = this.root.querySelector<HTMLElement>('.browser-custom-res')!;
    const customW = this.root.querySelector<HTMLInputElement>('.browser-custom-w')!;
    const customH = this.root.querySelector<HTMLInputElement>('.browser-custom-h')!;

    // 选中"自定义…"才显示宽高输入
    this.sizeEl.addEventListener('change', () => {
      customRow.hidden = this.sizeEl.value !== 'custom';
      if (!customRow.hidden) {
        customW.value = String(this.viewport.width);
        customH.value = String(this.viewport.height);
        customW.focus();
      }
    });

    // 切换设备模式时，把分辨率下拉切到合适的一档（只改表单，点确定才生效）
    this.deviceEl.addEventListener('change', () => {
      const wantMobile = this.deviceEl.value === 'mobile';
      const [cw] = this.sizeEl.value.split('×').map(Number);
      const isMobileSize = Number.isFinite(cw) ? cw <= 500 : this.viewport.width <= 500;
      if (wantMobile && !isMobileSize) this.syncResSelect(390, 844);
      if (!wantMobile && isMobileSize) this.syncResSelect(1280, 720);
      customRow.hidden = this.sizeEl.value !== 'custom';
    });

    const fillSettings = (): void => {
      this.deviceEl.value = this.mobile ? 'mobile' : 'desktop';
      this.syncResSelect(this.viewport.width, this.viewport.height);
      displayEl.value = this.mode;
      qualityEl.value = this.quality === 'auto' ? 'auto' : String(this.quality);
      customRow.hidden = true;
    };

    const applySettings = (): void => {
      if (!this.sessionId) return;
      const wantMobile = this.deviceEl.value === 'mobile';
      let w = this.viewport.width;
      let h = this.viewport.height;
      if (this.sizeEl.value === 'custom') {
        w = Math.max(320, Math.min(2560, Math.trunc(Number(customW.value)) || w));
        h = Math.max(240, Math.min(1600, Math.trunc(Number(customH.value)) || h));
      } else {
        const [pw, ph] = this.sizeEl.value.split('×').map(Number);
        if (Number.isFinite(pw) && Number.isFinite(ph)) {
          w = pw;
          h = ph;
        }
      }
      const mobile = wantMobile;
      const sizeChanged =
        w !== this.viewport.width || h !== this.viewport.height || mobile !== this.mobile;
      this.mobile = mobile;
      this.viewport = { width: w, height: h };
      this.canvas.width = w;
      this.canvas.height = h;
      if (sizeChanged) {
        this.sendInput({ kind: 'resize', width: w, height: h, mobile });
      }
      this.setMode(displayEl.value === 'pixel' ? 'pixel' : 'tile');
      this.quality = qualityEl.value === 'auto' ? 'auto' : Number(qualityEl.value);
      localStorage.setItem('bt-browser-quality', qualityEl.value);
      this.applyQuality();
      this.applyMode();
    };

    const settingsEl0 = this.root.querySelector<HTMLElement>('.browser-settings')!;
    this.root
      .querySelector('[data-act="settings"]')
      ?.addEventListener('click', () => {
        fillSettings();
        settingsEl0.hidden = false;
      });
    this.root
      .querySelector('.browser-settings-ok')
      ?.addEventListener('click', () => {
        applySettings();
        settingsEl0.hidden = true;
      });
    const closeSettings = (): void => {
      settingsEl0.hidden = true;
    };
    this.root.querySelector('.browser-settings-cancel')?.addEventListener('click', closeSettings);

    this.urlInput.addEventListener('focus', () => this.urlInput.select());
    this.urlInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        this.sendInput({ kind: 'navigate', url: this.urlInput.value });
        this.canvas.focus();
      }
    });
    this.root.querySelector('[data-act="audio"]')?.addEventListener('click', () => {
      void this.toggleAudio(!this.audioOn);
    });
    this.root.querySelector('.browser-close')?.addEventListener('click', () => {
      if (this.sessionId) this.socket.send({ type: 'browser_close', id: this.sessionId });
      window.setTimeout(() => window.close(), 200);
    });
    this.root.querySelector('[data-act="back"]')?.addEventListener('click', () => this.sendInput({ kind: 'back' }));
    this.root.querySelector('[data-act="forward"]')?.addEventListener('click', () => this.sendInput({ kind: 'forward' }));
    this.root.querySelector('[data-act="reload"]')?.addEventListener('click', () => this.sendInput({ kind: 'reload' }));
    this.root
      .querySelector('.browser-settings-close')
      ?.addEventListener('click', () => {
        settingsEl0.hidden = true;
      });
    settingsEl0.addEventListener('mousedown', (ev) => {
      if (ev.target === settingsEl0) settingsEl0.hidden = true;
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !settingsEl0.hidden) {
        ev.preventDefault();
        settingsEl0.hidden = true;
      }
    });

    this.canvas.addEventListener('pointerdown', (ev) => {
      this.canvas.focus();
      this.mouseDown = true;
      const { x, y } = this.coords(ev);
      const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left';
      this.sendInput({ kind: 'mouse', event: 'pressed', x, y, button, buttons: ev.buttons, clickCount: 1, modifiers: this.modifiers(ev) });
    });
    this.canvas.addEventListener('pointerup', (ev) => {
      this.mouseDown = false;
      const { x, y } = this.coords(ev);
      const button = ev.button === 2 ? 'right' : ev.button === 1 ? 'middle' : 'left';
      this.sendInput({ kind: 'mouse', event: 'released', x, y, button, buttons: ev.buttons, clickCount: 1, modifiers: this.modifiers(ev) });
    });
    // 悬停也要转发：很多站点的"关闭"按钮只有 :hover 才显示/可点
    this.canvas.addEventListener('pointermove', (ev) => {
      const now = Date.now();
      if (now - this.lastMove < 30) return;
      this.lastMove = now;
      const { x, y } = this.coords(ev);
      this.sendInput({ kind: 'mouse', event: 'moved', x, y, buttons: ev.buttons, modifiers: this.modifiers(ev) });
    });
    this.canvas.addEventListener('pointerleave', () => {
      this.mouseDown = false;
    });
    this.canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const { x, y } = this.coords(ev);
        this.sendInput({ kind: 'wheel', x, y, deltaX: Math.round(ev.deltaX), deltaY: Math.round(ev.deltaY) });
      },
      { passive: false },
    );
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

    const typing = (ev: KeyboardEvent): boolean => {
      const el = ev.target as HTMLElement | null;
      const tag = el?.tagName;
      return (
        ev.target === this.urlInput ||
        tag === 'INPUT' ||
        tag === 'SELECT' ||
        tag === 'TEXTAREA' ||
        !!el?.closest?.('.browser-settings')
      );
    };
    window.addEventListener('keydown', (ev: KeyboardEvent) => {
      if (this.closed || typing(ev)) return;
      if (ev.key === 'F5') {
        ev.preventDefault();
        this.sendInput({ kind: 'reload' });
        return;
      }
      if (ev.key === 'F12') return;
      if (ev.key === 'Tab') ev.preventDefault();
      this.sendInput({
        kind: 'key',
        event: 'down',
        key: ev.key,
        code: ev.code,
        vk: ev.keyCode,
        text: ev.key.length === 1 ? ev.key : undefined,
        modifiers: this.modifiers(ev),
      });
      if (ev.key.length === 1) ev.preventDefault();
    });
    window.addEventListener('keyup', (ev: KeyboardEvent) => {
      if (this.closed || typing(ev)) return;
      this.sendInput({
        kind: 'key',
        event: 'up',
        key: ev.key,
        code: ev.code,
        vk: ev.keyCode,
        modifiers: this.modifiers(ev),
      });
    });

    // 不在这里关会话：刷新页面时也能接回同一个会话；
    // 真正关掉窗口后由服务端的掉线宽限（60s）+ 空闲超时（15min）回收
  }
}
