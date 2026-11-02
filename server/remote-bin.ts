import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveSpawnSpec, wrapRemoteSh, type PaneConnection } from './ssh-spawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_BIN_DIR = path.resolve(__dirname, '..', 'bin');
/** 远端安装位置：~/.browser_terminal/bin */
const REMOTE_BIN_DIR = '$HOME/.browser_terminal/bin';
const REMOTE_BIN_DIR_LITERAL = '~/.browser_terminal/bin';
/** 需要同步到远端的命令（cs 需要 BT_* 环境变量，sshd 不接受任意 env，会由会话启动命令注入） */
const COMMANDS = ['imgcat', 'vidcat', 'vidopen', 'download', 'upload', 'cs'] as const;

const SSH_TIMEOUT_MS = 30_000;

/** 每个 SSH 配置的最近同步信息：脚本更新后（例如新命令）能重新同步到已有远端 */
const SYNC_TTL_MS = 60_000;
const done = new Map<string, { promise: Promise<void>; at: number }>();

function sshExec(
  connection: Extract<PaneConnection, { kind: 'ssh' }>,
  command: string,
): Promise<string> {
  const spec = resolveSpawnSpec(connection, { skipSetup: true });
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, [...spec.args, wrapRemoteSh(command)], {
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('远端命令超时'));
    }, SSH_TIMEOUT_MS);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(out || err);
    });
  });
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function syncOnce(connection: Extract<PaneConnection, { kind: 'ssh' }>): Promise<void> {
  const local: { name: string; sum: string; b64: string }[] = [];
  for (const name of COMMANDS) {
    const file = path.join(LOCAL_BIN_DIR, name);
    if (!fs.existsSync(file)) continue;
    local.push({
      name,
      sum: sha256(file),
      b64: fs.readFileSync(file).toString('base64'),
    });
  }
  if (!local.length) return;

  // 1) 远端已有的校验和
  const listed = await sshExec(
    connection,
    `d="${REMOTE_BIN_DIR}"; mkdir -p "$d" && cd "$d" && for f in ${COMMANDS.join(' ')}; do if [ -f "$f" ]; then echo "HAVE $(sha256sum "$f" | cut -d' ' -f1) $f"; else echo "MISS - $f"; fi; done`,
  );
  const remote = new Map<string, string>();
  for (const line of listed.split('\n')) {
    const m = /^HAVE ([0-9a-f]{64}) (\S+)$/.exec(line.trim());
    if (m) remote.set(m[2], m[1]);
  }

  // 2) 上传缺失/内容不同的
  const need = local.filter((f) => remote.get(f.name) !== f.sum);
  if (need.length) {
    const parts = need.map(
      (f) =>
        `printf %s '${f.b64}' | base64 -d > "$d/${f.name}" && chmod 755 "$d/${f.name}"`,
    );
    await sshExec(connection, `d="${REMOTE_BIN_DIR}"; mkdir -p "$d"; ${parts.join('; ')}; echo uploaded`);
  }

  // 3) 把 bin 目录加进 PATH（写进 shell 启动文件；用单行 + 标记，幂等且能自动修正旧内容）
  const line =
    'case ":$PATH:" in *":$HOME/.browser_terminal/bin:"*) ;; *) PATH="$HOME/.browser_terminal/bin:$PATH"; export PATH ;; esac # browser-terminal bin';
  const script = [
    `d="${REMOTE_BIN_DIR}"`,
    'for rc in "$HOME/.bashrc" "$HOME/.profile" "$HOME/.zshrc"; do',
    '  [ -f "$rc" ] || continue',
    `  if grep -q 'browser-terminal bin' "$rc" 2>/dev/null; then grep -v 'browser-terminal bin' "$rc" > "$rc.bt.tmp" && cat "$rc.bt.tmp" > "$rc" && rm -f "$rc.bt.tmp"; fi`,
    `  printf '%s\\n' '${line.replace(/'/g, `'\\''`)}' >> "$rc"`,
    'done',
    `if [ -d "$HOME/.config/fish" ] || [ "\${SHELL##*/}" = "fish" ]; then`,
    '  mkdir -p "$HOME/.config/fish"',
    '  ff="$HOME/.config/fish/config.fish"',
    '  touch "$ff"',
    `  if grep -q 'browser-terminal bin' "$ff" 2>/dev/null; then grep -v 'browser-terminal bin' "$ff" > "$ff.bt.tmp" && cat "$ff.bt.tmp" > "$ff" && rm -f "$ff.bt.tmp"; fi`,
    `  printf '%s\\n' 'if not contains "$HOME/.browser_terminal/bin" $PATH; set -gx PATH "$HOME/.browser_terminal/bin" $PATH; end # browser-terminal bin' >> "$ff"`,
    'fi',
    'echo path-ok',
  ].join('\n');
  await sshExec(connection, script);
}

/**
 * 确保远端有 ~/.browser_terminal/bin/{imgcat,vidcat,vidopen,download,cs}，并把该目录加进 PATH。
 * 每个 SSH 配置 60 秒内只同步一次（远端已存在且校验和一致时不会重复上传），
 * 这样本地脚本更新后，重新打开窗口就能拿到新版本。
 */
export function ensureRemoteBin(connection: PaneConnection): void {
  if (connection?.kind !== 'ssh') return;
  const key = `${connection.profileId}|${connection.sessionPassword ? 'pw' : ''}`;
  const cached = done.get(key);
  if (cached && Date.now() - cached.at < SYNC_TTL_MS) {
    void cached.promise;
    return;
  }
  const entry = { promise: Promise.resolve(), at: Date.now() };
  entry.promise = syncOnce(connection)
    .catch(() => {
      done.delete(key);
    })
    .finally(() => undefined);
  done.set(key, entry);
}

export function remoteBinPathForDisplay(): string {
  return REMOTE_BIN_DIR_LITERAL;
}
