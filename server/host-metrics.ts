import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import { getSshProfile } from './ssh-profiles.js';
import { metricsSshPool } from './ssh-metrics-pool.js';
import { resolveSpawnSpec, type PaneConnection } from './ssh-spawn.js';

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

/** /proc 原始计数（单调递增），速率由两次计数之差算出来 */
interface RawCounters {
  at: number;
  cpuTotal: number;
  cpuIdle: number;
  memTotalKb: number;
  memAvailKb: number;
  netRx: number;
  netTx: number;
  diskReadSectors: number;
  diskWriteSectors: number;
}

/** 两次采样间隔太短/太长都不靠谱：太短噪声大，太长说明中间没刷新过 */
const MIN_SAMPLE_MS = 200;
const MAX_SAMPLE_MS = 5 * 60 * 1000;
/** 首次请求（没有上次计数）时本地快速补一次采样，直接给出可用数字 */
const PRIME_SAMPLE_MS = 250;   // 要大于 MIN_SAMPLE_MS，否则首次那次会被判定为"间隔太短"而不出数

const METRICS_TIMEOUT_MS = 12_000;

/** key: 'local' 或 `ssh:<profileId>`；值：上一次采到的原始计数 */
const counterCache = new Map<string, RawCounters>();

/**
 * 远端只负责把 /proc 里的原始计数打出来（一次 awk、无 sleep、无多次 fork），
 * 速率和 CPU% 一律在服务端用缓存的上一次计数算 —— 这样 1 秒一次也很便宜。
 */
const REMOTE_COUNTERS_SCRIPT = `
awk '
  FNR == 1 { n++ }
  n == 1 && $1 == "cpu" { for (i = 2; i <= 9; i++) t += $i; total = t; idle = $5 + $6 }
  n == 2 && $1 == "MemTotal:" { mt = $2 }
  n == 2 && $1 == "MemAvailable:" { ma = $2; haveAvail = 1 }
  n == 2 && $1 == "MemFree:" { mf = $2 }
  n == 2 && $1 == "Buffers:" { mb = $2 }
  n == 2 && $1 == "Cached:" { mc = $2 }
  n == 3 && $1 ~ /:$/ && $1 != "lo:" && $2 ~ /^[0-9]+$/ { rx += $2; tx += $10 }
  n == 4 && $3 ~ /^(sd[a-z]|vd[a-z]|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/ { rs += $6; ws += $10 }
  END {
    if (!haveAvail) ma = mf + mb + mc
    printf "{\\"cpuTotal\\":%d,\\"cpuIdle\\":%d,\\"memTotalKb\\":%d,\\"memAvailKb\\":%d,\\"netRx\\":%d,\\"netTx\\":%d,\\"diskReadSectors\\":%d,\\"diskWriteSectors\\":%d}\\n", total, idle, mt, ma, rx, tx, rs, ws
  }
' /proc/stat /proc/meminfo /proc/net/dev /proc/diskstats
`.trim();

const WHOLE_DISK_RE = /^(sd[a-z]+|vd[a-z]+|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$/;

function readProcText(path: string): string | null {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 直接读本机 /proc：4 个文件、几毫秒，不起进程 */
function readLocalCounters(): Omit<RawCounters, 'at'> | null {
  const statText = readProcText('/proc/stat');
  const memText = readProcText('/proc/meminfo');
  if (!statText || !memText) return null;

  const cpuLine = statText.slice(0, statText.indexOf('\n')).trim().split(/\s+/);
  if (cpuLine[0] !== 'cpu') return null;
  let cpuTotal = 0;
  // 只累加 user..steal（第 10、11 位是 guest/guest_nice，已计入 user/nice，再加会重复）
  for (let i = 1; i <= Math.min(9, cpuLine.length - 1); i++) {
    const v = Number(cpuLine[i]);
    if (Number.isFinite(v)) cpuTotal += v;
  }
  const cpuIdle = Number(cpuLine[4] ?? 0) + Number(cpuLine[5] ?? 0);

  const mem = parseMeminfo(memText);
  if (!mem) return null;

  return {
    cpuTotal,
    cpuIdle,
    memTotalKb: mem.totalKb,
    memAvailKb: mem.availKb,
    ...readNetCounters(),
    ...readDiskCounters(),
  };
}

function parseMeminfo(text: string): { totalKb: number; availKb: number } | null {
  let totalKb = 0;
  let availKb = 0;
  let freeKb = 0;
  let buffersKb = 0;
  let cachedKb = 0;
  let haveAvail = false;
  for (const line of text.split('\n')) {
    const m = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (!m) continue;
    const v = Number(m[2]);
    switch (m[1]) {
      case 'MemTotal': totalKb = v; break;
      case 'MemAvailable': availKb = v; haveAvail = true; break;
      case 'MemFree': freeKb = v; break;
      case 'Buffers': buffersKb = v; break;
      case 'Cached': cachedKb = v; break;
      default: break;
    }
  }
  if (totalKb <= 0) return null;
  if (!haveAvail) availKb = freeKb + buffersKb + cachedKb;
  return { totalKb, availKb: Math.max(0, availKb) };
}

function readNetCounters(): { netRx: number; netTx: number } {
  const text = readProcText('/proc/net/dev') ?? '';
  let netRx = 0;
  let netTx = 0;
  for (const line of text.split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const name = line.slice(0, idx).trim();
    if (!name || name === 'lo') continue;
    const f = line.slice(idx + 1).trim().split(/\s+/);
    if (f.length < 10) continue;
    const rx = Number(f[0]);
    const tx = Number(f[8]);
    if (Number.isFinite(rx)) netRx += rx;
    if (Number.isFinite(tx)) netTx += tx;
  }
  return { netRx, netTx };
}

function readDiskCounters(): { diskReadSectors: number; diskWriteSectors: number } {
  const text = readProcText('/proc/diskstats') ?? '';
  let diskReadSectors = 0;
  let diskWriteSectors = 0;
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10) continue;
    if (!WHOLE_DISK_RE.test(f[2])) continue;
    const rs = Number(f[5]);
    const ws = Number(f[9]);
    if (Number.isFinite(rs)) diskReadSectors += rs;
    if (Number.isFinite(ws)) diskWriteSectors += ws;
  }
  return { diskReadSectors, diskWriteSectors };
}

function parseCountersJson(raw: string): Omit<RawCounters, 'at'> | null {
  const line = raw
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
  if (!line) return null;
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    const num = (v: unknown): number => {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };
    const totalKb = num(o.memTotalKb);
    if (totalKb <= 0) return null;
    return {
      cpuTotal: num(o.cpuTotal),
      cpuIdle: num(o.cpuIdle),
      memTotalKb: totalKb,
      memAvailKb: num(o.memAvailKb),
      netRx: num(o.netRx),
      netTx: num(o.netTx),
      diskReadSectors: num(o.diskReadSectors),
      diskWriteSectors: num(o.diskWriteSectors),
    };
  } catch {
    return null;
  }
}

function rateFrom(delta: number, seconds: number): number | null {
  if (!Number.isFinite(delta) || delta < 0) return null; // 计数器回绕/重启
  return Math.max(0, Math.round(delta / seconds));
}

function countersToMetrics(
  prev: RawCounters | undefined,
  cur: RawCounters,
  target: 'local' | 'remote',
  label: string,
): HostMetrics {
  let cpuPercent: number | null = null;
  let netDownBps: number | null = null;
  let netUpBps: number | null = null;
  let diskReadBps: number | null = null;
  let diskWriteBps: number | null = null;

  if (prev) {
    const dtMs = cur.at - prev.at;
    if (dtMs >= MIN_SAMPLE_MS && dtMs <= MAX_SAMPLE_MS) {
      const dt = dtMs / 1000;
      const dTotal = cur.cpuTotal - prev.cpuTotal;
      const dIdle = cur.cpuIdle - prev.cpuIdle;
      if (dTotal > 0 && dIdle >= 0) {
        const busy = 1 - dIdle / dTotal;
        cpuPercent = Math.max(0, Math.min(100, Math.round(busy * 100)));
      }
      netDownBps = rateFrom(cur.netRx - prev.netRx, dt);
      netUpBps = rateFrom(cur.netTx - prev.netTx, dt);
      diskReadBps = rateFrom((cur.diskReadSectors - prev.diskReadSectors) * 512, dt);
      diskWriteBps = rateFrom((cur.diskWriteSectors - prev.diskWriteSectors) * 512, dt);
    }
  }

  const memUsedKb = Math.max(0, cur.memTotalKb - cur.memAvailKb);
  return {
    target,
    label,
    cpuPercent,
    memoryUsedGb: Math.round(memUsedKb / 1024 / 1024),
    memoryTotalGb: Math.max(1, Math.round(cur.memTotalKb / 1024 / 1024)),
    netDownBps,
    netUpBps,
    diskReadBps,
    diskWriteBps,
  };
}

function runBashOneShotSsh(
  connection: Extract<PaneConnection, { kind: 'ssh' }>,
  script: string,
): Promise<string> {
  const spec = resolveSpawnSpec(connection, { skipSetup: true });
  const args = [...spec.args, 'bash', '-s'];
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, args, {
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('采集超时'));
    }, METRICS_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.stdin.write(script);
    child.stdin.end();
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `退出码 ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function runCountersOnConnection(
  connection: Extract<PaneConnection, { kind: 'ssh' }>,
): Promise<string> {
  try {
    return await metricsSshPool.runScript(connection, REMOTE_COUNTERS_SCRIPT);
  } catch {
    metricsSshPool.invalidate(connection);
    try {
      return await metricsSshPool.runScript(connection, REMOTE_COUNTERS_SCRIPT);
    } catch {
      return runBashOneShotSsh(connection, REMOTE_COUNTERS_SCRIPT);
    }
  }
}

function localMetricsFromNode(label: string): HostMetrics {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  return {
    target: 'local',
    label,
    cpuPercent: null,
    memoryUsedGb: Math.round(used / 1024 / 1024 / 1024),
    memoryTotalGb: Math.max(1, Math.round(total / 1024 / 1024 / 1024)),
    netDownBps: null,
    netUpBps: null,
    diskReadBps: null,
    diskWriteBps: null,
  };
}

function connectionLabel(connection: PaneConnection | undefined): string {
  if (!connection || connection.kind === 'local') {
    const hn = os.hostname();
    return hn ? `本机 · ${hn}` : '本机';
  }
  const profile = getSshProfile(connection.profileId);
  if (!profile) return 'SSH';
  return `${profile.username}@${profile.host}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 采集一次主机状态。
 *
 * 不阻塞、不起 shell（本机）：直接读 /proc 原始计数，和上一次缓存做差算速率/CPU%。
 * 首次调用（缓存为空）时本地会补一次 ~150ms 的快速采样，直接给出可用数字。
 */
export async function fetchHostMetrics(
  connection?: PaneConnection,
): Promise<HostMetrics> {
  const label = connectionLabel(connection);
  const isSsh = connection?.kind === 'ssh';
  const target: 'local' | 'remote' = isSsh ? 'remote' : 'local';

  if (isSsh && connection) {
    const key = `ssh:${connection.profileId}`;
    const out = await runCountersOnConnection(connection);
    const parsed = parseCountersJson(out);
    if (!parsed) throw new Error('无法读取远程设备状态');
    const prev = counterCache.get(key);
    const cur: RawCounters = { ...parsed, at: Date.now() };
    counterCache.set(key, cur);
    return countersToMetrics(prev, cur, target, label);
  }

  const first = readLocalCounters();
  if (!first) return localMetricsFromNode(label);

  const key = 'local';
  let prev = counterCache.get(key);
  const firstAt = Date.now();
  if (!prev) {
    // 首次：本地读 /proc 很便宜，补一次采样即可立刻给出数字（不用起进程、不用等一秒）
    await sleep(PRIME_SAMPLE_MS);
    const second = readLocalCounters();
    if (second) {
      prev = { ...first, at: firstAt };
      const cur: RawCounters = { ...second, at: Date.now() };
      counterCache.set(key, cur);
      return countersToMetrics(prev, cur, target, label);
    }
  }

  const cur: RawCounters = { ...first, at: firstAt };
  counterCache.set(key, cur);
  return countersToMetrics(prev, cur, target, label);
}

export function parsePaneConnection(body: unknown): PaneConnection | undefined {
  if (!body || typeof body !== 'object') return { kind: 'local' };
  const o = body as Record<string, unknown>;
  const conn = o.connection;
  if (!conn || typeof conn !== 'object') return { kind: 'local' };
  const c = conn as Record<string, unknown>;
  if (c.kind === 'local') return { kind: 'local' };
  if (c.kind === 'ssh' && typeof c.profileId === 'string' && c.profileId) {
    return {
      kind: 'ssh',
      profileId: c.profileId,
      sessionPassword:
        typeof c.sessionPassword === 'string' ? c.sessionPassword : undefined,
    };
  }
  return { kind: 'local' };
}
