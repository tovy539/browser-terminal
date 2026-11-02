import type { TerminalAttachConnection } from './types';

export interface HostMetrics {
  target: 'local' | 'remote';
  label: string;
  cpuPercent: number | null;
  memoryUsedGb: number;
  memoryTotalGb: number;
  netDownBps: number | null;
  netUpBps: number | null;
  diskReadBps: number | null;
  diskWriteBps: number | null;
}

export interface HostMetricsDisplay {
  cpu: string;
  mem: string;
  netRx: string;
  netTx: string;
  diskRead: string;
  diskWrite: string;
  title: string;
  cpuColor: string;
  memColor: string;
  netColor: string;
  diskColor: string;
}

/** 网络/磁盘速率视为「满负荷」的阈值（约 100 MB/s） */
const RATE_STRESS_FULL_BPS = 100 * 1024 * 1024;

export async function fetchHostMetrics(
  connection: TerminalAttachConnection | { kind: 'local' },
): Promise<HostMetrics | null> {
  try {
    const res = await fetch('/api/host/metrics', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ connection }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { metrics?: HostMetrics };
    return data.metrics ?? null;
  } catch {
    return null;
  }
}

/** 0=绿，1=红；null 时用主题次要色 */
export function stressColor(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) {
    return 'var(--theme-text-subtle)';
  }
  const t = Math.max(0, Math.min(1, ratio));
  const hue = 120 * (1 - t);
  return `hsl(${hue} 82% 62%)`;
}

function stressFromRate(bps: number | null): number | null {
  if (bps === null || !Number.isFinite(bps)) return null;
  return Math.min(1, Math.max(0, bps / RATE_STRESS_FULL_BPS));
}

function stressFromRates(...rates: (number | null)[]): number | null {
  let max: number | null = null;
  for (const r of rates) {
    const s = stressFromRate(r);
    if (s === null) continue;
    max = max === null ? s : Math.max(max, s);
  }
  return max;
}

/** 固定 7ch 列宽内使用的速率文案 */
export function formatRate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return '—';
  const b = Math.max(0, bps);
  if (b >= 1024 * 1024 * 1024) {
    return `${(b / 1024 / 1024 / 1024).toFixed(1)}G/s`;
  }
  if (b >= 1024 * 1024) {
    return `${(b / 1024 / 1024).toFixed(1)}M/s`;
  }
  if (b >= 1024) {
    return `${(b / 1024).toFixed(1)}K/s`;
  }
  return `${Math.round(b)}B/s`;
}

export function formatHostMetricsDisplay(m: HostMetrics): HostMetricsDisplay {
  const cpuNum =
    m.cpuPercent === null ? '—' : String(Math.min(100, m.cpuPercent)).padStart(3, ' ');
  const cpu = `CPU ${cpuNum}%`;
  const mem = `内存 ${m.memoryUsedGb}/${m.memoryTotalGb}G`;
  const netRx = formatRate(m.netDownBps);
  const netTx = formatRate(m.netUpBps);
  const diskRead = formatRate(m.diskReadBps);
  const diskWrite = formatRate(m.diskWriteBps);
  const title = `${cpu}  ${mem}  网络 收${netRx} 发${netTx}  磁盘 读${diskRead} 写${diskWrite}`;

  const memRatio =
    m.memoryTotalGb > 0 ? m.memoryUsedGb / m.memoryTotalGb : null;
  const cpuRatio =
    m.cpuPercent === null ? null : Math.min(1, Math.max(0, m.cpuPercent / 100));

  return {
    cpu,
    mem,
    netRx,
    netTx,
    diskRead,
    diskWrite,
    title,
    cpuColor: stressColor(cpuRatio),
    memColor: stressColor(memRatio),
    netColor: stressColor(stressFromRates(m.netDownBps, m.netUpBps)),
    diskColor: stressColor(stressFromRates(m.diskReadBps, m.diskWriteBps)),
  };
}

export function emptyHostMetricsDisplay(): HostMetricsDisplay {
  const muted = 'var(--theme-text-subtle)';
  return {
    cpu: 'CPU   —%',
    mem: '内存 —/—G',
    netRx: '—',
    netTx: '—',
    diskRead: '—',
    diskWrite: '—',
    title: '',
    cpuColor: muted,
    memColor: muted,
    netColor: muted,
    diskColor: muted,
  };
}
