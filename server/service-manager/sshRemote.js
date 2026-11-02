import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { settings } from "./config.js";

const storePath =
  process.env.SSH_PROFILES_FILE ||
  path.join(settings.rootDir, ".run", "ssh-profiles.json");

function loadStore() {
  try {
    if (!fs.existsSync(storePath)) {
      return { profiles: [], secrets: {} };
    }
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
    return {
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
      secrets: raw.secrets && typeof raw.secrets === "object" ? raw.secrets : {},
    };
  } catch {
    return { profiles: [], secrets: {} };
  }
}

function commandExists(cmd) {
  const pathEnv = process.env.PATH || "";
  for (const dir of pathEnv.split(":")) {
    try {
      if (fs.existsSync(path.join(dir, cmd))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** OpenSSH 私钥 PEM 必须以换行结尾，否则 ssh 报 error in libcrypto */
function normalizePrivateKeyPem(key) {
  const trimmed = String(key).replace(/\r\n/g, "\n").trim();
  if (!trimmed) return trimmed;
  return trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
}

export function getSshProfileRecord(profileId) {
  if (!profileId) return null;
  const store = loadStore();
  const pub = store.profiles.find((p) => p.id === profileId);
  if (!pub) return null;
  const secret = store.secrets[profileId] ?? {};
  let hasStoredCredential = false;
  if (pub.authType === "password") {
    hasStoredCredential = !!secret.password;
  } else if (pub.authType === "systemKey") {
    hasStoredCredential = hasSystemSshKeys();
  } else {
    hasStoredCredential = !!secret.privateKey;
  }
  return { profile: pub, secret, hasStoredCredential };
}

function hasSystemSshKeys() {
  const dir = path.join(os.homedir(), ".ssh");
  for (const name of ["id_ed25519", "id_rsa", "id_ecdsa", "id_dsa"]) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export function remoteLogPath(serviceName) {
  return `$HOME/.browser-terminal-sm/logs/${serviceName}.log`;
}

function buildSshSpawn(profile, secret) {
  const sshOpts = [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "UserKnownHostsFile=" + path.join(os.homedir(), ".ssh", "known_hosts"),
    "-p",
    String(profile.port),
  ];
  const target = `${profile.username}@${profile.host}`;

  if (profile.authType === "password") {
    const password = secret.password;
    if (!password) {
      return { error: `SSH「${profile.name}」未保存密码，无法在此主机运行服务` };
    }
    if (!commandExists("sshpass")) {
      return { error: "服务器未安装 sshpass，无法使用密码 SSH 运行远程服务" };
    }
    return {
      file: "sshpass",
      args: ["-e", "ssh", ...sshOpts, target],
      env: { ...process.env, SSHPASS: password },
    };
  }

  if (profile.authType === "systemKey") {
    if (!hasSystemSshKeys()) {
      return {
        error: `SSH「${profile.name}」：网关 ~/.ssh 下未找到 id_ed25519 / id_rsa 等默认私钥`,
      };
    }
    return {
      file: "ssh",
      args: [...sshOpts, target],
      env: process.env,
    };
  }

  if (!secret.privateKey) {
    return { error: `SSH「${profile.name}」未配置私钥` };
  }

  const keyDir = path.join(settings.rootDir, ".run", "ssh-keys");
  fs.mkdirSync(keyDir, { recursive: true });
  const keyPath = path.join(keyDir, `${profile.id}.key`);
  fs.writeFileSync(keyPath, normalizePrivateKeyPem(secret.privateKey), {
    mode: 0o600,
  });

  return {
    file: "ssh",
    args: ["-i", keyPath, ...sshOpts, target],
    env: process.env,
  };
}

let sshPoolModulePromise = null;

function loadSshPoolModule() {
  if (!sshPoolModulePromise) {
    sshPoolModulePromise = import("../ssh-metrics-pool.ts").catch(() =>
      import("../ssh-metrics-pool.js"),
    );
  }
  return sshPoolModulePromise;
}

function runRemoteScriptOneShot(spec, script) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.file, [...spec.args, "bash", "-s"], {
      env: spec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.stdin.write(script);
    child.stdin.end();
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `SSH 退出码 ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function runRemoteScript(profileId, script) {
  const bundle = getSshProfileRecord(profileId);
  if (!bundle) throw new Error("SSH 配置不存在");
  const spec = buildSshSpawn(bundle.profile, bundle.secret);
  if (spec.error) throw new Error(spec.error);

  try {
    const { runPooledRemoteScript, invalidatePooledRemote } =
      await loadSshPoolModule();
    try {
      return await runPooledRemoteScript(profileId, script);
    } catch {
      invalidatePooledRemote(profileId);
      try {
        return await runPooledRemoteScript(profileId, script);
      } catch {
        return runRemoteScriptOneShot(spec, script);
      }
    }
  } catch {
    return runRemoteScriptOneShot(spec, script);
  }
}

export function buildRemoteStartScript(record) {
  const envLines = Object.entries(record.env || {})
    .map(([k, v]) => `export ${k}=${shQuote(v)}`)
    .join("\n");
  const cwdLine = record.working_dir
    ? `cd ${shQuote(record.working_dir)} || exit 1`
    : "";
  return `
set -e
mkdir -p "$HOME/.browser-terminal-sm/logs"
LOG="$HOME/.browser-terminal-sm/logs/${record.name}.log"
: > "$LOG"
echo "===== 启动 $(date -u +%Y-%m-%dT%H:%M:%SZ) =====" >> "$LOG"
${cwdLine}
${envLines}
nohup bash -c ${shQuote(record.command)} >> "$LOG" 2>&1 &
pid=$!
disown $pid 2>/dev/null || true
echo "$pid"
`.trim();
}

/** 远程 /proc 读取进程启动时刻（与本地 getProcessStartDate 逻辑一致） */
export async function remoteGetProcessStartDate(profileId, pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return null;
  const script = `
pid=${p}
if [ ! -d "/proc/$pid" ]; then exit 1; fi
start=$(awk '{print $22}' "/proc/$pid/stat")
read up _ </proc/uptime
clk=$(getconf CLK_TCK 2>/dev/null || echo 100)
now=$(date +%s)
start_sec=$(awk -v now="$now" -v up="$up" -v st="$start" -v clk="$clk" 'BEGIN{printf "%d", now-int(up)+int(st/clk)}')
echo "$start_sec"
`;
  try {
    const out = await runRemoteScript(profileId, script);
    const line = out.trim().split(/\s+/).pop();
    const sec = Number(line);
    if (!Number.isFinite(sec) || sec <= 0) return null;
    return new Date(sec * 1000);
  } catch {
    return null;
  }
}

export async function remotePidAlive(profileId, pid) {
  if (!pid) return false;
  const script = `kill -0 ${Number(pid)} 2>/dev/null && echo alive || echo dead`;
  try {
    const out = await runRemoteScript(profileId, script);
    return out.trim().endsWith("alive");
  } catch {
    return false;
  }
}

export async function remoteStopPid(profileId, pid) {
  const p = Number(pid);
  if (!Number.isFinite(p) || p <= 0) return;
  const script = `
p=${p}
kill -TERM "$p" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 "$p" 2>/dev/null || exit 0
  sleep 0.2
done
kill -KILL "$p" 2>/dev/null || true
`;
  await runRemoteScript(profileId, script);
}

export async function readRemoteLogTail(profileId, serviceName, lines = 500) {
  const maxLines = Math.min(Math.max(lines, 1), 5000);
  const script = `
LOG="$HOME/.browser-terminal-sm/logs/${serviceName}.log"
if [ ! -f "$LOG" ]; then exit 0; fi
tail -n ${maxLines} "$LOG"
`;
  try {
    const content = await runRemoteScript(profileId, script);
    const all = content.split("\n");
    const truncated = all.length > maxLines;
    return { content: content.replace(/\n$/, ""), truncated };
  } catch (exc) {
    const msg = exc instanceof Error ? exc.message : String(exc);
    return { content: msg, truncated: false };
  }
}
