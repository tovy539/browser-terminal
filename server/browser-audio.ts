import { spawn, execFileSync, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * 无头浏览器音频：
 * Chrome（headless 也一样）会把声音输出到 PulseAudio；容器里没有声卡，
 * 所以给每个浏览器会话开一个 null sink，再用 ffmpeg 录这个 sink 的 monitor，
 * 编码成 fMP4/AAC 通过 WebSocket 二进制帧推给前端用 MediaSource 播放。
 */

const PULSE_DIR = path.join('/tmp', 'bt-pulse');
const PULSE_SOCKET = path.join(PULSE_DIR, 'native');

interface AudioSession {
  moduleIndex: string;
  ffmpeg: ChildProcess | null;
  sinkName: string;
}

const sessions = new Map<string, AudioSession>();
let pulseReady = false;
let pulseStarting: Promise<boolean> | null = null;

function pulseEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_RUNTIME_DIR: PULSE_DIR,
    PULSE_SERVER: `unix:${PULSE_SOCKET}`,
  };
}

function pactl(args: string[]): string {
  return execFileSync('pactl', args, { env: pulseEnv(), encoding: 'utf8', timeout: 5000 }).trim();
}

/** 启动 pulseaudio（只起一次），并保证默认 sink 存在 */
export async function ensurePulse(): Promise<boolean> {
  if (pulseReady) return true;
  if (pulseStarting) return pulseStarting;
  pulseStarting = (async () => {
    try {
      fs.mkdirSync(PULSE_DIR, { recursive: true, mode: 0o700 });
      try {
        pactl(['info']);
        pulseReady = true;
        return true;
      } catch {
        /* 还没起来 */
      }
      const daemon = spawn(
        'pulseaudio',
        [
          '--daemonize=no',
          '--exit-idle-time=-1',
          '-n',
          '--load=module-null-sink sink_name=bt_default sink_properties=device_description=bt_default',
          `--load=module-native-protocol-unix socket=${PULSE_SOCKET}`,
        ],
        { env: pulseEnv(), stdio: 'ignore', detached: true },
      );
      daemon.unref();
      for (let i = 0; i < 40; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        try {
          pactl(['info']);
          pulseReady = true;
          return true;
        } catch {
          /* 继续等 */
        }
      }
      return false;
    } catch {
      return false;
    } finally {
      pulseStarting = null;
    }
  })();
  return pulseStarting;
}

/** Chrome 需要的环境（用它自己的 sink 输出声音） */
export function audioEnvFor(sessionId: string, sink: string | null): NodeJS.ProcessEnv {
  void sessionId;
  if (!sink) return { ...process.env };
  return { ...pulseEnv(), PULSE_SINK: sink };
}

/** 会话建立时创建专属 null sink；失败返回 null（音频不可用，其它功能不受影响） */
export async function createSessionSink(sessionId: string): Promise<string | null> {
  if (!(await ensurePulse())) return null;
  const sinkName = `bt_${sessionId.replace(/[^A-Za-z0-9_]/g, '_')}`;
  try {
    const moduleIndex = pactl([
      'load-module',
      'module-null-sink',
      `sink_name=${sinkName}`,
      `sink_properties=device_description=${sinkName}`,
    ]);
    // 模块加载成功后 sink 要过一小会儿才出现，等它出来再返回（否则 ffmpeg 抓不到）
    for (let i = 0; i < 20; i += 1) {
      if (pactl(['list', 'short', 'sinks']).includes(sinkName)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    sessions.set(sessionId, { moduleIndex, ffmpeg: null, sinkName });
    return sinkName;
  } catch (err) {
    console.error('[browser-audio] createSessionSink failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

export function sessionSinkName(sessionId: string): string | null {
  return sessions.get(sessionId)?.sinkName ?? null;
}

/** 开始把该会话的音频编码成 fMP4/AAC 分片通过回调送出 */
export async function startSessionAudio(
  sessionId: string,
  onChunk: (chunk: Buffer) => void,
): Promise<boolean> {
  const entry = sessions.get(sessionId);
  if (!entry) return false;
  if (entry.ffmpeg) return true;
  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'pulse',
      '-i',
      `${entry.sinkName}.monitor`,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '48k',
      '-frame_duration',
      '20',
      '-f',
      'webm',
      '-cluster_time_limit',
      '100',
      '-cluster_size_limit',
      '32768',
      'pipe:1',
    ],
    { env: pulseEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  ffmpeg.stdout?.on('data', (chunk: Buffer) => onChunk(chunk));
  ffmpeg.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-600);
  });
  ffmpeg.on('error', (err) => {
    console.error('[browser-audio] ffmpeg error', err.message);
    entry.ffmpeg = null;
  });
  ffmpeg.on('exit', (code, signal) => {
    console.error('[browser-audio] ffmpeg exit', code, signal, stderr.slice(-300));
    if (entry.ffmpeg === ffmpeg) entry.ffmpeg = null;
  });
  entry.ffmpeg = ffmpeg;
  return true;
}

export function stopSessionAudio(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry?.ffmpeg) return;
  try {
    entry.ffmpeg.kill('SIGKILL');
  } catch {
    /* ignore */
  }
  entry.ffmpeg = null;
}

export function destroySessionSink(sessionId: string): void {
  const entry = sessions.get(sessionId);
  if (!entry) return;
  stopSessionAudio(sessionId);
  try {
    pactl(['unload-module', entry.moduleIndex]);
  } catch {
    /* ignore */
  }
  sessions.delete(sessionId);
}

export function shutdownAudio(): void {
  for (const id of [...sessions.keys()]) destroySessionSink(id);
}
