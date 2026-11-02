import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { settings } from "./config.js";
import { requireAdmin } from "./auth.js";
import { localIpv4Addresses } from "./network.js";
import {
  listServices,
  getService,
  createService,
  updateService,
  deleteService,
  reorderServices,
} from "./db.js";
import { processManager } from "./processManager.js";
import { readServiceLogs, renameLog } from "./serviceLogs.js";
import { getSshProfileRecord } from "./sshRemote.js";

const NAME_RE = /^[\p{L}\p{N}_.-]+$/u;

function isValidServiceName(name) {
  if (typeof name !== "string") return false;
  const t = name.trim();
  if (!t || t.length > 64) return false;
  if (/[/\\]/.test(t)) return false;
  return NAME_RE.test(t);
}

function normalizeSshProfileId(raw) {
  if (raw === undefined || raw === null || raw === "" || raw === "local") return null;
  return String(raw);
}

function validateSshTarget(sshProfileId) {
  if (!sshProfileId) return null;
  const bundle = getSshProfileRecord(sshProfileId);
  if (!bundle) return "SSH 配置不存在";
  if (!bundle.hasStoredCredential) {
    return `SSH「${bundle.profile.name}」未保存凭据，请先在设置中保存密码或私钥`;
  }
  return null;
}

function recordToResponse(record) {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    command: record.command,
    working_dir: record.working_dir,
    env: record.env,
    keep_running: record.keep_running,
    autostart: record.autostart,
    restart_on_failure: record.restart_on_failure,
    ssh_profile_id: record.ssh_profile_id,
    created_at: record.created_at,
    updated_at: record.updated_at,
    status: processManager.getStatus(record.name),
  };
}

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "service-manager",
    auth_required: !!settings.adminPassword,
  });
});

app.get("/api/auth/me", requireAdmin, (req, res) => {
  res.json({ ok: true, user: req.adminUser });
});

app.get("/api/services", requireAdmin, (_req, res) => {
  res.json(listServices().map(recordToResponse));
});

app.put("/api/services/order", requireAdmin, (req, res) => {
  const order = (req.body || {}).order;
  const result = reorderServices(order);
  if (!result.ok) return res.status(422).json({ detail: result.detail || "排序无效" });
  res.json({ ok: true });
});

app.get("/api/services/:name", requireAdmin, (req, res) => {
  const record = getService(req.params.name);
  if (!record) return res.status(404).json({ detail: "服务不存在" });
  res.json(recordToResponse(record));
});

app.post("/api/services", requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!isValidServiceName(body.name)) {
    return res.status(422).json({
      detail: "名称无效（1–64 字符，可用中文，不可含 / 或 \\）",
    });
  }
  if (!body.command?.trim()) {
    return res.status(422).json({ detail: "命令不能为空" });
  }
  if (getService(body.name)) {
    return res.status(409).json({ detail: "服务名称已存在" });
  }
  const sshProfileId = normalizeSshProfileId(body.ssh_profile_id);
  const sshErr = validateSshTarget(sshProfileId);
  if (sshErr) return res.status(422).json({ detail: sshErr });
  const record = createService({ ...body, ssh_profile_id: sshProfileId });
  if (record.keep_running) {
    processManager.syncKeepRunningPolicy(record.name);
  }
  res.status(201).json(recordToResponse(record));
});

app.patch("/api/services/:name", requireAdmin, (req, res) => {
  const oldName = req.params.name;
  let record = getService(oldName);
  if (!record) return res.status(404).json({ detail: "服务不存在" });
  const body = req.body || {};
  if (body.name != null && body.name !== oldName) {
    if (!isValidServiceName(body.name)) {
      return res.status(422).json({
        detail: "名称无效（1–64 字符，可用中文，不可含 / 或 \\）",
      });
    }
    if (getService(body.name)) {
      return res.status(409).json({ detail: "服务名称已存在" });
    }
    processManager.rename(oldName, body.name);
    renameLog(oldName, body.name);
  }
  const sshProfileId =
    body.ssh_profile_id !== undefined
      ? normalizeSshProfileId(body.ssh_profile_id)
      : record.ssh_profile_id;
  const sshErr = validateSshTarget(sshProfileId);
  if (sshErr) return res.status(422).json({ detail: sshErr });
  const keepPatch =
    body.keep_running !== undefined ||
    body.autostart !== undefined ||
    body.restart_on_failure !== undefined;
  record = updateService(oldName, {
    name: body.name ?? record.name,
    description: body.description ?? record.description,
    command: body.command ?? record.command,
    working_dir: body.working_dir ?? record.working_dir,
    env: body.env ?? record.env,
    keep_running:
      body.keep_running ??
      (keepPatch
        ? body.autostart ?? body.restart_on_failure ?? record.keep_running
        : record.keep_running),
    autostart: body.autostart,
    restart_on_failure: body.restart_on_failure,
    ssh_profile_id: sshProfileId,
  });
  if (keepPatch && record) {
    if (record.keep_running) {
      processManager.syncKeepRunningPolicy(record.name);
    } else {
      processManager.clearKeepRunningPolicy(record.name);
    }
  }
  res.json(recordToResponse(record));
});

app.delete("/api/services/:name", requireAdmin, async (req, res) => {
  const record = getService(req.params.name);
  if (!record) return res.status(404).json({ detail: "服务不存在" });
  await processManager.removeRuntime(record.name, record);
  deleteService(record.name);
  res.json({ ok: true, message: `已删除服务 ${record.name}` });
});

app.get("/api/services/:name/logs", requireAdmin, async (req, res) => {
  const record = getService(req.params.name);
  if (!record) return res.status(404).json({ detail: "服务不存在" });
  const lines = Math.min(Math.max(Number(req.query.lines) || 500, 1), 5000);
  const { content, truncated } = await readServiceLogs(record, lines);
  res.json({ content, lines, truncated });
});

app.post("/api/services/:name/start", requireAdmin, async (req, res) => {
  const record = getService(req.params.name);
  if (!record) return res.status(404).json({ detail: "服务不存在" });
  const status = await processManager.start(record);
  const ok = status.state === "running";
  res.json({
    ok,
    message: ok ? "已启动" : status.last_error || "启动失败",
    status,
  });
});

app.post("/api/services/:name/stop", requireAdmin, async (req, res) => {
  const record = getService(req.params.name);
  if (!record) return res.status(404).json({ detail: "服务不存在" });
  const status = await processManager.stopWithRecord(record);
  res.json({ ok: true, message: "已停止", status });
});

app.post("/api/services/:name/restart", requireAdmin, async (req, res) => {
  const record = getService(req.params.name);
  if (!record) return res.status(404).json({ detail: "服务不存在" });
  const status = await processManager.restart(record);
  const ok = status.state === "running";
  res.json({
    ok,
    message: ok ? "已重启" : status.last_error || "重启失败",
    status,
  });
});

const staticDir = settings.staticDir;
if (fs.existsSync(path.join(staticDir, "index.html"))) {
  app.use("/assets", express.static(path.join(staticDir, "assets")));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(staticDir, "index.html"));
  });
}

async function bootstrap() {
  console.log(`[Service Manager] 监听 http://${settings.host}:${settings.port}`);
  if (settings.host === "0.0.0.0" || settings.host === "::") {
    for (const ip of localIpv4Addresses()) {
      console.log(`[Service Manager] 局域网访问: http://${ip}:${settings.port}`);
    }
  }
  if (settings.passwordJustGenerated) {
    console.log(
      `[Service Manager] 已生成管理密码（用户 ${settings.adminUser}），保存在 data/admin_password: ${settings.adminPassword}`,
    );
  } else if (settings.adminPassword) {
    console.log(`[Service Manager] 管理账号: ${settings.adminUser}（已启用密码保护）`);
  }

  const records = listServices();
  for (const record of records) {
    await processManager.reconcileRecord(record);
  }
  await processManager.ensureKeepRunningAll(records);

  app.listen(settings.port, settings.host, () => {
    console.log("[Service Manager] Node.js 后端已就绪");
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
