import fs from "fs";
import path from "path";
import { settings } from "./config.js";
import { readRemoteLogTail } from "./sshRemote.js";

function logsDir() {
  const d = path.join(settings.dataDir, "logs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** key（目标设备 + 名字）→ 日志文件名：local__name.log / ssh-xxx__name.log */
export function logFileName(key) {
  const [target, name] = String(key).split("\u0000");
  const safeTarget = (target || "local").replace(/[^\w.-]+/g, "_");
  const safeName = (name || "").replace(/[^\w.\u4e00-\u9fa5-]+/g, "_");
  return `${safeTarget}__${safeName}.log`;
}

export function logPath(key) {
  return path.join(logsDir(), logFileName(key));
}

/**
 * 启动前处理旧日志：不再清空（清空会丢掉崩溃现场），只在文件过大时轮转成 .1
 * 保留 .1 一份，便于回看上一次为什么挂掉
 */
export function clearLogFile(serviceName) {
  logsDir();
  const p = logPath(serviceName);
  try {
    const st = fs.statSync(p);
    if (st.size > 2 * 1024 * 1024) {
      fs.renameSync(p, `${p}.1`);
    }
  } catch {
    /* 文件不存在就不用管 */
  }
  if (!fs.existsSync(p)) fs.writeFileSync(p, "", "utf8");
}

/** keep_running 自动拉起时记一笔，便于统计重启次数 */
export function appendRestartMarker(serviceName, attempt) {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  try {
    fs.appendFileSync(
      logPath(serviceName),
      `===== 自动重启 ${ts} 第 ${attempt + 1} 次 =====\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

/** 进程退出时追加一行，便于事后判断是正常退出还是被信号杀掉 */
export function appendExitMarker(serviceName, code, signal, adopted = false) {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  const tail = adopted
    ? '（接管进程消失，非本进程收到 exit 事件）'
    : signal
      ? `信号 ${signal}`
      : `代码 ${code ?? 0}`;
  try {
    fs.appendFileSync(logPath(serviceName), `===== 退出 ${ts} ${tail} =====\n`, "utf8");
  } catch {
    /* ignore */
  }
}

export function appendSessionMarker(serviceName, pid) {
  const ts = new Date().toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
  fs.appendFileSync(
    logPath(serviceName),
    `===== 启动 ${ts} PID ${pid} =====\n`,
    "utf8",
  );
}

export function openLogStream(serviceName) {
  return fs.createWriteStream(logPath(serviceName), { flags: "a", encoding: "utf8" });
}

export function readTail(serviceName, lines = 500) {
  const p = logPath(serviceName);
  if (!fs.existsSync(p)) return { content: "", truncated: false };
  const maxLines = Math.min(Math.max(lines, 1), 5000);
  const all = fs.readFileSync(p, "utf8").split("\n");
  const truncated = all.length > maxLines;
  const tail = all.slice(-maxLines).join("\n");
  return { content: tail, truncated };
}

export function renameLog(oldName, newName) {
  const oldP = logPath(oldName);
  const newP = logPath(newName);
  if (fs.existsSync(oldP) && !fs.existsSync(newP)) {
    fs.renameSync(oldP, newP);
  }
}

export async function readServiceLogs(record, lines = 500) {
  if (record.ssh_profile_id) {
    return readRemoteLogTail(record.ssh_profile_id, record.name, lines);
  }
  return readTail(record.key, lines);
}
