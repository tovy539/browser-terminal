export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 1000;
export const MIN_TERMINAL_SCROLLBACK_LINES = 100;
export const MAX_TERMINAL_SCROLLBACK_LINES = 100_000;

export function clampScrollbackLines(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_TERMINAL_SCROLLBACK_LINES;
  return Math.min(
    MAX_TERMINAL_SCROLLBACK_LINES,
    Math.max(MIN_TERMINAL_SCROLLBACK_LINES, Math.round(n)),
  );
}

export function parseScrollbackLinesFromState(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_TERMINAL_SCROLLBACK_LINES;
  return clampScrollbackLines(value);
}
