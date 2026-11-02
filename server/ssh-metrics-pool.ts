import { createHash } from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { getSshProfile } from './ssh-profiles.js';
import {
  resolveSpawnSpec,
  type PaneConnection,
  type SpawnSpec,
} from './ssh-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTROL_DIR = path.join(__dirname, '../.run/ssh-metrics');
const CONTROL_PERSIST_SEC = 600;
const SCRIPT_TIMEOUT_MS = 12_000;
const MASTER_START_TIMEOUT_MS = 20_000;

function cacheKey(connection: Extract<PaneConnection, { kind: 'ssh' }>): string {
  const pwd = connection.sessionPassword ?? '__stored__';
  return createHash('sha256')
    .update(`${connection.profileId}\0${pwd}`)
    .digest('hex')
    .slice(0, 24);
}

function socketPath(key: string): string {
  fs.mkdirSync(CONTROL_DIR, { mode: 0o700, recursive: true });
  return path.join(CONTROL_DIR, `${key}.sock`);
}

function sshTarget(profileId: string): string {
  const profile = getSshProfile(profileId);
  if (!profile) throw new Error('SSH 配置不存在');
  return `${profile.username}@${profile.host}`;
}

/** 在 target 前插入 -o，可选在 target 后追加远程命令 */
function insertSshOptions(
  args: string[],
  options: string[],
  remoteCmd?: string[],
): string[] {
  const copy = [...args];
  const target = copy.pop();
  if (!target) throw new Error('无效的 SSH 参数');
  const out = [...copy, ...options, target];
  if (remoteCmd?.length) out.push(...remoteCmd);
  return out;
}

function spawnAsync(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin?: string,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      env,
      stdio: stdin !== undefined ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    if (stdin !== undefined && child.stdin) {
      child.stdin.write(stdin);
      child.stdin.end();
    }
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

class MetricsSshPool {
  private opening = new Map<string, Promise<void>>();

  invalidate(connection: PaneConnection): void {
    if (connection.kind !== 'ssh') return;
    const key = cacheKey(connection);
    const sock = socketPath(key);
    void this.closeMaster(connection, sock).catch(() => {});
    try {
      fs.unlinkSync(sock);
    } catch {
      /* ignore */
    }
  }

  private async closeMaster(
    connection: Extract<PaneConnection, { kind: 'ssh' }>,
    sock: string,
  ): Promise<void> {
    const spec = resolveSpawnSpec(connection, { skipSetup: true });
    const target = sshTarget(connection.profileId);
    const args = insertSshOptions(spec.args, ['-O', 'exit', '-S', sock]);
    await spawnAsync(spec.file, args, spec.env);
    void target;
  }

  private async checkMaster(
    spec: SpawnSpec,
    sock: string,
    target: string,
  ): Promise<boolean> {
    if (!fs.existsSync(sock)) return false;
    const args = insertSshOptions(spec.args, ['-O', 'check', '-S', sock]);
    void target;
    const { code } = await spawnAsync(spec.file, args, spec.env);
    return code === 0;
  }

  private startMaster(
    spec: SpawnSpec,
    sock: string,
    target: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = insertSshOptions(spec.args, [
        '-o',
        'ControlMaster=yes',
        '-o',
        `ControlPath=${sock}`,
        '-o',
        `ControlPersist=${CONTROL_PERSIST_SEC}`,
        '-N',
        '-f',
      ]);
      void target;
      const child = spawn(spec.file, args, {
        env: spec.env,
        stdio: 'ignore',
        detached: true,
      });
      child.unref();
      const timer = setTimeout(() => {
        reject(new Error('SSH 控制连接启动超时'));
      }, MASTER_START_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timer);
          reject(new Error(`SSH 控制连接退出码 ${code}`));
        }
      });
      const poll = (attempt: number) => {
        if (attempt > 80) {
          clearTimeout(timer);
          reject(new Error('SSH 控制连接未就绪'));
          return;
        }
        if (fs.existsSync(sock)) {
          void this.checkMaster(spec, sock, target).then((ok) => {
            if (ok) {
              clearTimeout(timer);
              resolve();
            } else {
              setTimeout(() => poll(attempt + 1), 50);
            }
          });
          return;
        }
        setTimeout(() => poll(attempt + 1), 50);
      };
      setTimeout(() => poll(0), 30);
    });
  }

  private async ensureMaster(
    connection: Extract<PaneConnection, { kind: 'ssh' }>,
  ): Promise<string> {
    const key = cacheKey(connection);
    const sock = socketPath(key);
    if (!getSshProfile(connection.profileId)) {
      throw new Error('SSH 配置不存在');
    }
    const spec = resolveSpawnSpec(connection, { skipSetup: true });
    const target = sshTarget(connection.profileId);

    if (await this.checkMaster(spec, sock, target)) return sock;

    let opening = this.opening.get(key);
    if (!opening) {
      opening = (async () => {
        if (await this.checkMaster(spec, sock, target)) return;
        try {
          fs.unlinkSync(sock);
        } catch {
          /* ignore */
        }
        await this.startMaster(spec, sock, target);
        if (!(await this.checkMaster(spec, sock, target))) {
          throw new Error('SSH 控制连接建立失败');
        }
      })();
      this.opening.set(key, opening);
    }
    try {
      await opening;
    } finally {
      if (this.opening.get(key) === opening) this.opening.delete(key);
    }
    return sock;
  }

  async runScript(connection: PaneConnection, script: string): Promise<string> {
    if (connection.kind !== 'ssh') {
      throw new Error('runScript 仅用于 SSH');
    }
    const spec = resolveSpawnSpec(connection, { skipSetup: true });
    const sock = await this.ensureMaster(connection);
    const args = insertSshOptions(
      spec.args,
      ['-o', `ControlPath=${sock}`],
      ['bash', '-s'],
    );

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('采集超时'));
      }, SCRIPT_TIMEOUT_MS);

      const child = spawn(spec.file, args, {
        env: spec.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
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
          reject(new Error(stderr.trim() || stdout.trim() || `SSH 退出码 ${code}`));
          return;
        }
        resolve(stdout);
      });
    });
  }
}

export const metricsSshPool = new MetricsSshPool();

/** 与状态栏指标共用 ControlMaster（profileId + 已存凭据） */
export async function runPooledRemoteScript(
  profileId: string,
  script: string,
  sessionPassword?: string,
): Promise<string> {
  const connection: PaneConnection = { kind: 'ssh', profileId, sessionPassword };
  return metricsSshPool.runScript(connection, script);
}

export function invalidatePooledRemote(
  profileId: string,
  sessionPassword?: string,
): void {
  metricsSshPool.invalidate({ kind: 'ssh', profileId, sessionPassword });
}
