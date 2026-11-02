import type {
  AppState,
  LayoutNode,
  PaneConnection,
  TabBarPosition,
  TabState,
  VisualStyle,
} from './types';
import { defaultThemePalette, normalizeThemePalette } from './theme-color';
import { parseScrollbackLinesFromState } from './terminal-scrollback';
import { collectPaneIds, createDefaultLayout, firstPaneId } from './layout';
import { randomId } from './uuid';

const STORAGE_KEY = 'browser-terminal-state-v1';

export function saveAppState(state: AppState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota / private mode */
  }
}

export function loadAppState(): AppState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return validateAppState(JSON.parse(raw));
  } catch {
    return null;
  }
}

function isPaneConnection(v: unknown): v is PaneConnection {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.kind === 'local') return true;
  if (o.kind === 'ssh' && typeof o.profileId === 'string' && o.profileId.length > 0) {
    return true;
  }
  return false;
}

function isLayoutNode(v: unknown): v is LayoutNode {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (o.type === 'pane') {
    if (typeof o.paneId !== 'string' || o.paneId.length === 0) return false;
    if (o.connection !== undefined && !isPaneConnection(o.connection)) return false;
    return true;
  }
  if (o.type === 'split') {
    if (o.direction !== 'row' && o.direction !== 'column') return false;
    if (!Array.isArray(o.children) || !Array.isArray(o.sizes)) return false;
    if (o.children.length !== o.sizes.length || o.children.length < 2) return false;
    if (!o.children.every(isLayoutNode)) return false;
    if (!o.sizes.every((s) => typeof s === 'number' && s > 0)) return false;
    return true;
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
  return {
    id: o.id,
    title: o.title,
    layout: o.layout,
    activePaneId,
  };
}

function validateAppState(v: unknown): AppState | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.tabs) || o.tabs.length === 0) return null;
  const tabs = o.tabs.map(validateTab).filter((t): t is TabState => t !== null);
  if (tabs.length === 0) return null;
  const activeTabId =
    typeof o.activeTabId === 'string' && tabs.some((t) => t.id === o.activeTabId)
      ? o.activeTabId
      : tabs[0].id;
  const tabBarPosition = parseTabBarPosition(o.tabBarPosition);
  const terminalScrollbackLines = parseScrollbackLinesFromState(
    o.terminalScrollbackLines,
  );
  const browserSessionLimit = Math.max(
    1,
    Math.min(8, Math.trunc(Number(o.browserSessionLimit)) || 3),
  );
  const hideHintBar = parseUiBool(o.hideHintBar);
  const hideTabBar = parseUiBool(o.hideTabBar);
  const visualStyle = parseVisualStyle(o.visualStyle);
  const theme = normalizeThemePalette(o as Record<string, unknown>);
  return {
    tabs,
    activeTabId,
    tabBarPosition,
    terminalScrollbackLines,
    browserSessionLimit,
    hideHintBar,
    hideTabBar,
    visualStyle,
    themeBackground: theme.background,
    themeUi: theme.ui,
    themeText: theme.text,
  };
}

function parseUiBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function parseTabBarPosition(v: unknown): TabBarPosition {
  if (v === 'top' || v === 'bottom' || v === 'left' || v === 'right') return v;
  return 'top';
}

function parseVisualStyle(v: unknown): VisualStyle {
  if (v === 'gradient') return 'gradient';
  return 'flat';
}

export function createDefaultAppState(): AppState {
  const tab = {
    id: randomId(),
    title: '终端 1',
    layout: createDefaultLayout(),
    activePaneId: '',
  };
  tab.activePaneId = firstPaneId(tab.layout);
  return {
    tabs: [tab],
    activeTabId: tab.id,
    tabBarPosition: 'top',
    terminalScrollbackLines: parseScrollbackLinesFromState(undefined),
    browserSessionLimit: 3,
    hideHintBar: false,
    hideTabBar: false,
    visualStyle: 'flat',
    ...(() => {
      const t = defaultThemePalette();
      return {
        themeBackground: t.background,
        themeUi: t.ui,
        themeText: t.text,
      };
    })(),
  };
}
