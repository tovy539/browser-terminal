import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import {
  appendExitMarker,
  appendRestartMarker,
  appendSessionMarker,
  clearLogFile,
  openLogStream,
} from "./serviceLogs.js";
import { getService, listServices, setRunningPid } from "./db.js";
import {
  buildRemoteStartScript,
  getSshProfileRecord,
  remoteGetProcessStartDate,
  remotePidAlive,
  remoteStopPid,
  runRemoteScript,
} from "./sshRemote.js";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 保持运行重试间隔：10s → 20s → 30s → … */
function keepRunningDelayMs(attempt) {
  // 第一次尽快拉起（1s），之后退避，避免服务挂掉后长时间不可用
  if (attempt <= 0) return 1_000;
  if (attempt === 1) return 3_000;
  if (attempt === 2) return 10_000;
  return 30_000;
}

function exitIsBenign(code) {
  if (code == null || code === 0) return true;
  if (code < 0) return [-15, -9, -2].includes(code);
  if (code >= 128) return [15, 9, 2].includes(code - 128);
  return false;
}

export function commandArgs(command) {
  const out = [];
  const re = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  let m;
  const s = command.trim();
  while ((m = re.exec(s))) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(m[2]);
    else out.push(m[0]);
  }
  return out;
}

function basenameToken(arg) {
  return path.basename(arg);
}

function tailTokensMatch(cmdline, expected) {
  if (cmdline.length < expected.length) return false;
  const tail = cmdline.slice(-expected.length);
  if (tail.join(" ") === expected.join(" ")) return true;
  const tailBase = tail.map(basenameToken);
  const expBase = expected.map(basenameToken);
  return tailBase.join("\0") === expBase.join("\0");
}

export function cmdlineMatches(record, cmdline) {
  if (!cmdline?.length) return false;
  const expected = commandArgs(record.command);
  if (!expected.length) return false;
  const joined = cmdline.join(" ");
  const expectedJoined = expected.join(" ");
  if (joined === expectedJoined || joined.includes(expectedJoined)) return true;
  if (tailTokensMatch(cmdline, expected)) return true;
  if (cmdline.length >= expected.length && cmdline.slice(0, expected.length).join(" ") === expectedJoined) {
    return true;
  }
  return false;
}

function readProcCmdline(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return raw.split("\0").filter(Boolean);
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 从 /proc 读取进程真实启动时刻（避免 fs.stat birthtime 在 Linux 上不准） */
function getProcessStartDate(pid) {
  try {
    const statContent = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = statContent.lastIndexOf(")");
    if (closeParen < 0) return new Date();
    const rest = statContent.slice(closeParen + 2).split(" ");
    const starttime = Number(rest[19]);
    if (!Number.isFinite(starttime)) return new Date();
    const uptimeSec = Number(
      fs.readFileSync("/proc/uptime", "utf8").trim().split(/\s+/)[0],
    );
    const clkTck = 100;
    const bootMs = Date.now() - uptimeSec * 1000;
    return new Date(bootMs + (starttime / clkTck) * 1000);
  } catch {
    return new Date();
  }
}

function getChildPids(pid) {
  const children = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, "utf8");
        const ppid = Number(stat.split(" ")[3]);
        if (ppid === pid) children.push(Number(d));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return children;
}

async function killTree(pid, timeoutMs = 10000) {
  const all = new Set();
  const stack = [pid];
  while (stack.length) {
    const p = stack.pop();
    if (all.has(p)) continue;
    all.add(p);
    for (const c of getChildPids(p)) stack.push(c);
  }
  for (const p of all) {
    try {
      process.kill(p, "SIGTERM");
    } catch {
      /* ignore */
    }
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = [...all].some((p) => isPidAlive(p));
    if (!alive) break;
    await sleep(200);
  }
  for (const p of all) {
    if (isPidAlive(p)) {
      try {
        process.kill(p, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  return 0;
}

function readProcCwd(pid) {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * 按命令行找"孤儿"进程（服务重启后进程还在、但运行时丢了 pid 的情况）。
 *
 * 坑：两个服务可以用同一条命令（例如 stock 和 token-meter），只按命令行匹配会
 * 把别的服务的进程认成自己的 —— 停一个会把另一个也杀掉。
 * 所以这里必须排除已被其它服务占用的 pid，并优先选工作目录一致的那个。
 */
export function findOrphanPid(record, excludePids = new Set()) {
  const wantCwd = record.working_dir ? path.resolve(record.working_dir) : null;
  const candidates = [];
  try {
    for (const d of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(d)) continue;
      const pid = Number(d);
      if (excludePids.has(pid)) continue;
      const cmdline = readProcCmdline(pid);
      if (!cmdline || !cmdlineMatches(record, cmdline)) continue;
      const cwd = readProcCwd(pid);
      const cwdMatch = wantCwd && cwd ? path.resolve(cwd) === wantCwd : false;
      candidates.push({
        pid,
        cwdMatch,
        startedAt: getProcessStartDate(pid).getTime(),
      });
    }
  } catch {
    /* ignore */
  }
  if (!candidates.length) return null;
  // 工作目录匹配优先，其次启动更早的（先起的更可能是这个服务原来的进程）
  candidates.sort((a, b) => {
    if (a.cwdMatch !== b.cwdMatch) return a.cwdMatch ? -1 : 1;
    return a.startedAt - b.startedAt;
  });
  return candidates[0].pid;
}

function pidMatchesService(pid, record) {
  const cmdline = readProcCmdline(pid);
  if (!cmdline) return false;
  return cmdlineMatches(record, cmdline);
}

function emptyStatus(overrides = {}) {
  return {
    state: "stopped",
    pid: null,
    uptime_seconds: null,
    exit_code: null,
    last_error: null,
    started_at: null,
    ...overrides,
  };
}

class ProcessManager {
  constructor() {
    /** @type {Map<string, any>} */
    this._runtimes = new Map();
    this._chain = Promise.resolve();
  }

  _locked(fn) {
    const run = this._chain.then(() => fn());
    this._chain = run.catch(() => {});
    return run;
  }

  _rt(name) {
    if (!this._runtimes.has(name)) {
      this._runtimes.set(name, {
        child: null,
        attachedPid: null,
        startedAt: null,
        lastError: null,
        exitCode: null,
        stoppedByUser: false,
        logStream: null,
        attachTimer: null,
        isRemote: false,
        sshProfileId: null,
        keepRunningRetryAttempt: 0,
        keepRunningTimer: null,
      });
    }
    return this._runtimes.get(name);
  }

  /** 其它服务已经占用的 pid（数据库记录 + 当前运行时），避免同命令的服务互相认领 */
  _claimedPids(exceptKey) {
    const claimed = new Set();
    try {
      for (const rec of listServices()) {
        if (rec.key === exceptKey) continue;
        if (rec.running_pid) claimed.add(rec.running_pid);
      }
    } catch {
      /* ignore */
    }
    for (const [key, rt] of this._runtimes) {
      if (key === exceptKey) continue;
      if (rt.child?.pid) claimed.add(rt.child.pid);
      if (rt.attachedPid) claimed.add(rt.attachedPid);
    }
    return claimed;
  }

  _clearKeepRunningTimer(rt) {
    if (rt.keepRunningTimer) {
      clearTimeout(rt.keepRunningTimer);
      rt.keepRunningTimer = null;
    }
  }

  _scheduleKeepRunning(name) {
    const rt = this._rt(name);
    this._clearKeepRunningTimer(rt);
    const record = getService(name);
    if (!record?.keep_running || rt.stoppedByUser) return;
    if (this.getStatus(name).state === "running") return;
    const delay = keepRunningDelayMs(rt.keepRunningRetryAttempt);
    rt.keepRunningTimer = setTimeout(() => {
      void this._keepRunningTick(name);
    }, delay);
  }

  async _keepRunningTick(name) {
    const rt = this._rt(name);
    rt.keepRunningTimer = null;
    const record = getService(name);
    if (!record?.keep_running || rt.stoppedByUser) return;
    if (this.getStatus(name).state === "running") {
      rt.keepRunningRetryAttempt = 0;
      return;
    }
    const attempt = rt.keepRunningRetryAttempt;
    appendRestartMarker(name, attempt);
    await this.start(record);
    if (this.getStatus(name).state === "running") {
      rt.keepRunningRetryAttempt = 0;
      return;
    }
    rt.keepRunningRetryAttempt = attempt + 1;
    this._scheduleKeepRunning(name);
  }

  syncKeepRunningPolicy(name) {
    const record = getService(name);
    if (!record?.keep_running) {
      this.clearKeepRunningPolicy(name);
      return;
    }
    const rt = this._rt(name);
    if (rt.stoppedByUser) return;
    if (this.getStatus(name).state === "running") {
      rt.keepRunningRetryAttempt = 0;
      this._clearKeepRunningTimer(rt);
      return;
    }
    rt.keepRunningRetryAttempt = 0;
    this._scheduleKeepRunning(name);
  }

  clearKeepRunningPolicy(name) {
    const rt = this._rt(name);
    this._clearKeepRunningTimer(rt);
    rt.keepRunningRetryAttempt = 0;
  }

  _emitPid(name, pid) {
    setRunningPid(name, pid);
  }

  _resolvePid(rt) {
    if (rt.isRemote) {
      return rt.attachedPid ?? null;
    }
    if (rt.child && rt.child.exitCode === null && !rt.child.killed) {
      return rt.child.pid;
    }
    if (rt.attachedPid != null && isPidAlive(rt.attachedPid)) {
      return rt.attachedPid;
    }
    if (rt.attachedPid != null) rt.attachedPid = null;
    return null;
  }

  getStatus(name) {
    const rt = this._rt(name);
    const pid = this._resolvePid(rt);
    if (pid != null) {
      let startedAt;
      if (rt.isRemote) {
        if (!rt.startedAt) rt.startedAt = new Date();
        startedAt = rt.startedAt;
      } else {
        startedAt = getProcessStartDate(pid);
        rt.startedAt = startedAt;
      }
      const uptime = Math.max(0, (Date.now() - startedAt.getTime()) / 1000);
      return {
        state: "running",
        pid,
        uptime_seconds: uptime,
        exit_code: null,
        last_error: null,
        started_at: startedAt.toISOString(),
      };
    }
    if (
      rt.exitCode != null &&
      rt.exitCode !== 0 &&
      !rt.stoppedByUser &&
      !exitIsBenign(rt.exitCode)
    ) {
      return emptyStatus({
        state: "failed",
        exit_code: rt.exitCode,
        last_error: rt.lastError,
        started_at: rt.startedAt?.toISOString() ?? null,
      });
    }
    return emptyStatus({
      exit_code: rt.exitCode,
      last_error: rt.lastError,
      started_at: rt.startedAt?.toISOString() ?? null,
    });
  }

  rename(oldName, newName) {
    if (oldName === newName) return;
    const rt = this._runtimes.get(oldName);
    if (rt) {
      this._runtimes.delete(oldName);
      this._runtimes.set(newName, rt);
    }
  }

  _monitorChild(name, record, child) {
    child.on("exit", (code, signal) => {
      const rt = this._rt(name);
      appendExitMarker(name, code, signal);
      rt.exitCode = code ?? 0;
      rt.child = null;
      rt.attachedPid = null;
      if (rt.logStream) {
        try {
          rt.logStream.end();
        } catch {
          /* ignore */
        }
        rt.logStream = null;
      }
      this._emitPid(name, null);
      this._afterExit(name, record, rt.exitCode);
    });
  }

  _monitorAttached(name, record, pid) {
    const rt = this._rt(name);
    if (rt.attachTimer) clearInterval(rt.attachTimer);
    rt.attachTimer = setInterval(() => {
      if (!isPidAlive(pid)) {
        clearInterval(rt.attachTimer);
        rt.attachTimer = null;
        rt.attachedPid = null;
        rt.exitCode = 0;
        appendExitMarker(name, 0, null, true);
        this._emitPid(name, null);
        this._afterExit(name, record, 0);
      }
    }, 1000);
  }

  _monitorRemoteAttached(name, record, pid) {
    const rt = this._rt(name);
    if (rt.attachTimer) clearInterval(rt.attachTimer);
    rt.isRemote = true;
    rt.sshProfileId = record.ssh_profile_id;
    rt.attachTimer = setInterval(() => {
      void remotePidAlive(record.ssh_profile_id, pid).then((alive) => {
        if (alive) return;
        clearInterval(rt.attachTimer);
        rt.attachTimer = null;
        rt.attachedPid = null;
        rt.exitCode = 0;
        this._emitPid(name, null);
        void this._afterExit(name, record, 0);
      });
    }, 2000);
  }

  async _reattachRemote(record, pid) {
    const name = record.key; // 复合 key（目标设备 + 名字）
    const rt = this._rt(name);
    if (this._resolvePid(rt) != null) return this.getStatus(name);
    const alive = await remotePidAlive(record.ssh_profile_id, pid);
    if (!alive) return emptyStatus();
    rt.attachedPid = pid;
    rt.child = null;
    rt.stoppedByUser = false;
    rt.lastError = null;
    rt.exitCode = null;
    rt.startedAt =
      (await remoteGetProcessStartDate(record.ssh_profile_id, pid)) ?? new Date();
    rt.isRemote = true;
    rt.sshProfileId = record.ssh_profile_id;
    this._monitorRemoteAttached(name, record, pid);
    const st = this.getStatus(name);
    this._emitPid(name, st.pid);
    return st;
  }

  async _startRemote(record) {
    const name = record.key; // 复合 key（目标设备 + 名字）
    const rt = this._rt(name);
    if (this._resolvePid(rt) != null) return this.getStatus(name);

    rt.lastError = null;
    rt.exitCode = null;
    rt.stoppedByUser = false;
    rt.isRemote = true;
    rt.sshProfileId = record.ssh_profile_id;

    const bundle = getSshProfileRecord(record.ssh_profile_id);
    if (!bundle) {
      rt.lastError = "SSH 配置不存在";
      return emptyStatus({ state: "failed", last_error: rt.lastError });
    }
    if (!bundle.hasStoredCredential) {
      rt.lastError = `SSH「${bundle.profile.name}」未保存凭据，无法运行远程服务`;
      return emptyStatus({ state: "failed", last_error: rt.lastError });
    }

    if (record.running_pid && (await remotePidAlive(record.ssh_profile_id, record.running_pid))) {
      return this._reattachRemote(record, record.running_pid);
    }

    try {
      const script = buildRemoteStartScript(record);
      const out = await runRemoteScript(record.ssh_profile_id, script);
      const tail = out.trim().split(/\s+/).pop();
      const pid = Number(tail);
      if (!Number.isFinite(pid) || pid <= 0) {
        throw new Error("远程启动未返回有效 PID");
      }
      rt.child = null;
      rt.attachedPid = pid;
      rt.startedAt =
        (await remoteGetProcessStartDate(record.ssh_profile_id, pid)) ?? new Date();
      this._monitorRemoteAttached(name, record, pid);
      const st = this.getStatus(name);
      this._emitPid(name, st.pid);
      return st;
    } catch (exc) {
      rt.lastError = exc instanceof Error ? exc.message : String(exc);
      rt.attachedPid = null;
      this._emitPid(name, null);
      const st = emptyStatus({ state: "failed", last_error: rt.lastError });
      if (record.keep_running && !rt.stoppedByUser) {
        rt.keepRunningRetryAttempt = 0;
        this._scheduleKeepRunning(name);
      }
      return st;
    }
  }

  async _afterExit(name, record, code) {
    const rt = this._rt(name);
    const benign = rt.stoppedByUser || exitIsBenign(code);
    if (code !== 0 && !benign) {
      rt.lastError = `进程异常退出，代码 ${code}`;
    } else if (benign) {
      rt.lastError = null;
    }
    const fresh = getService(name) || record;
    if (fresh.keep_running && !rt.stoppedByUser && this.getStatus(name).state !== "running") {
      rt.keepRunningRetryAttempt = 0;
      this._scheduleKeepRunning(name);
    }
  }

  async _reattach(record, pid, trustPid = false) {
    const name = record.key; // 复合 key（目标设备 + 名字）
    const rt = this._rt(name);
    if (this._resolvePid(rt) != null) return this.getStatus(name);
    if (!trustPid && !pidMatchesService(pid, record)) return emptyStatus();
    rt.attachedPid = pid;
    rt.child = null;
    rt.stoppedByUser = false;
    rt.lastError = null;
    rt.exitCode = null;
    rt.startedAt = getProcessStartDate(pid);
    this._monitorAttached(name, record, pid);
    const st = this.getStatus(name);
    this._emitPid(name, st.pid);
    return st;
  }

  async reconcileRecord(record) {
    return this._locked(async () => {
      if (record.ssh_profile_id) {
        if (
          record.running_pid &&
          (await remotePidAlive(record.ssh_profile_id, record.running_pid))
        ) {
          const st = await this._reattachRemote(record, record.running_pid);
          return st.pid ?? null;
        }
        this._emitPid(record.key, null);
        return null;
      }
      const claimed = this._claimedPids(record.key);
      if (
        record.running_pid &&
        !claimed.has(record.running_pid) &&
        isPidAlive(record.running_pid)
      ) {
        const st = await this._reattach(record, record.running_pid, true);
        return st.pid ?? null;
      }
      const orphan = findOrphanPid(record, claimed);
      if (orphan) {
        const st = await this._reattach(record, orphan);
        return st.pid ?? null;
      }
      this._emitPid(record.key, null);
      return null;
    });
  }

  async _startUnlocked(record) {
    if (record.ssh_profile_id) {
      return this._startRemote(record);
    }

    const name = record.key; // 复合 key（目标设备 + 名字）
    const rt = this._rt(name);
    rt.isRemote = false;
    rt.sshProfileId = null;
    if (this._resolvePid(rt) != null) return this.getStatus(name);

    rt.lastError = null;
    rt.exitCode = null;
    rt.stoppedByUser = false;

    const claimed = this._claimedPids(name);
    if (
      record.running_pid &&
      !claimed.has(record.running_pid) &&
      isPidAlive(record.running_pid)
    ) {
      return this._reattach(record, record.running_pid, true);
    }
    const orphan = findOrphanPid(record, claimed);
    if (orphan) return this._reattach(record, orphan);

    const cwd = record.working_dir || undefined;
    if (cwd && !fs.existsSync(cwd)) {
      rt.lastError = `工作目录不存在: ${cwd}`;
      const st = emptyStatus({ state: "failed", last_error: rt.lastError });
      if (record.keep_running && !rt.stoppedByUser) {
        rt.keepRunningRetryAttempt = 0;
        this._scheduleKeepRunning(name);
      }
      return st;
    }

    try {
      const args = commandArgs(record.command);
      if (!args.length) throw new Error("命令为空");
      clearLogFile(name);
      const logStream = openLogStream(name);
      rt.logStream = logStream;
      const env = { ...process.env, ...record.env };
      const child = spawn(args[0], args.slice(1), {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.pipe(logStream, { end: false });
      child.stderr.pipe(logStream, { end: false });
      // spawn 失败（命令不存在 / 没有执行权限）会异步抛 'error'：不处理会把整个终端服务带崩
      child.on("error", (err) => {
        rt.lastError = `启动失败: ${err.message}`;
        rt.exitCode = 1;
        rt.child = null;
        rt.attachedPid = null;
        this._emitPid(name, null);
        if (record.keep_running && !rt.stoppedByUser) {
          rt.keepRunningRetryAttempt = 0;
          this._scheduleKeepRunning(name);
        }
      });
      rt.child = child;
      rt.attachedPid = child.pid;
      appendSessionMarker(name, child.pid);
      rt.startedAt = new Date();
      this._monitorChild(name, record, child);
      const st = this.getStatus(name);
      this._emitPid(name, st.pid);
      return st;
    } catch (exc) {
      rt.lastError = exc instanceof Error ? exc.message : String(exc);
      rt.child = null;
      rt.attachedPid = null;
      this._emitPid(name, null);
      const st = emptyStatus({ state: "failed", last_error: rt.lastError });
      if (record.keep_running && !rt.stoppedByUser) {
        rt.keepRunningRetryAttempt = 0;
        this._scheduleKeepRunning(name);
      }
      return st;
    }
  }

  start(record) {
    return this._locked(async () => {
      const st = await this._startUnlocked(record);
      const fresh = getService(record.key) || record;
      if (
        fresh.keep_running &&
        st.state !== "running" &&
        !this._rt(record.key).stoppedByUser
      ) {
        const rt = this._rt(record.key);
        if (!rt.keepRunningTimer) {
          rt.keepRunningRetryAttempt = 0;
          this._scheduleKeepRunning(record.key);
        }
      }
      return st;
    });
  }

  async _stopUnlocked(record) {
    const name = record.key; // 复合 key（目标设备 + 名字）
    const rt = this._rt(name);
    let pid = this._resolvePid(rt);

    if (record.ssh_profile_id || rt.isRemote) {
      rt.stoppedByUser = true;
      this._clearKeepRunningTimer(rt);
      if (pid != null) {
        try {
          await remoteStopPid(record.ssh_profile_id || rt.sshProfileId, pid);
          rt.exitCode = 0;
        } catch (exc) {
          rt.lastError = exc instanceof Error ? exc.message : String(exc);
          rt.exitCode = 1;
        }
      }
      if (rt.attachTimer) {
        clearInterval(rt.attachTimer);
        rt.attachTimer = null;
      }
      rt.child = null;
      rt.attachedPid = null;
      rt.isRemote = false;
      rt.sshProfileId = null;
      if (exitIsBenign(rt.exitCode)) rt.lastError = null;
      this._emitPid(name, null);
      return this.getStatus(name);
    }

    if (pid == null) {
      const orphan = findOrphanPid(record, this._claimedPids(name));
      if (orphan) {
        rt.stoppedByUser = true;
        this._clearKeepRunningTimer(rt);
        rt.exitCode = await killTree(orphan);
        rt.child = null;
        rt.attachedPid = null;
        if (exitIsBenign(rt.exitCode)) rt.lastError = null;
      }
      return this.getStatus(name);
    }

    rt.stoppedByUser = true;
    this._clearKeepRunningTimer(rt);
    try {
      if (rt.child && rt.child.exitCode === null) {
        await killTree(rt.child.pid);
        try {
          rt.child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      } else {
        rt.exitCode = await killTree(pid);
      }
    } catch (exc) {
      rt.lastError = exc instanceof Error ? exc.message : String(exc);
    }
    if (rt.attachTimer) {
      clearInterval(rt.attachTimer);
      rt.attachTimer = null;
    }
    rt.child = null;
    rt.attachedPid = null;
    if (rt.logStream) {
      try {
        rt.logStream.end();
      } catch {
        /* ignore */
      }
      rt.logStream = null;
    }
    if (exitIsBenign(rt.exitCode)) rt.lastError = null;
    const st = this.getStatus(name);
    this._emitPid(name, null);
    return st;
  }

  stopWithRecord(record) {
    return this._locked(() => this._stopUnlocked(record));
  }

  async restart(record) {
    await this.stopWithRecord(record);
    return this.start(record);
  }

  async removeRuntime(name, record) {
    await this.stopWithRecord(record);
    const rt = this._runtimes.get(name);
    if (rt?.attachTimer) clearInterval(rt.attachTimer);
    if (rt) this._clearKeepRunningTimer(rt);
    this._runtimes.delete(name);
  }

  async ensureKeepRunningAll(records) {
    for (const record of records) {
      if (!record.keep_running) continue;
      const rt = this._rt(record.key);
      if (rt.stoppedByUser) continue;
      if (this.getStatus(record.key).state === "running") continue;
      rt.keepRunningRetryAttempt = 0;
      await this.start(record);
      if (this.getStatus(record.key).state !== "running" && !rt.keepRunningTimer) {
        this._scheduleKeepRunning(record.key);
      }
    }
  }

  /** @deprecated 使用 ensureKeepRunningAll */
  async autostartAll(records) {
    return this.ensureKeepRunningAll(records);
  }
}

export const processManager = new ProcessManager();
