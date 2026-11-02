export type SplitDirection = 'row' | 'column';

export type PaneConnection =
  | { kind: 'local' }
  | { kind: 'ssh'; profileId: string };

/** WebSocket attach 时传递；sessionPassword 不落盘、不进共享状态 */
export type TerminalAttachConnection =
  | { kind: 'local' }
  | { kind: 'ssh'; profileId: string; sessionPassword?: string };

export interface PaneNode {
  type: 'pane';
  paneId: string;
  connection?: PaneConnection;
}

export interface SplitNode {
  type: 'split';
  direction: SplitDirection;
  /** 各子区域占比，总和为 1 */
  sizes: number[];
  children: LayoutNode[];
}

export type LayoutNode = PaneNode | SplitNode;

export interface TabState {
  id: string;
  title: string;
  layout: LayoutNode;
  activePaneId: string;
}

export type TabBarPosition = 'top' | 'bottom' | 'left' | 'right';

/** 界面视觉：纯色（默认）或全局渐变 */
export type VisualStyle = 'flat' | 'gradient';

export interface AppState {
  tabs: TabState[];
  activeTabId: string;
  tabBarPosition: TabBarPosition;
  /** xterm scrollback 行数 */
  terminalScrollbackLines: number;
  /** 同时允许的无头浏览器会话数（1–8） */
  browserSessionLimit: number;
  /** 隐藏底部快捷键提示栏 */
  hideHintBar: boolean;
  /** 隐藏标签栏（靠近配置的边缘时滑出） */
  hideTabBar: boolean;
  /** 界面风格：flat 纯色，gradient 渐变 */
  visualStyle: VisualStyle;
  /** 全局背景色 */
  themeBackground: string;
  /** 全局 UI 组件底色 */
  themeUi: string;
  /** 全局文字色 */
  themeText: string;
}
