import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  getSshProfile,
  getSshSecret,
  hasSystemSshKeys,
  normalizePrivateKeyPem,
} from './ssh-profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shell = process.env.SHELL || '/bin/bash';

export type PaneConnection =
  | { kind: 'local' }
  | { kind: 'ssh'; profileId: string; /** 仅随 WebSocket attach 传递，不持久化 */ sessionPassword?: string };

export interface SpawnSpec {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup?: () => void;
}

/**
 * 服务端自己可能是在非交互环境里启动的（例如被 CI/工具 shell 拉起），它的 env 里常带着
 * `PAGER=cat`、`GIT_PAGER=cat`、`TERM=dumb`、`LINES/COLUMNS=...` 这类"不是给终端用"的设置。
 * PTY 原样继承的话，浏览器里的 `git log` 就会走 cat 直接刷完（没有分页），less/man 也会报错。
 * 这里统一剥掉分页器与尺寸相关的变量，并给一个真正的终端类型。
 */
const TERMINAL_ENV_DROP = [
  'PAGER',
  'GIT_PAGER',
  'GIT_PAGER_IN_USE',
  'MANPAGER',
  'SYSTEMD_PAGER',
  'LESS',
  'MORE',
  'LV',
  'LINES',
  'COLUMNS',
  'TERMCAP',
];

export function sanitizeShellEnv(
  base: NodeJS.ProcessEnv,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const key of TERMINAL_ENV_DROP) delete env[key];
  env.TERM = 'xterm-256color';
  return env;
}

/** 只在双引号里安全使用的转义（值都是 URL / token / id，不含换行） */
function dqEscape(value: string): string {
  return value.replace(/["'`$\\]/g, (c) => `\\${c}`).replace(/'/g, '');
}

/** 把 POSIX 脚本包成 `sh -c '...'`：远端登录 shell 可能是 fish/csh，直接给命令会解析不了 */
export function wrapRemoteSh(script: string): string {
  return `sh -c '${script.replace(/'/g, `'\\''`)}'`;
}

/**
 * 远端会话的启动命令：把 ~/.browser_terminal/bin 加进 PATH，注入 BT_* 变量，
 * 然后 exec 一个登录 shell（保持交互体验，且不写用户 dotfile 也能立即生效）。
 */
function buildRemoteSetup(remoteEnv?: Record<string, string>): string {
  const parts = ['export PATH="$HOME/.browser_terminal/bin:$PATH"'];
  for (const [key, value] of Object.entries(remoteEnv ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    parts.push(`export ${key}="${dqEscape(value)}"`);
  }
  parts.push('if [ -x "$SHELL" ]; then exec "$SHELL" -l; fi');
  parts.push('exec /bin/bash -l');
  return parts.join('; ');
}

export function resolveSpawnSpec(
  connection?: PaneConnection,
  opts?: {
    remoteEnv?: Record<string, string>;
    skipSetup?: boolean;
    /** 只跑一条远端命令（不分配 PTY，不做 setup），用于 download 之类的数据管道 */
    command?: string;
  },
): SpawnSpec {
  if (!connection || connection.kind === 'local') {
    return { file: shell, args: [], env: sanitizeShellEnv(process.env) };
  }

  const profile = getSshProfile(connection.profileId);
  if (!profile) {
    return spawnErrorShell(`未找到 SSH 配置: ${connection.profileId}`);
  }

  const secret = getSshSecret(profile.id) ?? {};
  const sessionPassword =
    connection.kind === 'ssh' ? connection.sessionPassword : undefined;

  const sshOpts = [
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'UserKnownHostsFile=' + path.join(os.homedir(), '.ssh', 'known_hosts'),
    '-p',
    String(profile.port),
  ];

  const target = `${profile.username}@${profile.host}`;
  const setup = opts?.skipSetup ? '' : buildRemoteSetup(opts?.remoteEnv);
  const remoteCommand =
    opts?.command !== undefined ? wrapRemoteSh(opts.command) : setup ? wrapRemoteSh(setup) : '';
  /** 带远端命令时 ssh 默认不分配 PTY（远端就变成非交互 shell，没提示符），必须 -tt；
      但数据管道（command 模式）不能要 PTY，否则二进制流会被回车/回显污染 */
  const ptyOpts = (): string[] => (opts?.command !== undefined ? [] : setup ? ['-tt'] : []);
  const setupArgs = (): string[] => (remoteCommand ? [remoteCommand] : []);

  if (profile.authType === 'password') {
    const password = sessionPassword ?? secret.password;
    if (!password) {
      return spawnErrorShell(`SSH 配置 ${profile.name} 缺少密码`);
    }
    if (!commandExists('sshpass')) {
      return spawnErrorShell(
        '服务器未安装 sshpass，无法使用密码登录。请安装 sshpass 或改用私钥。',
      );
    }
    return {
      file: 'sshpass',
      args: ['-e', 'ssh', ...ptyOpts(), ...sshOpts, target, ...setupArgs()],
      env: sanitizeShellEnv(process.env, { SSHPASS: password }),
    };
  }

  if (profile.authType === 'systemKey') {
    if (!hasSystemSshKeys()) {
      return spawnErrorShell(
        `SSH 配置 ${profile.name}：网关 ~/.ssh 下未找到 id_ed25519 / id_rsa 等默认私钥`,
      );
    }
    return {
      file: 'ssh',
      args: [...ptyOpts(), ...sshOpts, target, ...setupArgs()],
      env: sanitizeShellEnv(process.env),
    };
  }

  if (!secret.privateKey) {
    return spawnErrorShell(`SSH 配置 ${profile.name} 缺少私钥`);
  }

  const keyDir = path.join(__dirname, '../.run/ssh-keys');
  fs.mkdirSync(keyDir, { recursive: true });
  const keyPath = path.join(keyDir, `${profile.id}.key`);
  fs.writeFileSync(keyPath, normalizePrivateKeyPem(secret.privateKey), {
    mode: 0o600,
  });

  return {
    file: 'ssh',
    args: ['-i', keyPath, ...ptyOpts(), ...sshOpts, target, ...setupArgs()],
    env: sanitizeShellEnv(process.env),
  };
}

function spawnErrorShell(message: string): SpawnSpec {
  const safe = message.replace(/'/g, `'\\''`);
  return {
    file: shell,
    args: ['-c', `echo '${safe}'; exec ${shell}`],
    env: sanitizeShellEnv(process.env),
  };
}

function commandExists(cmd: string): boolean {
  const pathEnv = process.env.PATH || '';
  for (const dir of pathEnv.split(':')) {
    try {
      if (fs.existsSync(path.join(dir, cmd))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}
