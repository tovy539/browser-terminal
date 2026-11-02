import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseScrollbackLinesFromState } from './scrollback-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type TabBarPosition = 'top' | 'bottom' | 'left' | 'right';

export type VisualStyle = 'flat' | 'gradient';

export type LayoutNode =
  | { type: 'pane'; paneId: string }
  | {
      type: 'split';
      direction: 'row' | 'column';
      sizes: number[];
      children: LayoutNode[];
    };

export interface TabState {
  id: string;
  title: string;
  layout: LayoutNode;
  activePaneId: string;
}

export interface AppState {
  tabs: TabState[];
  activeTabId: string;
  tabBarPosition: TabBarPosition;
  /** xterm scrollback 行数（所有客户端共享） */
  terminalScrollbackLines?: number;
  /** 同时允许的无头浏览器会话数（1–8，默认 3） */
  browserSessionLimit?: number;
  hideHintBar?: boolean;
  hideTabBar?: boolean;
  visualStyle?: VisualStyle;
  themeBackground?: string;
  themeUi?: string;
  themeText?: string;
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

function firstPaneId(layout: LayoutNode): string {
  if (layout.type === 'pane') return layout.paneId;
  return firstPaneId(layout.children[0]);
}

function collectPaneIds(layout: LayoutNode): string[] {
  if (layout.type === 'pane') return [layout.paneId];
  return layout.children.flatMap(collectPaneIds);
}

function isLayoutNode(v: unknown): v is LayoutNode {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.type === 'pane') {
    if (typeof o.paneId !== 'string' || o.paneId.length === 0) return false;
    const conn = o.connection;
    if (conn == null) return true;
    if (typeof conn !== 'object') return false;
    const c = conn as Record<string, unknown>;
    if (c.kind === 'local') return true;
    return (
      c.kind === 'ssh' &&
      typeof c.profileId === 'string' &&
      c.profileId.length > 0
    );
  }
  if (o.type === 'split') {
    if (o.direction !== 'row' && o.direction !== 'column') return false;
    if (!Array.isArray(o.children) || !Array.isArray(o.sizes)) return false;
    if (o.children.length !== o.sizes.length || o.children.length < 2) return false;
    return o.children.every(isLayoutNode) && o.sizes.every((s) => typeof s === 'number' && s > 0);
  }
  return false;
}

function validateTab(v: unknown): TabState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.title !== 'string') return null;
  if (!isLayoutNode(o.layout)) return null;
  const paneIds = collectPaneIds(o.layout);
  if (paneIds.length === 0) return null;
  const activePaneId =
    typeof o.activePaneId === 'string' && paneIds.includes(o.activePaneId)
      ? o.activePaneId
      : firstPaneId(o.layout);
  return { id: o.id, title: o.title, layout: o.layout, activePaneId };
}

export function validateAppState(v: unknown): AppState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.tabs) || o.tabs.length === 0) return null;
  const tabs = o.tabs.map(validateTab).filter((t): t is TabState => t !== null);
  if (tabs.length === 0) return null;
  const activeTabId =
    typeof o.activeTabId === 'string' && tabs.some((t) => t.id === o.activeTabId)
      ? o.activeTabId
      : tabs[0].id;
  const tabBarPosition =
    o.tabBarPosition === 'bottom' ||
    o.tabBarPosition === 'left' ||
    o.tabBarPosition === 'right'
      ? o.tabBarPosition
      : 'top';
  const terminalScrollbackLines = parseScrollbackLinesFromState(
    o.terminalScrollbackLines,
  );
  const browserSessionLimit = parseBrowserSessionLimit(o.browserSessionLimit);
  const hideHintBar = parseUiBool(o.hideHintBar);
  const hideTabBar = parseUiBool(o.hideTabBar);
  const visualStyle = parseVisualStyle(o.visualStyle);
  return {
    tabs,
    activeTabId,
    tabBarPosition,
    terminalScrollbackLines,
    browserSessionLimit,
    hideHintBar,
    hideTabBar,
    visualStyle,
    themeBackground: parseHexColor(o.themeBackground, '#252526'),
    themeUi: parseHexColor(o.themeUi, '#2d2d2d'),
    themeText: parseHexColor(o.themeText, '#cccccc'),
  };
}

/** 浏览器会话上限：1–8，默认 3 */
function parseBrowserSessionLimit(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(8, Math.trunc(n)));
}

function parseHexColor(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback;
  let t = v.trim();
  if (!t.startsWith('#')) t = `#${t}`;
  if (/^#[0-9a-fA-F]{3}$/.test(t)) {
    t = `#${t[1]}${t[1]}${t[2]}${t[2]}${t[3]}${t[3]}`;
  }
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
  return fallback;
}

function parseVisualStyle(v: unknown): VisualStyle {
  if (v === 'gradient') return 'gradient';
  return 'flat';
}

function parseUiBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

export function createDefaultAppState(): AppState {
  const paneId = randomId();
  const tabId = randomId();
  return {
    tabs: [
      {
        id: tabId,
        title: '终端 1',
        layout: { type: 'pane', paneId },
        activePaneId: paneId,
      },
    ],
    activeTabId: tabId,
    tabBarPosition: 'top',
    terminalScrollbackLines: parseScrollbackLinesFromState(undefined),
    browserSessionLimit: 3,
    hideHintBar: false,
    hideTabBar: false,
    visualStyle: 'flat',
    themeBackground: '#252526',
    themeUi: '#2d2d2d',
    themeText: '#cccccc',
  };
}

const stateFile =
  process.env.SHARED_STATE_FILE ||
  path.join(__dirname, '../.run/shared-app-state.json');

export class SharedAppState {
  private state: AppState;
  revision = 0;

  constructor() {
    this.state = this.loadFromDisk() ?? createDefaultAppState();
  }

  get(): AppState {
    return this.state;
  }

  collectAllPaneIds(): Set<string> {
    const ids = new Set<string>();
    for (const tab of this.state.tabs) {
      for (const id of collectPaneIds(tab.layout)) ids.add(id);
    }
    return ids;
  }

  tryUpdate(next: unknown, baseRevision: number): { ok: true } | { ok: false } {
    if (baseRevision !== this.revision) return { ok: false };
    const validated = validateAppState(next);
    if (!validated) return { ok: false };
    this.state = validated;
    this.revision += 1;
    this.saveToDisk();
    return { ok: true };
  }

  private loadFromDisk(): AppState | null {
    try {
      if (!fs.existsSync(stateFile)) return null;
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as {
        state?: unknown;
        revision?: number;
      };
      const validated = validateAppState(raw.state);
      if (!validated) return null;
      if (typeof raw.revision === 'number') this.revision = raw.revision;
      return validated;
    } catch {
      return null;
    }
  }

  private saveToDisk(): void {
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ revision: this.revision, state: this.state }),
      );
    } catch {
      /* ignore */
    }
  }
}
