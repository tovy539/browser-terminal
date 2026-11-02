export const DEFAULT_THEME_BACKGROUND = '#252526';
export const DEFAULT_THEME_UI = '#2d2d2d';
export const DEFAULT_THEME_TEXT = '#cccccc';

export interface ThemePalette {
  background: string;
  ui: string;
  text: string;
}

export function defaultThemePalette(): ThemePalette {
  return {
    background: DEFAULT_THEME_BACKGROUND,
    ui: DEFAULT_THEME_UI,
    text: DEFAULT_THEME_TEXT,
  };
}

export function normalizeHex(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const expanded = expandHex(raw.trim());
  if (!expanded) return fallback;
  return expanded.toLowerCase();
}

export function normalizeThemePalette(source: {
  themeBackground?: unknown;
  themeUi?: unknown;
  themeText?: unknown;
  themeColor?: unknown;
}): ThemePalette {
  const d = defaultThemePalette();
  return {
    background: normalizeHex(source.themeBackground, d.background),
    ui: normalizeHex(source.themeUi, d.ui),
    text: normalizeHex(source.themeText, d.text),
  };
}

function expandHex(raw: string): string | null {
  let h = raw;
  if (!h.startsWith('#')) h = `#${h}`;
  if (/^#[0-9a-fA-F]{3}$/.test(h)) {
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(h)) return null;
  return h;
}

function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const h = expandHex(hex);
  if (!h) return null;
  return {
    r: parseInt(h.slice(1, 3), 16),
    g: parseInt(h.slice(3, 5), 16),
    b: parseInt(h.slice(5, 7), 16),
  };
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((c) => clampByte(c).toString(16).padStart(2, '0'))
    .join('')}`;
}

function mixColors(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  const u = Math.max(0, Math.min(1, t));
  return toHex(
    ca.r * (1 - u) + cb.r * u,
    ca.g * (1 - u) + cb.g * u,
    ca.b * (1 - u) + cb.b * u,
  );
}

function mixWhite(hex: string, whiteRatio: number): string {
  return mixColors(hex, '#ffffff', whiteRatio);
}

function mixBlack(hex: string, blackRatio: number): string {
  return mixColors(hex, '#000000', blackRatio);
}

function setAccentVars(root: HTMLElement, accent: string): void {
  const rgb = parseHex(accent);
  if (!rgb) return;
  const { r, g, b } = rgb;
  root.style.setProperty('--theme-accent', accent);
  root.style.setProperty('--theme-accent-hover', mixWhite(accent, 0.18));
  root.style.setProperty('--theme-accent-dim', mixBlack(accent, 0.18));
  root.style.setProperty('--theme-accent-text', mixWhite(accent, 0.42));
  root.style.setProperty('--theme-accent-soft', `rgba(${r},${g},${b},0.13)`);
  root.style.setProperty('--theme-accent-medium', `rgba(${r},${g},${b},0.27)`);
  root.style.setProperty('--theme-accent-border', `rgba(${r},${g},${b},0.4)`);
  root.style.setProperty('--theme-accent-outline', `rgba(${r},${g},${b},0.53)`);
  root.style.setProperty('--theme-accent-shadow', `rgba(${r},${g},${b},0.33)`);
}

/** 写入 document 上的主题 CSS 变量（背景 / UI / 文字） */
export function applyThemePaletteToDocument(palette: ThemePalette): void {
  const bg = palette.background;
  const ui = palette.ui;
  const text = palette.text;
  const root = document.documentElement;

  root.style.setProperty('--theme-bg', bg);
  root.style.setProperty('--theme-bg-deep', mixColors(bg, '#000000', 0.32));
  root.style.setProperty('--theme-ui', ui);
  root.style.setProperty('--theme-ui-elevated', mixWhite(ui, 0.08));
  root.style.setProperty('--theme-ui-panel', mixColors(ui, bg, 0.38));
  root.style.setProperty('--theme-ui-control', mixWhite(ui, 0.15));
  root.style.setProperty('--theme-ui-control-hover', mixWhite(ui, 0.22));
  root.style.setProperty('--theme-ui-input', mixBlack(ui, 0.2));
  root.style.setProperty('--theme-ui-border', mixWhite(ui, 0.2));
  root.style.setProperty('--theme-ui-border-subtle', mixBlack(ui, 0.1));
  root.style.setProperty('--theme-text', text);
  root.style.setProperty('--theme-text-muted', mixColors(text, bg, 0.52));
  root.style.setProperty('--theme-text-subtle', mixColors(text, bg, 0.65));
  root.style.setProperty('--theme-text-heading', mixWhite(text, 0.05));
  root.style.setProperty('--theme-text-strong', mixWhite(text, 0.02));

  const accent = mixWhite(mixColors(ui, text, 0.42), 0.18);
  setAccentVars(root, accent);
}

export function readTerminalThemeFromDocument(): {
  background: string;
  foreground: string;
  cursor: string;
} {
  const s = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) =>
    s.getPropertyValue(name).trim() || fallback;
  const foreground = pick('--theme-text', DEFAULT_THEME_TEXT);
  return {
    background: pick('--theme-bg-deep', '#1e1e1e'),
    foreground,
    cursor: foreground,
  };
}
