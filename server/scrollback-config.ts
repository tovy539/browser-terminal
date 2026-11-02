export const DEFAULT_TERMINAL_SCROLLBACK_LINES = 1000;
export const MIN_TERMINAL_SCROLLBACK_LINES = 100;
export const MAX_TERMINAL_SCROLLBACK_LINES = 100_000;

let maxLines = DEFAULT_TERMINAL_SCROLLBACK_LINES;

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

export function setTerminalScrollbackLines(value: unknown): void {
  maxLines = clampScrollbackLines(value);
}

export function getTerminalScrollbackMaxLines(): number {
  return maxLines;
}

/** 单会话 scrollback 字符串体积上限（约 maxLines × 512 字符） */
export function getScrollbackByteBudget(): number {
  return getTerminalScrollbackMaxLines() * 512;
}

/**
 * 保留约 maxLines 行（按 \n 计），用于服务端重连 scrollback。
 *
 * 注意：必须同时按"体积"裁剪。六色/图片帧（DCS 序列）里几乎没有换行，
 * 只按行数裁会一个字符都裁不掉：播完视频后单个会话的 scrollback 能涨到十几 MB，
 * 之后每来一个输出块（例如每次按键回显）都要对整串做一次倒序扫描 → 打字明显变卡。
 */
export function trimScrollbackString(data: string): string {
  const max = maxLines;
  if (max <= 0) return '';

  const budget = getScrollbackByteBudget();
  let out = data;

  // 1) 体积优先：超预算就只保留尾部
  if (out.length > budget) {
    out = out.slice(out.length - budget);
    // 尽量从下一行开头切，避免把一行/一个转义序列截成两半（只在近处找，避免大范围扫描）
    const nl = out.indexOf('\n');
    if (nl >= 0 && nl < 4096) out = out.slice(nl + 1);
  }

  // 2) 行数上限（体积已经收敛到 budget 以内，这次扫描是有界的）
  const softBudget = max * 64;
  if (out.length <= softBudget) return out;

  let newlines = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out.charCodeAt(i) === 10) {
      newlines++;
      if (newlines > max) {
        return out.slice(i + 1);
      }
    }
  }
  return out;
}
