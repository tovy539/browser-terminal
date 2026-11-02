type MessageHandler = (msg: WsMessage) => void;
type OpenHandler = () => void;
type StateHandler = (connected: boolean) => void;

export interface WsMessage {
  type: string;
  sessionId?: string;
  clientPaneId?: string;
  data?: string;
  state?: unknown;
  revision?: number;
  /** code_open 时可选：让 code-server 打开的文件 */
  file?: string;
  /** download 时的下载地址（相对部署根，例如 dl/xxx）*/
  url?: string;
  /** download 时的文件名 */
  name?: string;
  /** download 会话 id（查询进度用） */
  id?: string;
  /** 终端里 download 命令的请求 id（用于把进度回写到对应进程） */
  reqId?: string;
  /** download_error 的错误信息 */
  error?: string;
  /** upload 的目标目录 */
  dir?: string;
  /** 浏览器页面标题 */
  title?: string;
  /** 浏览器音频是否可用 */
  ok?: boolean;
  /** 浏览器标签页列表 */
  tabs?: { targetId: string; title?: string; url?: string }[];
  activeTargetId?: string;
  /** 浏览器消息：错误码（no-browser）、下载地址、安装命令、查找过的路径 */
  code?: string;
  downloadUrl?: string;
  installCommand?: string;
  searched?: string[];
  /** 浏览器消息：分辨率/错误信息/关闭原因 */
  width?: number;
  height?: number;
  message?: string;
  reason?: string;
  loading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;

}

export class TerminalSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private binaryHandlers = new Set<(data: ArrayBuffer) => void>();
  private openHandlers = new Set<OpenHandler>();
  private pending: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stateHandlers = new Set<StateHandler>();
  /** 之前成功连接过（避免首次打开就弹断线提示） */
  private openedOnce = false;
  /** 主动关闭（退出登录）后不再重连、不再提示 */
  private closedByUser = false;

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);

    this.ws.onopen = () => {
      this.openedOnce = true;
      this.emitState(true);
      const queue = this.pending;
      this.pending = [];
      for (const raw of queue) {
        this.ws?.send(raw);
      }
      for (const h of this.openHandlers) h();
    };

    this.ws.binaryType = 'arraybuffer';
    this.ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        for (const h of this.binaryHandlers) h(ev.data);
        return;
      }
      try {
        const msg = JSON.parse(ev.data as string) as WsMessage;
        for (const h of this.handlers) h(msg);
      } catch {
        /* ignore */
      }
    };

    this.ws.onclose = () => {
      this.ws = null;
      if (this.openedOnce && !this.closedByUser) this.emitState(false);
      if (this.closedByUser) return;
      if (!this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 800);
      }
    };
  }

  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler);
    if (this.ws?.readyState === WebSocket.OPEN) {
      handler();
    }
    return () => this.openHandlers.delete(handler);
  }

  /** 连接状态变化（断开/恢复） */
  onState(handler: StateHandler): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  private emitState(connected: boolean): void {
    for (const h of this.stateHandlers) h(connected);
  }

  /** 主动关闭（退出登录等）：不再自动重连 */
  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  onBinary(handler: (data: ArrayBuffer) => void): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  send(payload: Record<string, unknown>): void {
    const raw = JSON.stringify(payload);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(raw);
      return;
    }
    this.pending.push(raw);
    this.connect();
  }

  attach(
    clientPaneId: string,
    sessionId: string | undefined,
    cols: number,
    rows: number,
    connection?:
      | { kind: 'local' }
      | { kind: 'ssh'; profileId: string; sessionPassword?: string },
  ): void {
    // baseUrl 让服务端知道浏览器实际访问的地址（可能带 nginx 子路径），远端窗口里的 cs 用它回调
    this.send({
      type: 'attach',
      clientPaneId,
      sessionId,
      cols,
      rows,
      connection,
      baseUrl: document.baseURI,
    });
  }

  input(sessionId: string, data: string): void {
    this.send({ type: 'input', sessionId, data });
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.send({ type: 'resize', sessionId, cols, rows });
  }

  detach(sessionId: string): void {
    this.send({ type: 'detach', sessionId });
  }

  pushState(state: unknown, baseRevision: number): void {
    this.send({ type: 'push_state', state, baseRevision });
  }
}

export const terminalSocket = new TerminalSocket();
