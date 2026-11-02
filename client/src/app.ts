import {
  closePane,
  collectPaneIds,
  createDefaultLayout,
  findPane,
  firstPaneId,
  layoutSignature,
  splitPane,
  type SplitSide,
} from './layout';
import {
  deleteSshProfile,
  fetchSshProfiles,
  saveSshProfile,
  type SshProfilePublic,
} from './ssh-api';
import { logoutSession } from './auth';
import { createDefaultAppState } from './persistence';
import { applySplitLayoutSizes, renderSplitView } from './split-view';
import { initStateSync, markRevision, pushState } from './state-sync';
import { TerminalPane } from './terminal-pane';
import { bindBackdropDismiss } from './modal-backdrop';
import { ServiceManagerUi } from './service-manager-ui';
import { ProxyUi } from './proxy-ui';
import { BrowserLauncher } from './browser-launcher';
import {
  clampScrollbackLines,
  MAX_TERMINAL_SCROLLBACK_LINES,
  MIN_TERMINAL_SCROLLBACK_LINES,
} from './terminal-scrollback';
import type {
  AppState,
  PaneConnection,
  SplitDirection,
  TabState,
  TerminalAttachConnection,
} from './types';
import { terminalSocket } from './ws-client';
import {
  applyThemePaletteToDocument,
  defaultThemePalette,
  normalizeHex,
  normalizeThemePalette,
  type ThemePalette,
} from './theme-color';
import {
  emptyHostMetricsDisplay,
  fetchHostMetrics,
  formatHostMetricsDisplay,
  type HostMetricsDisplay,
} from './host-metrics-api';
import { randomId } from './uuid';

const TAB_ICON_PROXY = `<svg class="tab-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13"/><polyline points="14 5 17 8 14 11"/><path d="M20 16H7"/><polyline points="10 13 7 16 10 19"/></svg>`;

const TAB_ICON_SERVICES = `<svg class="tab-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="5" rx="1.25"/><rect x="3" y="10" width="18" height="5" rx="1.25"/><rect x="3" y="16" width="18" height="5" rx="1.25"/><circle cx="7.25" cy="6.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="7.25" cy="12.5" r="0.9" fill="currentColor" stroke="none"/><circle cx="7.25" cy="18.5" r="0.9" fill="currentColor" stroke="none"/></svg>`;

const TAB_ICON_LOGOUT = `<svg class="tab-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

function appStateFingerprint(state: AppState): string {
  return JSON.stringify({
    activeTabId: state.activeTabId,
    tabBarPosition: state.tabBarPosition,
    terminalScrollbackLines: state.terminalScrollbackLines,
    browserSessionLimit: state.browserSessionLimit,
    hideHintBar: state.hideHintBar,
    hideTabBar: state.hideTabBar,
    visualStyle: state.visualStyle ?? 'flat',
    themeBackground: state.themeBackground,
    themeUi: state.themeUi,
    themeText: state.themeText,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      activePaneId: t.activePaneId,
      layout: layoutSignature(t.layout),
    })),
  });
}

function createTab(title?: string, connection?: PaneConnection): TabState {
  const layout = connection
    ? { type: 'pane' as const, paneId: randomId(), connection }
    : createDefaultLayout();
  return {
    id: randomId(),
    title: title ?? '终端',
    layout,
    activePaneId: firstPaneId(layout),
  };
}

function sshAuthTypeLabel(p: SshProfilePublic): string {
  if (p.authType === 'password') {
    return p.hasStoredCredential ? '密码' : '连接时输入密码';
  }
  if (p.authType === 'systemKey') {
    return p.hasStoredCredential ? '私钥（系统）' : '私钥（系统，~/.ssh 无默认钥）';
  }
  return '私钥（自定义）';
}

export class App {
  private state: AppState;
  private applyingRemote = false;
  private uiReady = false;
  private panes = new Map<string, TerminalPane>();
  private root: HTMLElement;
  private appBody: HTMLElement;
  private tabBar: HTMLElement;
  private tabBarStrip: HTMLElement;
  private hideHintBarInput: HTMLInputElement;
  private hideTabBarInput: HTMLInputElement;
  private tabBarHideTimer: ReturnType<typeof setTimeout> | null = null;
  private workspace: HTMLElement;
  private settingsOverlay: HTMLElement;
  private pickOverlay: HTMLElement;
  private tabPositionSelect: HTMLSelectElement;
  private sshProfileListEl: HTMLElement;
  private sshFormEl: HTMLFormElement;
  private sshFormOverlay: HTMLElement;
  private sshFormTitleEl: HTMLElement;
  private sshPasswordOverlay: HTMLElement;
  private sshPasswordForm: HTMLFormElement;
  private sshPasswordTitleEl: HTMLElement;
  private sshPasswordHintEl: HTMLElement;
  private hintBarMetricsEl: HTMLElement;
  private hintMetricCpuEl: HTMLElement;
  private hintMetricMemEl: HTMLElement;
  private hintMetricNetEl: HTMLElement;
  private hintMetricDiskEl: HTMLElement;
  private hintNetRxEl: HTMLElement;
  private hintNetTxEl: HTMLElement;
  private hintDiskReadEl: HTMLElement;
  private hintDiskWriteEl: HTMLElement;
  private hostMetricsTimer: ReturnType<typeof setInterval> | null = null;
  private hostMetricsInFlight = false;
  private hostMetricsForcePending = false;
  private metricsSourceTabId: string | null = null;
  private appToastEl!: HTMLElement;
  private appToastTimer: ReturnType<typeof setTimeout> | null = null;
  private connLostEl!: HTMLElement;
  private connLostTimer: ReturnType<typeof setTimeout> | null = null;
  /** 断线后稍等一下再弹框，短暂抖动（自动重连成功）就不打扰 */
  private static readonly DISCONNECT_PROMPT_DELAY_MS = 1200;
  private cachedMetricsConnection: TerminalAttachConnection | null = null;
  private static readonly HOST_METRICS_INTERVAL_MS = 1000;
  /** 仅内存，用于本次连接；不写入配置或共享状态 */
  private sshSessionPasswordByPane = new Map<string, string>();
  private sshProfileById = new Map<string, SshProfilePublic>();
  private sshPasswordPromptResolver: ((value: string | null) => void) | null = null;
  private tabWorkspaceHosts = new Map<string, HTMLElement>();
  private tabLayoutSignatures = new Map<string, string>();
  private lastStateFingerprint = '';
  private appliedScrollbackLines = -1;
  private tabScrollbackInput: HTMLInputElement;
  private browserLimitInput: HTMLInputElement;
  private visualStyleSelect: HTMLSelectElement;
  private themePaletteApplyTimer: ReturnType<typeof setTimeout> | null = null;
  private serviceManagerUi: ServiceManagerUi;
  private proxyUi: ProxyUi;
  private browserLauncher: BrowserLauncher;

  constructor(root: HTMLElement) {
    this.root = root;
    this.state = createDefaultAppState();

    this.root.innerHTML = `
      <div class="app-body">
        <div class="tab-bar-strip">
          <div class="tab-bar" role="tablist"></div>
          <div class="tab-bar-actions">
            <button type="button" class="tab-action-btn proxy-btn" title="反代" aria-label="反代">${TAB_ICON_PROXY}</button>
            <button type="button" class="tab-action-btn services-btn" title="服务管理" aria-label="服务管理">${TAB_ICON_SERVICES}</button>
            <button type="button" class="tab-action-btn settings-open-btn" title="设置" aria-label="设置">⚙</button>
            <button type="button" class="tab-action-btn logout-btn" title="退出登录" aria-label="退出登录">${TAB_ICON_LOGOUT}</button>
          </div>
        </div>
        <div class="app-toast sm-toast" hidden></div>
        <div class="app-overlay modal-overlay conn-lost-overlay" hidden>
          <div class="modal conn-lost-dialog" role="alertdialog" aria-labelledby="conn-lost-title">
            <header class="modal-header">
              <div class="modal-header-text">
                <h2 id="conn-lost-title">连接已断开</h2>
              </div>
            </header>
            <div class="modal-body">
              <p class="conn-lost-text">与服务器的连接已断开，可能是服务正在重启。点击「确定」刷新页面重新连接。</p>
              <div class="conn-lost-actions">
                <button type="button" class="btn-primary conn-lost-reload">确定（刷新页面）</button>
              </div>
            </div>
          </div>
        </div>
        <div class="app-center">
          <main class="workspace"></main>
          <footer class="hint-bar">
            <div class="hint-bar-tips">
              <span>Alt+方向键 分割</span>
              <span>Alt+Backspace 关闭窗口</span>
              <span>Alt+Q 切换窗口</span>
              <span>双击标签改名 · 拖动标签排序</span>
              <span>框选复制 · 右键粘贴</span>
              <span>Ctrl+点击 打开链接</span>
            </div>
            <div class="hint-bar-device-metrics" title="当前标签页终端所在设备">
              <span class="hint-metric hint-metric-cpu">CPU   —%</span>
              <span class="hint-metric hint-metric-mem">内存 —/—G</span>
              <span class="hint-metric hint-metric-net hint-metric-io-group">
                <span class="hint-metric-io">收<span class="hint-rate-val hint-net-rx">—</span></span>
                <span class="hint-metric-io">发<span class="hint-rate-val hint-net-tx">—</span></span>
              </span>
              <span class="hint-metric hint-metric-disk hint-metric-io-group">
                <span class="hint-metric-io">读<span class="hint-rate-val hint-disk-read">—</span></span>
                <span class="hint-metric-io">写<span class="hint-rate-val hint-disk-write">—</span></span>
              </span>
            </div>
          </footer>
        </div>
      </div>
      <div class="settings-overlay modal-overlay" hidden>
        <div class="modal settings-dialog" role="dialog" aria-labelledby="settings-title">
          <header class="modal-header settings-modal-header">
            <div class="modal-header-text">
              <h2 id="settings-title">设置</h2>
            </div>
            <div class="settings-header-actions">
              <button type="button" class="settings-theme-reset">恢复默认</button>
              <button type="button" class="modal-close settings-close" aria-label="关闭">×</button>
            </div>
          </header>
          <div class="modal-body settings-body">
            <section class="settings-card settings-card-stack">
              <div class="settings-compact-row settings-compact-row-duo">
                <label class="settings-field settings-field-inline settings-field-compact">
                  <span>标签页位置</span>
                  <select class="settings-tab-position">
                    <option value="top">上</option>
                    <option value="bottom">下</option>
                    <option value="left">左</option>
                    <option value="right">右</option>
                  </select>
                </label>
                <label class="settings-field settings-field-inline settings-field-compact">
                  <span>界面风格</span>
                  <select class="settings-visual-style">
                    <option value="flat">纯色</option>
                    <option value="gradient">渐变</option>
                  </select>
                </label>
              </div>
              <div class="settings-compact-row settings-compact-row-theme">
                <div class="settings-field settings-theme-color-field">
                  <span>背景色</span>
                  <label class="settings-color-swatch">
                    <input type="color" class="settings-theme-color" data-theme-key="themeBackground" value="#252526" title="页面与终端背景" aria-label="背景色" />
                    <span class="settings-color-swatch-fill" aria-hidden="true"></span>
                  </label>
                </div>
                <div class="settings-field settings-theme-color-field">
                  <span>UI 色</span>
                  <label class="settings-color-swatch">
                    <input type="color" class="settings-theme-color" data-theme-key="themeUi" value="#2d2d2d" title="标签栏、弹窗、卡片等" aria-label="UI 色" />
                    <span class="settings-color-swatch-fill" aria-hidden="true"></span>
                  </label>
                </div>
                <div class="settings-field settings-theme-color-field">
                  <span>文字色</span>
                  <label class="settings-color-swatch">
                    <input type="color" class="settings-theme-color" data-theme-key="themeText" value="#cccccc" title="界面文字" aria-label="文字色" />
                    <span class="settings-color-swatch-fill" aria-hidden="true"></span>
                  </label>
                </div>
              </div>
              <div class="settings-compact-row settings-compact-row-duo">
                <label class="settings-field settings-field-inline settings-field-compact">
                  <span>缓存(行)</span>
                  <input
                    type="number"
                    class="settings-terminal-scrollback"
                    min="${MIN_TERMINAL_SCROLLBACK_LINES}"
                    max="${MAX_TERMINAL_SCROLLBACK_LINES}"
                    step="100"
                  />
                </label>
                <label class="settings-field settings-field-inline settings-field-compact">
                  <span>浏览器会话</span>
                  <input
                    type="number"
                    class="settings-browser-limit"
                    min="1"
                    max="8"
                    step="1"
                  />
                </label>
              </div>
              <div class="settings-compact-row settings-compact-row-checks">
                <label class="settings-field settings-ui-check">
                  <input type="checkbox" class="settings-hide-hint-bar" />
                  <span>隐藏底部状态栏</span>
                </label>
                <label class="settings-field settings-ui-check">
                  <input type="checkbox" class="settings-hide-tab-bar" />
                  <span>隐藏标签栏</span>
                </label>
              </div>
            </section>
            <section class="settings-card">
              <div class="settings-card-head">
                <h3 class="settings-card-title">SSH 远程连接</h3>
                <button type="button" class="btn-add-ssh">+ 添加连接</button>
              </div>
              <ul class="ssh-profile-list"></ul>
            </section>
          </div>
        </div>
      </div>
      <div class="ssh-form-overlay modal-overlay" hidden>
        <div class="modal ssh-form-dialog" role="dialog" aria-labelledby="ssh-form-title">
          <header class="modal-header">
            <div class="modal-header-text">
              <h2 id="ssh-form-title">添加 SSH 连接</h2>
            </div>
            <button type="button" class="modal-close ssh-form-close" aria-label="关闭">×</button>
          </header>
          <form class="ssh-profile-form modal-body">
            <input type="hidden" name="id" />
            <label class="settings-field">
              <span>名称</span>
              <input name="name" required placeholder="例如：生产机 C" />
            </label>
            <div class="settings-row">
              <label class="settings-field settings-field-grow">
                <span>主机 IP / 域名</span>
                <input name="host" required placeholder="192.168.1.10" />
              </label>
              <label class="settings-field settings-field-port">
                <span>端口</span>
                <input name="port" type="number" value="22" min="1" max="65535" />
              </label>
            </div>
            <div class="settings-row">
              <label class="settings-field settings-field-grow">
                <span>用户名</span>
                <input name="username" required placeholder="root" />
              </label>
              <label class="settings-field settings-field-auth">
                <span>认证方式</span>
                <select name="authType">
                  <option value="password">密码</option>
                  <option value="publicKey">私钥（自定义）</option>
                  <option value="systemKey">私钥（系统）</option>
                </select>
              </label>
            </div>
            <label class="settings-field ssh-auth-password">
              <span>SSH 密码</span>
              <input name="password" type="password" autocomplete="new-password" class="ssh-password-input" placeholder="留空则每次连接时输入（不会保存）" />
            </label>
            <label class="settings-field ssh-auth-key" hidden>
              <span>SSH 私钥 (PEM)</span>
              <textarea name="privateKey" rows="5" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
            </label>
            <div class="modal-footer">
              <button type="button" class="btn-secondary ssh-form-cancel">取消</button>
              <button type="submit" class="btn-primary">保存</button>
            </div>
          </form>
        </div>
      </div>
      <div class="ssh-password-overlay modal-overlay" hidden>
        <div class="modal ssh-password-dialog" role="dialog" aria-labelledby="ssh-password-title">
          <header class="modal-header">
            <div class="modal-header-text">
              <h2 id="ssh-password-title">SSH 密码</h2>
            </div>
            <button type="button" class="modal-close ssh-password-close" aria-label="关闭">×</button>
          </header>
          <form class="ssh-password-form modal-body">
            <p class="ssh-password-hint modal-subtitle"></p>
            <label class="settings-field">
              <span>SSH 密码</span>
              <input name="password" type="password" autocomplete="off" required />
            </label>
            <div class="modal-footer">
              <button type="button" class="btn-secondary ssh-password-cancel">取消</button>
              <button type="submit" class="btn-primary">连接</button>
            </div>
          </form>
        </div>
      </div>
      <div class="pick-overlay modal-overlay" hidden>
        <div class="modal pick-dialog" role="dialog" aria-labelledby="pick-title">
          <header class="modal-header">
            <div class="modal-header-text">
              <h2 id="pick-title">新建标签</h2>
            </div>
            <button type="button" class="modal-close pick-close" aria-label="关闭">×</button>
          </header>
          <div class="modal-body pick-body">
            <div class="pick-target-list"></div>
          </div>
        </div>
      </div>
    `;
    this.appBody = root.querySelector('.app-body')!;
    this.tabBar = root.querySelector('.tab-bar')!;
    this.tabBarStrip = root.querySelector('.tab-bar-strip')!;
    this.hideHintBarInput = root.querySelector('.settings-hide-hint-bar')! as HTMLInputElement;
    this.hideTabBarInput = root.querySelector('.settings-hide-tab-bar')! as HTMLInputElement;
    this.workspace = root.querySelector('.workspace')!;
    this.settingsOverlay = root.querySelector('.settings-overlay')!;
    this.pickOverlay = root.querySelector('.pick-overlay')!;
    this.tabPositionSelect = root.querySelector('.settings-tab-position')!;
    this.browserLimitInput = root.querySelector('.settings-browser-limit')!;
    this.tabScrollbackInput = root.querySelector(
      '.settings-terminal-scrollback',
    )! as HTMLInputElement;
    this.visualStyleSelect = root.querySelector(
      '.settings-visual-style',
    )! as HTMLSelectElement;
    this.sshProfileListEl = root.querySelector('.ssh-profile-list')!;
    this.sshFormEl = root.querySelector('.ssh-profile-form')! as HTMLFormElement;
    this.sshFormOverlay = root.querySelector('.ssh-form-overlay')!;
    this.sshFormTitleEl = root.querySelector('#ssh-form-title')!;
    this.sshPasswordOverlay = root.querySelector('.ssh-password-overlay')!;
    this.sshPasswordForm = root.querySelector('.ssh-password-form')! as HTMLFormElement;
    this.sshPasswordTitleEl = root.querySelector('#ssh-password-title')!;
    this.sshPasswordHintEl = root.querySelector('.ssh-password-hint')!;
    this.hintBarMetricsEl = root.querySelector('.hint-bar-device-metrics')!;
    this.appToastEl = root.querySelector('.app-toast')!;
    this.connLostEl = root.querySelector('.conn-lost-overlay')!;
    root.querySelector('.conn-lost-reload')?.addEventListener('click', () => {
      window.location.reload();
    });
    this.hintMetricCpuEl = this.hintBarMetricsEl.querySelector('.hint-metric-cpu')!;
    this.hintMetricMemEl = this.hintBarMetricsEl.querySelector('.hint-metric-mem')!;
    this.hintMetricNetEl = this.hintBarMetricsEl.querySelector('.hint-metric-net')!;
    this.hintMetricDiskEl = this.hintBarMetricsEl.querySelector('.hint-metric-disk')!;
    this.hintNetRxEl = this.hintBarMetricsEl.querySelector('.hint-net-rx')!;
    this.hintNetTxEl = this.hintBarMetricsEl.querySelector('.hint-net-tx')!;
    this.hintDiskReadEl = this.hintBarMetricsEl.querySelector('.hint-disk-read')!;
    this.hintDiskWriteEl = this.hintBarMetricsEl.querySelector('.hint-disk-write')!;

    this.serviceManagerUi = new ServiceManagerUi(this.root);
    this.proxyUi = new ProxyUi(this.root);
    this.browserLauncher = new BrowserLauncher(this.root);
    this.root.querySelector('.proxy-btn')?.addEventListener('click', () => {
      this.proxyUi.open();
    });
    this.root.querySelector('.services-btn')?.addEventListener('click', () => {
      this.serviceManagerUi.open();
    });

    this.bindSettings();
    this.bindTabBarEdgeReveal();
    this.bindLogout();
    this.bindSshPasswordPrompt();
    this.bindPickOverlay();

    initStateSync((state, revision) => {
      this.applyRemoteState(state, revision);
    });

    // 浏览器窗口失焦时淡掉焦点窗口高亮（CSS: body.window-inactive）
    window.addEventListener('blur', () => document.body.classList.add('window-inactive'));
    window.addEventListener('focus', () => document.body.classList.remove('window-inactive'));

    window.addEventListener('bt-open-code', (ev) => {
      const detail = (ev as CustomEvent<{ url?: string; file?: string }>).detail;
      if (!detail?.url) return;
      let url = detail.url;
      if (detail.file) {
        // code-server 的 payload 参数：加载完工作台后打开指定文件
        const payload = JSON.stringify([
          ['openFile', `vscode-remote://${location.host}${detail.file}`],
        ]);
        url += `${url.includes('?') ? '&' : '?'}payload=${encodeURIComponent(payload)}`;
      }
      this.openCodeTab(url);
      this.showAppToast(
        detail.file ? '已打开 code-server 并定位到该文件' : '已为当前窗口打开 code-server',
        false,
        2500,
      );
    });
    // 终端里执行 download：同源链接 + Content-Disposition，浏览器直接保存文件
    window.addEventListener('bt-download', (ev) => {
      const detail = (ev as CustomEvent).detail as { url?: string; name?: string } | undefined;
      const href = detail?.url;
      if (!href) return;
      const a = document.createElement('a');
      a.href = new URL(href, document.baseURI).toString();
      if (detail?.name) a.download = detail.name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });

    window.addEventListener('bt-open-url', (ev) => {
      const url = (ev as CustomEvent<{ url?: string }>).detail?.url;
      if (!url) return;
      this.openCodeTab(url);
      this.showAppToast('已打开播放页面', false, 2000);
    });
    terminalSocket.connect();
    terminalSocket.onState((connected) => this.onSocketConnectionState(connected));
    this.bindKeys();
    this.syncHostMetricsPolling();
  }

  private onSocketConnectionState(connected: boolean): void {
    if (connected) {
      if (this.connLostTimer) {
        clearTimeout(this.connLostTimer);
        this.connLostTimer = null;
      }
      this.connLostEl.hidden = true;
      return;
    }
    if (this.connLostEl.hidden === false || this.connLostTimer) return;
    this.connLostTimer = setTimeout(() => {
      this.connLostTimer = null;
      this.connLostEl.hidden = false;
    }, App.DISCONNECT_PROMPT_DELAY_MS);
  }

  private applyRemoteState(state: AppState, revision: number): void {
    this.applyingRemote = true;
    markRevision(revision);
    const next = JSON.parse(JSON.stringify(state)) as AppState;
    next.hideHintBar = !!next.hideHintBar;
    next.hideTabBar = !!next.hideTabBar;
    next.visualStyle = next.visualStyle === 'gradient' ? 'gradient' : 'flat';
    const theme = normalizeThemePalette(next);
    next.themeBackground = theme.background;
    next.themeUi = theme.ui;
    next.themeText = theme.text;
    // 焦点窗口以本地为准：状态回显（可能是几秒前的）不应把 Alt+Q / 关闭窗口后的焦点改回去
    for (const tab of next.tabs) {
      const localTab = this.state?.tabs?.find((t) => t.id === tab.id);
      if (!localTab?.activePaneId) continue;
      if (collectPaneIds(tab.layout).includes(localTab.activePaneId)) {
        tab.activePaneId = localTab.activePaneId;
      }
    }
    const fingerprint = appStateFingerprint(next);
    this.state = next;
    this.applyTabBarPosition();
    this.applyChromeVisibility();
    this.applyVisualStyle();
    this.applyThemePalette();
    if (!this.uiReady) {
      this.uiReady = true;
      this.renderTabs();
      this.renderWorkspace();
      this.lastStateFingerprint = fingerprint;
    } else if (fingerprint !== this.lastStateFingerprint) {
      this.renderTabs();
      this.renderWorkspace();
      this.lastStateFingerprint = fingerprint;
    }
    if (this.uiReady) {
      this.applyTerminalScrollback();
      requestAnimationFrame(() => this.fitAllPanes(this.activeTab()));
    }
    this.applyingRemote = false;
  }

  private bindLogout(): void {
    this.root.querySelector('.logout-btn')?.addEventListener('click', () => {
      terminalSocket.close();
      void logoutSession();
    });
  }

  private bindSettings(): void {
    const openBtn = this.root.querySelector('.settings-open-btn')!;
    const closeBtn = this.root.querySelector('.settings-close')!;

    openBtn.addEventListener('click', () => {
      this.tabPositionSelect.value = this.state.tabBarPosition;
      this.tabScrollbackInput.value = String(this.state.terminalScrollbackLines);
      this.browserLimitInput.value = String(this.state.browserSessionLimit);
      this.hideHintBarInput.checked = this.state.hideHintBar;
      this.hideTabBarInput.checked = this.state.hideTabBar;
      this.visualStyleSelect.value = this.state.visualStyle;
      this.syncThemeColorInputs();
      requestAnimationFrame(() => this.syncThemeColorInputs());
      void this.refreshSshProfileList();
      this.settingsOverlay.hidden = false;
    });

    const close = () => {
      this.settingsOverlay.hidden = true;
    };

    closeBtn.addEventListener('click', close);
    bindBackdropDismiss(this.settingsOverlay, close);

    this.tabPositionSelect.addEventListener('change', () => {
      this.state.tabBarPosition = this.tabPositionSelect.value as AppState['tabBarPosition'];
      this.applyTabBarPosition();
      this.applyChromeVisibility();
      this.persistState();
      requestAnimationFrame(() => this.fitAllPanes(this.activeTab()));
    });

    this.visualStyleSelect.addEventListener('change', () => {
      const next =
        this.visualStyleSelect.value === 'gradient' ? 'gradient' : 'flat';
      if (next === this.state.visualStyle) return;
      this.state.visualStyle = next;
      this.applyVisualStyle();
      this.persistState();
    });

    this.bindThemeColorInputs();
    this.root.querySelector('.settings-theme-reset')?.addEventListener('click', () => {
      this.resetThemeColorsToDefault();
    });

    const commitHideHintBar = () => {
      const next = this.hideHintBarInput.checked;
      if (next === this.state.hideHintBar) return;
      this.state.hideHintBar = next;
      this.applyChromeVisibility();
      this.persistState();
      requestAnimationFrame(() => this.fitAllPanes(this.activeTab()));
    };

    const commitHideTabBar = () => {
      const next = this.hideTabBarInput.checked;
      if (next === this.state.hideTabBar) return;
      this.state.hideTabBar = next;
      this.applyChromeVisibility();
      this.persistState();
      requestAnimationFrame(() => this.fitAllPanes(this.activeTab()));
    };

    this.hideHintBarInput.addEventListener('change', commitHideHintBar);
    this.hideTabBarInput.addEventListener('change', commitHideTabBar);

    const commitBrowserLimit = () => {
      const n = Math.max(1, Math.min(8, Math.trunc(Number(this.browserLimitInput.value)) || 3));
      this.browserLimitInput.value = String(n);
      if (n === this.state.browserSessionLimit) return;
      this.state.browserSessionLimit = n;
      this.persistState();
    };
    this.browserLimitInput.addEventListener('change', commitBrowserLimit);
    this.browserLimitInput.addEventListener('blur', commitBrowserLimit);

    const commitScrollback = () => {
      const next = clampScrollbackLines(this.tabScrollbackInput.value);
      this.tabScrollbackInput.value = String(next);
      if (next === this.state.terminalScrollbackLines) return;
      this.state.terminalScrollbackLines = next;
      this.applyTerminalScrollback();
      this.persistState();
    };

    this.tabScrollbackInput.addEventListener('change', commitScrollback);
    this.tabScrollbackInput.addEventListener('blur', commitScrollback);

    const authTypeSelect = this.sshFormEl.querySelector('[name="authType"]') as HTMLSelectElement;
    const toggleAuthFields = () => {
      const auth = authTypeSelect.value;
      const isPwd = auth === 'password';
      const isStoredKey = auth === 'publicKey';
      const pwdEl = this.sshFormEl.querySelector('.ssh-auth-password') as HTMLElement | null;
      const keyEl = this.sshFormEl.querySelector('.ssh-auth-key') as HTMLElement | null;
      if (pwdEl) pwdEl.hidden = !isPwd;
      if (keyEl) keyEl.hidden = !isStoredKey;
    };
    authTypeSelect.addEventListener('change', toggleAuthFields);
    toggleAuthFields();

    const resetSshForm = () => {
      this.sshFormEl.reset();
      (this.sshFormEl.querySelector('[name="id"]') as HTMLInputElement).value = '';
      (this.sshFormEl.querySelector('[name="port"]') as HTMLInputElement).value = '22';
      toggleAuthFields();
    };

    const closeSshForm = () => {
      this.sshFormOverlay.hidden = true;
      resetSshForm();
    };

    this.settingsOverlay
      .querySelector('.settings-card-head .btn-add-ssh')
      ?.addEventListener('click', () => {
        this.openSshForm('create');
      });

    this.sshFormOverlay.querySelector('.ssh-form-close')?.addEventListener('click', closeSshForm);
    this.sshFormOverlay.querySelector('.ssh-form-cancel')?.addEventListener('click', closeSshForm);
    bindBackdropDismiss(this.sshFormOverlay, closeSshForm);
    this.sshFormOverlay.querySelector('.ssh-form-dialog')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });

    this.sshFormEl.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.submitSshForm().then(() => closeSshForm());
    });
  }

  private openSshForm(mode: 'create' | 'edit', profile?: SshProfilePublic): void {
    this.sshFormEl.reset();
    (this.sshFormEl.querySelector('[name="port"]') as HTMLInputElement).value = '22';
    (this.sshFormEl.querySelector('[name="id"]') as HTMLInputElement).value = '';
    this.sshFormTitleEl.textContent = mode === 'create' ? '添加 SSH 连接' : '编辑 SSH 连接';
    const pwdInput = this.sshFormEl.querySelector('.ssh-password-input') as HTMLInputElement;
    if (pwdInput) {
      pwdInput.placeholder =
        mode === 'create'
          ? '留空则每次连接时输入（不会保存）'
          : '留空保留已存密码；填新密码会覆盖保存';
    }
    if (profile) this.fillSshFormFields(profile);
    this.sshFormEl.querySelector('[name="authType"]')?.dispatchEvent(new Event('change'));
    this.sshFormOverlay.hidden = false;
    (this.sshFormEl.querySelector('[name="name"]') as HTMLInputElement)?.focus();
  }

  private async refreshSshProfileList(): Promise<void> {
    const profiles = await fetchSshProfiles();
    this.sshProfileById.clear();
    for (const p of profiles) this.sshProfileById.set(p.id, p);
    this.sshProfileListEl.replaceChildren();
    if (profiles.length === 0) {
      const li = document.createElement('li');
      li.className = 'ssh-empty';
      li.textContent = '暂无 SSH 配置，点击「添加连接」创建';
      this.sshProfileListEl.appendChild(li);
      return;
    }
    for (const p of profiles) {
      const li = document.createElement('li');
      li.className = 'ssh-profile-item';
      li.innerHTML = `
        <span class="ssh-profile-badge" aria-hidden="true">SSH</span>
        <span class="ssh-profile-meta">
          <strong>${escapeHtml(p.name)}</strong>
          <small><code>${escapeHtml(p.username)}@${escapeHtml(p.host)}:${p.port}</code> · ${sshAuthTypeLabel(p)}</small>
        </span>
        <span class="ssh-profile-actions">
          <button type="button" class="btn-secondary ssh-profile-btn ssh-edit">编辑</button>
          <button type="button" class="btn-secondary ssh-profile-btn ssh-profile-btn-danger ssh-del">删除</button>
        </span>
      `;
      li.querySelector('.ssh-edit')?.addEventListener('click', () => this.openSshForm('edit', p));
      li.querySelector('.ssh-del')?.addEventListener('click', () => {
        void deleteSshProfile(p.id).then(() => this.refreshSshProfileList());
      });
      this.sshProfileListEl.appendChild(li);
    }
  }

  private fillSshFormFields(p: SshProfilePublic): void {
    (this.sshFormEl.querySelector('[name="id"]') as HTMLInputElement).value = p.id;
    (this.sshFormEl.querySelector('[name="name"]') as HTMLInputElement).value = p.name;
    (this.sshFormEl.querySelector('[name="host"]') as HTMLInputElement).value = p.host;
    (this.sshFormEl.querySelector('[name="port"]') as HTMLInputElement).value = String(p.port);
    (this.sshFormEl.querySelector('[name="username"]') as HTMLInputElement).value = p.username;
    (this.sshFormEl.querySelector('[name="authType"]') as HTMLSelectElement).value = p.authType;
    (this.sshFormEl.querySelector('[name="password"]') as HTMLInputElement).value = '';
    (this.sshFormEl.querySelector('[name="privateKey"]') as HTMLTextAreaElement).value = '';
  }

  private async submitSshForm(): Promise<void> {
    const fd = new FormData(this.sshFormEl);
    const authType = String(fd.get('authType')) as SshProfilePublic['authType'];
    await saveSshProfile({
      id: String(fd.get('id') || '') || undefined,
      name: String(fd.get('name') || ''),
      host: String(fd.get('host') || ''),
      port: Number(fd.get('port')) || 22,
      username: String(fd.get('username') || ''),
      authType,
      password: authType === 'password' ? String(fd.get('password') || '') : undefined,
      privateKey: authType === 'publicKey' ? String(fd.get('privateKey') || '') : undefined,
    });
    await this.refreshSshProfileList();
  }

  private bindSshPasswordPrompt(): void {
    const close = (value: string | null) => {
      this.sshPasswordOverlay.hidden = true;
      const resolve = this.sshPasswordPromptResolver;
      this.sshPasswordPromptResolver = null;
      resolve?.(value);
    };

    this.sshPasswordOverlay.querySelector('.ssh-password-close')?.addEventListener('click', () => {
      close(null);
    });
    this.sshPasswordOverlay.querySelector('.ssh-password-cancel')?.addEventListener('click', () => {
      close(null);
    });
    this.sshPasswordOverlay.querySelector('.ssh-password-dialog')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
    });
    bindBackdropDismiss(this.sshPasswordOverlay, () => close(null));

    this.sshPasswordForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const pwd = String(new FormData(this.sshPasswordForm).get('password') || '');
      if (!pwd) return;
      close(pwd);
    });
  }

  private promptSshPassword(profile: SshProfilePublic): Promise<string | null> {
    if (this.sshPasswordPromptResolver) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.sshPasswordPromptResolver = resolve;
      this.sshPasswordTitleEl.textContent = `SSH 密码 · ${profile.name}`;
      this.sshPasswordHintEl.textContent = `${profile.username}@${profile.host}:${profile.port} · 密码仅用于本次连接，不会保存`;
      this.sshPasswordForm.reset();
      this.sshPasswordOverlay.hidden = false;
      const input = this.sshPasswordForm.querySelector('[name="password"]') as HTMLInputElement;
      input?.focus();
    });
  }

  private async loadSshProfile(id: string): Promise<SshProfilePublic | null> {
    let p = this.sshProfileById.get(id);
    if (p) return p;
    await this.refreshSshProfileList();
    return this.sshProfileById.get(id) ?? null;
  }

  private async resolveAttachConnection(
    paneId: string,
  ): Promise<TerminalAttachConnection | null> {
    const base = this.findPaneConnection(paneId);
    if (base.kind !== 'ssh') return base;

    const profile = await this.loadSshProfile(base.profileId);
    if (!profile) return base;

    if (profile.authType === 'password' && !profile.hasStoredCredential) {
      let pwd = this.sshSessionPasswordByPane.get(paneId);
      if (!pwd) {
        pwd = (await this.promptSshPassword(profile)) ?? undefined;
        if (!pwd) return null;
        this.sshSessionPasswordByPane.set(paneId, pwd);
      }
      return { kind: 'ssh', profileId: base.profileId, sessionPassword: pwd };
    }

    return base;
  }

  private async ensureSshPasswordForNewPane(
    profile: SshProfilePublic,
    paneId: string,
  ): Promise<boolean> {
    if (profile.authType !== 'password' || profile.hasStoredCredential) return true;
    const pwd = await this.promptSshPassword(profile);
    if (!pwd) return false;
    this.sshSessionPasswordByPane.set(paneId, pwd);
    return true;
  }

  private bindPickOverlay(): void {
    const closeBtn = this.pickOverlay.querySelector('.pick-close')!;
    const close = () => {
      this.pickOverlay.hidden = true;
    };
    closeBtn.addEventListener('click', close);
    bindBackdropDismiss(this.pickOverlay, close);
  }

  private async openNewTabPicker(): Promise<void> {
    const list = this.pickOverlay.querySelector('.pick-target-list')!;
    list.replaceChildren();

    const addSection = (title: string) => {
      const el = document.createElement('div');
      el.className = 'pick-section-label';
      el.textContent = title;
      list.appendChild(el);
    };

    const addItem = (
      variant: 'local' | 'ssh',
      label: string,
      sub: string,
      onPick: () => void | Promise<boolean | void>,
    ) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `pick-target-item pick-target-${variant}`;
      btn.innerHTML = `
        <span class="pick-target-icon" aria-hidden="true">${variant === 'local' ? '⌘' : '⇄'}</span>
        <span class="pick-target-text">
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(sub)}</small>
        </span>
        <span class="pick-target-chevron" aria-hidden="true">›</span>
      `;
      btn.addEventListener('click', () => {
        void (async () => {
          const result = await onPick();
          if (result !== false) this.pickOverlay.hidden = true;
        })();
      });
      list.appendChild(btn);
    };

    addSection('本机');
    addItem('local', '本地终端', '当前网关上的 Shell', () => {
      this.addTabWithConnection(undefined, '本地终端');
    });

    const profiles = await fetchSshProfiles();
    if (profiles.length > 0) {
      addSection('SSH 远程');
      for (const p of profiles) {
        const sub = `${p.username}@${p.host}:${p.port}${
          p.authType === 'password' && !p.hasStoredCredential ? ' · 需输入密码' : ''
        }`;
        addItem('ssh', p.name, sub, async () => {
          const tab = createTab(p.name, { kind: 'ssh', profileId: p.id });
          const paneId = firstPaneId(tab.layout);
          if (!(await this.ensureSshPasswordForNewPane(p, paneId))) return false;
          this.state.tabs.push(tab);
          this.state.activeTabId = tab.id;
          this.persistState();
          this.renderTabs();
          this.renderWorkspace();
          this.onActiveTabChanged();
        });
      }
    } else {
      const hint = document.createElement('p');
      hint.className = 'pick-empty-hint';
      hint.innerHTML =
        '还没有 SSH 配置。<button type="button" class="btn-link pick-open-settings">去设置中添加</button>';
      hint.querySelector('.pick-open-settings')?.addEventListener('click', () => {
        this.pickOverlay.hidden = true;
        this.tabPositionSelect.value = this.state.tabBarPosition;
        void this.refreshSshProfileList().then(() => {
          this.settingsOverlay.hidden = false;
        });
      });
      list.appendChild(hint);
    }

    this.pickOverlay.hidden = false;
  }

  private addTabWithConnection(connection: PaneConnection | undefined, title: string): void {
    const tab = createTab(title, connection);
    this.state.tabs.push(tab);
    this.state.activeTabId = tab.id;
    this.persistState();
    this.renderTabs();
    this.renderWorkspace();
    this.onActiveTabChanged();
  }

  private invalidateMetricsConnection(): void {
    this.metricsSourceTabId = null;
    this.cachedMetricsConnection = null;
  }

  /** 同一标签页内各窗格为同一设备，连接只随标签页切换而更新 */
  private async metricsConnectionForActiveTab(): Promise<TerminalAttachConnection | null> {
    if (!this.uiReady || this.state.tabs.length === 0) {
      return { kind: 'local' };
    }
    const tab = this.activeTab();
    if (this.metricsSourceTabId === tab.id) {
      return this.cachedMetricsConnection;
    }
    const paneId = firstPaneId(tab.layout);
    const conn = await this.resolveAttachConnection(paneId);
    this.metricsSourceTabId = tab.id;
    this.cachedMetricsConnection = conn;
    return conn;
  }

  /** 可能部署在子路径下（例如 nginx 的 /myterminal/）：按当前页面基准地址解析，别写死从 / 开始 */
  private openCodeTab(url: string): void {
    const base = document.baseURI.endsWith('/') ? document.baseURI : `${document.baseURI}/`;
    window.open(new URL(url.replace(/^\/+/, ''), base).toString(), '_blank', 'noopener');
  }

  private showAppToast(message: string, error = false, ms = 3500): void {
    this.appToastEl.textContent = message;
    this.appToastEl.classList.toggle('sm-toast-error', error);
    this.appToastEl.hidden = false;
    if (this.appToastTimer) clearTimeout(this.appToastTimer);
    this.appToastTimer = setTimeout(() => {
      this.appToastEl.hidden = true;
      this.appToastTimer = null;
    }, ms);
  }

  /** 用 code-server 打开当前标签页指向的设备（本机 / SSH 远端），在新标签页里打开 */
  private applyHostMetricsDisplay(cells: HostMetricsDisplay): void {
    this.hintMetricCpuEl.textContent = cells.cpu;
    this.hintMetricMemEl.textContent = cells.mem;
    this.hintNetRxEl.textContent = cells.netRx;
    this.hintNetTxEl.textContent = cells.netTx;
    this.hintDiskReadEl.textContent = cells.diskRead;
    this.hintDiskWriteEl.textContent = cells.diskWrite;
    this.hintMetricCpuEl.style.color = cells.cpuColor;
    this.hintMetricMemEl.style.color = cells.memColor;
    this.hintMetricNetEl.style.color = cells.netColor;
    this.hintMetricDiskEl.style.color = cells.diskColor;
    this.hintBarMetricsEl.title = cells.title;
  }

  /** 切换标签页后立即重新采集（可打断进行中的轮询） */
  private onActiveTabChanged(): void {
    this.invalidateMetricsConnection();
    void this.refreshHostMetrics(true);
  }

  private syncHostMetricsPolling(): void {
    if (this.hostMetricsTimer) {
      clearInterval(this.hostMetricsTimer);
      this.hostMetricsTimer = null;
    }
    if (this.state.hideHintBar) {
      this.applyHostMetricsDisplay(emptyHostMetricsDisplay());
      return;
    }
    void this.refreshHostMetrics();
    this.hostMetricsTimer = setInterval(() => {
      void this.refreshHostMetrics();
    }, App.HOST_METRICS_INTERVAL_MS);
  }

  private async refreshHostMetrics(force = false): Promise<void> {
    if (this.state.hideHintBar) return;
    if (force) this.hostMetricsForcePending = true;
    if (this.hostMetricsInFlight) return;

    while (true) {
      this.hostMetricsForcePending = false;
      this.hostMetricsInFlight = true;
      try {
        const connection = await this.metricsConnectionForActiveTab();
        if (!connection) {
          this.applyHostMetricsDisplay(emptyHostMetricsDisplay());
        } else {
          const metrics = await fetchHostMetrics(connection);
          if (!metrics) {
            this.applyHostMetricsDisplay(emptyHostMetricsDisplay());
          } else {
            this.applyHostMetricsDisplay(formatHostMetricsDisplay(metrics));
          }
        }
      } finally {
        this.hostMetricsInFlight = false;
      }
      if (!this.hostMetricsForcePending) break;
    }
  }

  private findPaneConnection(paneId: string): PaneConnection {
    for (const tab of this.state.tabs) {
      const pane = findPane(tab.layout, paneId);
      if (pane) return pane.connection ?? { kind: 'local' };
    }
    return { kind: 'local' };
  }

  private applyTabBarPosition(): void {
    this.root.classList.remove(
      'tab-pos-top',
      'tab-pos-bottom',
      'tab-pos-left',
      'tab-pos-right',
    );
    this.root.classList.add(`tab-pos-${this.state.tabBarPosition}`);
  }

  private applyVisualStyle(): void {
    const gradient = this.state.visualStyle === 'gradient';
    this.root.classList.toggle('style-gradient', gradient);
    document.documentElement.classList.toggle('style-gradient', gradient);
  }

  private themePaletteFromState(): ThemePalette {
    return {
      background: this.state.themeBackground,
      ui: this.state.themeUi,
      text: this.state.themeText,
    };
  }

  private syncThemeColorInputs(): void {
    const map: Record<string, string> = {
      themeBackground: this.state.themeBackground,
      themeUi: this.state.themeUi,
      themeText: this.state.themeText,
    };
    for (const input of this.root.querySelectorAll<HTMLInputElement>(
      '.settings-theme-color',
    )) {
      const key = input.dataset.themeKey;
      if (!key || !(key in map)) continue;
      this.paintColorSwatch(input, map[key]);
    }
  }

  private themeColorFallback(key: string | undefined): string {
    const d = defaultThemePalette();
    if (key === 'themeBackground') return d.background;
    if (key === 'themeUi') return d.ui;
    if (key === 'themeText') return d.text;
    return d.background;
  }

  private paintColorSwatch(input: HTMLInputElement, hex?: string): void {
    const swatch = input.closest('.settings-color-swatch');
    const fill = swatch?.querySelector(
      '.settings-color-swatch-fill',
    ) as HTMLElement | null;
    if (!fill) return;
    const key = input.dataset.themeKey;
    const color = normalizeHex(hex ?? input.value, this.themeColorFallback(key));
    input.value = color;
    fill.style.background = 'none';
    fill.style.backgroundColor = color;
  }

  private openThemeColorPicker(input: HTMLInputElement): void {
    try {
      if (typeof input.showPicker === 'function') {
        void input.showPicker();
        return;
      }
    } catch {
      /* fallback */
    }
    input.focus({ preventScroll: true });
    input.click();
  }

  private bindThemeColorInputs(): void {
    for (const input of this.root.querySelectorAll<HTMLInputElement>(
      '.settings-theme-color',
    )) {
      this.paintColorSwatch(input);
      const swatch = input.closest('label.settings-color-swatch');
      swatch?.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        this.openThemeColorPicker(input);
      });
      const onColorInput = (): void => {
        const key = input.dataset.themeKey as
          | 'themeBackground'
          | 'themeUi'
          | 'themeText'
          | undefined;
        if (!key) return;
        const next = normalizeHex(input.value, this.themeColorFallback(key));
        this.paintColorSwatch(input, next);
        if (this.state[key] === next) return;
        this.state[key] = next;
        this.scheduleThemePaletteCssApply();
      };
      input.addEventListener('input', () => {
        onColorInput();
        requestAnimationFrame(() => this.paintColorSwatch(input));
      });
      input.addEventListener('change', () => {
        this.paintColorSwatch(input);
        this.flushThemePaletteApply(true);
      });
    }
  }

  /** 拖动选色时只刷新 CSS 变量，避免卡顿 */
  private scheduleThemePaletteCssApply(): void {
    if (this.themePaletteApplyTimer) clearTimeout(this.themePaletteApplyTimer);
    this.themePaletteApplyTimer = setTimeout(() => {
      this.themePaletteApplyTimer = null;
      applyThemePaletteToDocument(this.themePaletteFromState());
    }, 64);
  }

  private flushThemePaletteApply(persist: boolean): void {
    if (this.themePaletteApplyTimer) {
      clearTimeout(this.themePaletteApplyTimer);
      this.themePaletteApplyTimer = null;
    }
    this.applyThemePalette();
    if (persist) this.persistState();
  }

  private applyThemePalette(): void {
    applyThemePaletteToDocument(this.themePaletteFromState());
    for (const pane of this.panes.values()) {
      pane.refreshTerminalTheme();
    }
  }

  private resetThemeColorsToDefault(): void {
    const d = defaultThemePalette();
    this.state.themeBackground = d.background;
    this.state.themeUi = d.ui;
    this.state.themeText = d.text;
    this.syncThemeColorInputs();
    this.applyThemePalette();
    this.persistState();
  }

  private applyChromeVisibility(): void {
    this.root.classList.toggle('hint-bar-hidden', this.state.hideHintBar);
    this.syncHostMetricsPolling();
    this.root.classList.toggle('tab-bar-auto-hide', this.state.hideTabBar);
    if (!this.state.hideTabBar) {
      this.tabBarStrip.classList.remove('tab-bar-revealed');
      if (this.tabBarHideTimer) {
        clearTimeout(this.tabBarHideTimer);
        this.tabBarHideTimer = null;
      }
    }
  }

  private bindTabBarEdgeReveal(): void {
    const EDGE_PX = 12;
    const HIDE_DELAY_MS = 400;

    const showTabBar = () => {
      if (!this.state.hideTabBar) return;
      if (this.tabBarHideTimer) {
        clearTimeout(this.tabBarHideTimer);
        this.tabBarHideTimer = null;
      }
      this.tabBarStrip.classList.add('tab-bar-revealed');
    };

    const scheduleHideTabBar = () => {
      if (!this.state.hideTabBar) return;
      if (this.tabBarHideTimer) return;
      this.tabBarHideTimer = setTimeout(() => {
        this.tabBarHideTimer = null;
        this.tabBarStrip.classList.remove('tab-bar-revealed');
      }, HIDE_DELAY_MS);
    };

    const pointerNearTabEdge = (clientX: number, clientY: number): boolean => {
      const pos = this.state.tabBarPosition;
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (pos === 'top') return clientY <= EDGE_PX;
      if (pos === 'bottom') return clientY >= h - EDGE_PX;
      if (pos === 'left') return clientX <= EDGE_PX;
      if (pos === 'right') return clientX >= w - EDGE_PX;
      return false;
    };

    const pointerOverRevealedTabStrip = (clientX: number, clientY: number): boolean => {
      if (!this.tabBarStrip.classList.contains('tab-bar-revealed')) return false;
      const r = this.tabBarStrip.getBoundingClientRect();
      return (
        clientX >= r.left &&
        clientX <= r.right &&
        clientY >= r.top &&
        clientY <= r.bottom
      );
    };

    const shouldKeepTabBarVisible = (clientX: number, clientY: number): boolean =>
      pointerNearTabEdge(clientX, clientY) ||
      pointerOverRevealedTabStrip(clientX, clientY);

    document.addEventListener(
      'mousemove',
      (ev) => {
        if (!this.state.hideTabBar) return;
        if (!this.settingsOverlay.hidden) return;

        if (shouldKeepTabBarVisible(ev.clientX, ev.clientY)) {
          showTabBar();
          return;
        }

        if (this.tabBarStrip.classList.contains('tab-bar-revealed')) {
          scheduleHideTabBar();
        }
      },
      { passive: true },
    );

    this.tabBarStrip.addEventListener('mouseleave', () => {
      if (!this.state.hideTabBar) return;
      scheduleHideTabBar();
    });

    document.addEventListener('mouseleave', () => {
      if (!this.state.hideTabBar) return;
      scheduleHideTabBar();
    });
  }

  private persistState(): void {
    if (this.applyingRemote || !this.uiReady) return;
    pushState(this.state);
  }

  private activeTab(): TabState {
    return this.state.tabs.find((t) => t.id === this.state.activeTabId)!;
  }

  private getOrCreatePane(paneId: string): TerminalPane {
    let pane = this.panes.get(paneId);
    if (!pane) {
      pane = new TerminalPane(
        paneId,
        () => {
          const tab = this.activeTab();
          if (tab.activePaneId !== paneId) {
            tab.activePaneId = paneId;
            this.updateActiveStyles();
            this.persistState();
          }
        },
        (ev, id) => this.handleShortcut(ev, id),
        () => this.resolveAttachConnection(paneId),
        () => this.state.terminalScrollbackLines,
        () => this.closePaneById(paneId),
      );
      this.panes.set(paneId, pane);
    }
    return pane;
  }

  private applyTerminalScrollback(): void {
    const lines = clampScrollbackLines(this.state.terminalScrollbackLines);
    this.state.terminalScrollbackLines = lines;
    if (lines === this.appliedScrollbackLines) return;
    this.appliedScrollbackLines = lines;
    for (const pane of this.panes.values()) {
      pane.setScrollbackLines(lines);
    }
  }

  private disposeTabPanes(tab: TabState): void {
    for (const id of collectPaneIds(tab.layout)) {
      this.panes.get(id)?.dispose();
      this.panes.delete(id);
      this.sshSessionPasswordByPane.delete(id);
    }
  }

  private syncAllPanes(): void {
    const ids = new Set<string>();
    for (const tab of this.state.tabs) {
      for (const id of collectPaneIds(tab.layout)) ids.add(id);
    }
    for (const [id, pane] of this.panes) {
      if (!ids.has(id)) {
        pane.dispose();
        this.panes.delete(id);
        this.sshSessionPasswordByPane.delete(id);
      }
    }
  }

  private closeTab(tabId: string): void {
    const idx = this.state.tabs.findIndex((t) => t.id === tabId);
    if (idx < 0) return;

    this.removeTabWorkspaceHost(tabId);
    this.disposeTabPanes(this.state.tabs[idx]);

    if (this.state.tabs.length <= 1) {
      const fresh = createTab('终端 1');
      this.state.tabs = [fresh];
      this.state.activeTabId = fresh.id;
    } else {
      this.state.tabs.splice(idx, 1);
      if (this.state.activeTabId === tabId) {
        const next = this.state.tabs[Math.min(idx, this.state.tabs.length - 1)];
        this.state.activeTabId = next.id;
      }
    }

    this.persistState();
    this.renderTabs();
    this.renderWorkspace();
    this.onActiveTabChanged();
  }

  private startTabRename(tab: TabState, tabEl: HTMLElement): void {
    const label = tabEl.querySelector('.tab-label') as HTMLElement | null;
    if (!label) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'tab-rename-input';
    input.value = tab.title;
    label.replaceWith(input);
    input.focus();
    input.select();

    const finish = (save: boolean) => {
      if (save) {
        const next = input.value.trim();
        if (next) tab.title = next;
        this.persistState();
      }
      this.renderTabs();
    };

    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        input.blur();
      }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        finish(false);
      }
      ev.stopPropagation();
    });
  }

  private isVerticalTabBar(): boolean {
    return (
      this.root.classList.contains('tab-pos-left') ||
      this.root.classList.contains('tab-pos-right')
    );
  }

  private tabInsertIndexFromPointer(ev: MouseEvent): number {
    const tabs = [
      ...this.tabBar.querySelectorAll(':scope > .tab:not(.tab-add)'),
    ] as HTMLElement[];
    const vertical = this.isVerticalTabBar();
    const pos = vertical ? ev.clientY : ev.clientX;

    for (let i = 0; i < tabs.length; i++) {
      const rect = tabs[i].getBoundingClientRect();
      const mid = vertical
        ? rect.top + rect.height / 2
        : rect.left + rect.width / 2;
      if (pos < mid) {
        const id = tabs[i].dataset.tabId;
        const idx = this.state.tabs.findIndex((t) => t.id === id);
        return idx >= 0 ? idx : i;
      }
    }
    return this.state.tabs.length;
  }

  private moveTab(tabId: string, insertIndex: number): void {
    const from = this.state.tabs.findIndex((t) => t.id === tabId);
    if (from < 0) return;

    let to = Math.max(0, Math.min(insertIndex, this.state.tabs.length));
    if (from < to) to -= 1;
    if (from === to) return;

    const [item] = this.state.tabs.splice(from, 1);
    this.state.tabs.splice(to, 0, item);
    this.persistState();
    this.renderTabs();
  }

  private tabOrderFromDom(): string[] {
    return [...this.tabBar.querySelectorAll(':scope > .tab:not(.tab-add)')]
      .map((el) => (el as HTMLElement).dataset.tabId)
      .filter((id): id is string => !!id);
  }

  private syncTabStateOrderFromDom(): boolean {
    const order = this.tabOrderFromDom();
    if (order.length !== this.state.tabs.length) return false;
    const byId = new Map(this.state.tabs.map((t) => [t.id, t]));
    const next: TabState[] = [];
    for (const id of order) {
      const tab = byId.get(id);
      if (!tab) return false;
      next.push(tab);
    }
    const changed = next.some((t, i) => t.id !== this.state.tabs[i]?.id);
    if (changed) this.state.tabs = next;
    return changed;
  }

  /** 拖动过程中实时调整 DOM 顺序（与服务管理列表一致） */
  private liveReorderTabDuringDrag(
    dragTabEl: HTMLElement,
    ev: MouseEvent,
  ): void {
    const tabs = [
      ...this.tabBar.querySelectorAll(':scope > .tab:not(.tab-add)'),
    ] as HTMLElement[];
    const vertical = this.isVerticalTabBar();
    const pos = vertical ? ev.clientY : ev.clientX;

    for (const target of tabs) {
      if (target === dragTabEl) continue;
      const rect = target.getBoundingClientRect();
      const mid = vertical
        ? rect.top + rect.height / 2
        : rect.left + rect.width / 2;
      if (pos < mid) {
        if (dragTabEl.nextElementSibling !== target) {
          target.before(dragTabEl);
        }
        return;
      }
    }

    const addBtn = this.tabBar.querySelector('.tab-add');
    if (addBtn && dragTabEl.nextElementSibling !== addBtn) {
      addBtn.before(dragTabEl);
    }
  }

  private setupTabDrag(tabEl: HTMLElement, tabId: string): void {
    let startX = 0;
    let startY = 0;
    let dragging = false;

    tabEl.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest('.tab-close')) return;

      startX = ev.clientX;
      startY = ev.clientY;
      dragging = false;
      let suppressedClick = false;

      const onMove = (moveEv: MouseEvent) => {
        const dx = Math.abs(moveEv.clientX - startX);
        const dy = Math.abs(moveEv.clientY - startY);
        if (!dragging && dx < 5 && dy < 5) return;

        if (!dragging) {
          dragging = true;
          suppressedClick = true;
          tabEl.classList.add('tab-dragging');
          document.body.classList.add('tab-drag-active');
        }
        this.liveReorderTabDuringDrag(tabEl, moveEv);
      };

      const onUp = (upEv: MouseEvent) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        tabEl.classList.remove('tab-dragging');
        document.body.classList.remove('tab-drag-active');

        if (dragging) {
          this.liveReorderTabDuringDrag(tabEl, upEv);
          if (this.syncTabStateOrderFromDom()) {
            this.persistState();
          }
        }

        if (suppressedClick) {
          const suppressClick = (e: MouseEvent) => {
            e.stopPropagation();
            e.preventDefault();
            tabEl.removeEventListener('click', suppressClick, true);
          };
          tabEl.addEventListener('click', suppressClick, true);
        }
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  private renderTabs(): void {
    this.tabBar.replaceChildren();
    this.state.tabs.forEach((tab, index) => {
      const tabEl = document.createElement('div');
      tabEl.className =
        'tab' + (tab.id === this.state.activeTabId ? ' active' : '');
      tabEl.role = 'tab';
      tabEl.tabIndex = 0;
      tabEl.dataset.tabId = tab.id;

      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = tab.title || `终端 ${index + 1}`;
      label.title = '双击重命名';
      label.addEventListener('dblclick', (ev) => {
        ev.stopPropagation();
        this.startTabRename(tab, tabEl);
      });

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'tab-close';
      closeBtn.title = '关闭标签';
      closeBtn.setAttribute('aria-label', '关闭标签');
      closeBtn.textContent = '×';
      closeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.closeTab(tab.id);
      });

      tabEl.appendChild(label);
      tabEl.appendChild(closeBtn);

      tabEl.addEventListener('click', () => {
        if (this.state.activeTabId === tab.id) return;
        this.state.activeTabId = tab.id;
        this.persistState();
        this.renderTabs();
        this.renderWorkspace({ focusActivePane: true });
        this.onActiveTabChanged();
      });

      this.setupTabDrag(tabEl, tab.id);
      this.tabBar.appendChild(tabEl);
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tab tab-add';
    addBtn.title = '新建标签';
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => {
      void this.openNewTabPicker();
    });
    this.tabBar.appendChild(addBtn);
  }

  private removeTabWorkspaceHost(tabId: string): void {
    this.tabWorkspaceHosts.get(tabId)?.remove();
    this.tabWorkspaceHosts.delete(tabId);
    this.tabLayoutSignatures.delete(tabId);
  }

  private getOrCreateTabWorkspaceHost(tabId: string): HTMLElement {
    let host = this.tabWorkspaceHosts.get(tabId);
    if (!host) {
      host = document.createElement('div');
      host.className = 'tab-workspace';
      host.dataset.tabId = tabId;
      this.workspace.appendChild(host);
      this.tabWorkspaceHosts.set(tabId, host);
    }
    return host;
  }

  private ensureTabWorkspaceRendered(tab: TabState): void {
    const host = this.getOrCreateTabWorkspaceHost(tab.id);
    const sig = layoutSignature(tab.layout);
    if (this.tabLayoutSignatures.get(tab.id) === sig) return;

    renderSplitView(host, {
      getLayout: () => {
        const current = this.state.tabs.find((t) => t.id === tab.id);
        return current?.layout ?? tab.layout;
      },
      getPane: (paneId) => this.getOrCreatePane(paneId),
      onResizeLayout: (layout) => {
        const current = this.state.tabs.find((t) => t.id === tab.id);
        if (!current) return;
        current.layout = layout;
        this.tabLayoutSignatures.set(tab.id, layoutSignature(layout));
        applySplitLayoutSizes(host, layout);
      },
      onResizeEnd: () => {
        if (this.state.activeTabId === tab.id) {
          this.fitAllPanes(tab, true);
        }
        this.persistState();
      },
      onLayoutReady: () => {
        if (this.state.activeTabId === tab.id) {
          this.schedulePaneLayoutPass(tab);
        }
      },
    });
    this.tabLayoutSignatures.set(tab.id, sig);
  }

  /** split / 标签页显示后多帧 refit，避免 flex 未稳定时锁死错误终端行数 */
  private schedulePaneLayoutPass(tab: TabState): void {
    const run = () => this.fitAllPanes(tab, true);
    run();
    requestAnimationFrame(() => {
      run();
      requestAnimationFrame(run);
    });
  }

  private renderWorkspace(options?: { focusActivePane?: boolean }): void {
    const tab = this.activeTab();
    this.ensureActivePane(tab);
    this.syncAllPanes();

    for (const t of this.state.tabs) {
      this.ensureTabWorkspaceRendered(t);
    }

    for (const t of this.state.tabs) {
      const host = this.tabWorkspaceHosts.get(t.id);
      if (host) host.hidden = t.id !== tab.id;
    }

    for (const [tabId, host] of this.tabWorkspaceHosts) {
      if (!this.state.tabs.some((t) => t.id === tabId)) {
        host.remove();
        this.tabWorkspaceHosts.delete(tabId);
        this.tabLayoutSignatures.delete(tabId);
      }
    }

    this.updateActiveStyles();
    this.schedulePaneLayoutPass(tab);
    requestAnimationFrame(() => {
      if (options?.focusActivePane) {
        this.getOrCreatePane(tab.activePaneId).focus();
      }
    });
  }

  private fitAllPanes(tab: TabState, force = false): void {
    for (const id of collectPaneIds(tab.layout)) {
      const pane = this.getOrCreatePane(id);
      if (force) pane.forceLayout();
      else pane.fitResize();
    }
  }

  private updateActiveStyles(): void {
    const tab = this.activeTab();
    for (const id of collectPaneIds(tab.layout)) {
      this.getOrCreatePane(id).setActive(id === tab.activePaneId);
    }
  }

  private ensureActivePane(tab: TabState): void {
    const ids = collectPaneIds(tab.layout);
    if (!ids.includes(tab.activePaneId)) {
      tab.activePaneId = firstPaneId(tab.layout);
    }
  }

  private applySplit(
    direction: SplitDirection,
    side: SplitSide,
  ): void {
    const tab = this.activeTab();
    this.ensureActivePane(tab);
    const splitFromId = tab.activePaneId;
    const { layout, newPaneId, applied } = splitPane(
      tab.layout,
      splitFromId,
      direction,
      side,
    );
    if (!applied) return;
    const sessionPwd = this.sshSessionPasswordByPane.get(splitFromId);
    if (sessionPwd) this.sshSessionPasswordByPane.set(newPaneId, sessionPwd);
    tab.layout = layout;
    tab.activePaneId = newPaneId;
    this.persistState();
    this.renderWorkspace({ focusActivePane: true });
  }

  private handleShortcut(ev: KeyboardEvent, fromPaneId?: string): boolean {
    const alt =
      ev.altKey || ev.getModifierState('Alt') || ev.getModifierState('AltGraph');
    if (!alt || ev.ctrlKey || ev.metaKey) return false;

    const tab = this.activeTab();
    if (fromPaneId) {
      tab.activePaneId = fromPaneId;
      this.updateActiveStyles();
      this.persistState();
    } else {
      const paneEl = (ev.target as HTMLElement | null)?.closest(
        '.terminal-pane[data-pane-id]',
      ) as HTMLElement | null;
      const paneId = paneEl?.dataset.paneId;
      if (paneId && collectPaneIds(tab.layout).includes(paneId)) {
        tab.activePaneId = paneId;
        this.updateActiveStyles();
      }
    }
    this.ensureActivePane(tab);

    const paneId = tab.activePaneId;

    const arrowMap: Record<string, [SplitDirection, SplitSide]> = {
      ArrowRight: ['row', 'after'],
      ArrowLeft: ['row', 'before'],
      ArrowDown: ['column', 'after'],
      ArrowUp: ['column', 'before'],
    };

    const arrowCodeMap: Record<string, [SplitDirection, SplitSide]> = {
      ArrowRight: arrowMap.ArrowRight,
      ArrowLeft: arrowMap.ArrowLeft,
      ArrowDown: arrowMap.ArrowDown,
      ArrowUp: arrowMap.ArrowUp,
    };

    if (ev.key === 'q' || ev.key === 'Q' || ev.code === 'KeyQ') {
      ev.preventDefault();
      ev.stopPropagation();
      this.cyclePaneInTab(ev.shiftKey ? -1 : 1);
      return true;
    }

    const split = arrowMap[ev.key] ?? arrowCodeMap[ev.code];
    if (split) {
      ev.preventDefault();
      ev.stopPropagation();
      const [dir, side] = split;
      this.applySplit(dir, side);
      return true;
    }

    if (ev.key === 'Backspace') {
      const count = collectPaneIds(tab.layout).length;
      if (count <= 1) return false;
      ev.preventDefault();
      ev.stopPropagation();
      this.closePaneById(paneId);
      return true;
    }

    return false;
  }

  private closePaneById(paneId: string): void {
    const tab = this.activeTab();
    if (collectPaneIds(tab.layout).length <= 1) return;
    const next = closePane(tab.layout, paneId);
    if (!next) return;
    tab.layout = next;
    const rest = collectPaneIds(tab.layout);
    // 关掉的是当前窗口（Esc / Alt+Backspace）→ 回到同 tab 的第一个窗口并聚焦
    if (paneId === tab.activePaneId || !rest.includes(tab.activePaneId)) {
      tab.activePaneId = firstPaneId(tab.layout);
    }
    this.persistState();
    this.renderWorkspace({ focusActivePane: true });
  }

  /** Alt+Q：在同 tab 的窗口之间切换（按视觉顺序，Shift 反向） */
  private cyclePaneInTab(step: number): void {
    const tab = this.activeTab();
    const all = collectPaneIds(tab.layout);
    if (all.length < 2) {
      this.getOrCreatePane(tab.activePaneId).focus();
      return;
    }
    const host = this.tabWorkspaceHosts.get(tab.id);
    const domOrder = host
      ? [...host.querySelectorAll<HTMLElement>('.terminal-pane[data-pane-id]')]
          .map((el) => el.dataset.paneId)
          .filter((id): id is string => !!id && all.includes(id))
      : [];
    const ids = domOrder.length === all.length ? domOrder : all;
    const idx = ids.indexOf(tab.activePaneId);
    const next = ids[(((idx + step) % ids.length) + ids.length) % ids.length];
    if (!next || next === tab.activePaneId) return;
    tab.activePaneId = next;
    this.updateActiveStyles();
    this.persistState();
    this.getOrCreatePane(next).focus();
  }

  private bindKeys(): void {
    window.addEventListener(
      'keydown',
      (ev) => {
        this.handleShortcut(ev);
      },
      true,
    );
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
