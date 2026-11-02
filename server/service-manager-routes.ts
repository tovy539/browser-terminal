import type { Express, NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 数据目录默认在本仓库 `data/`（可通过 SM_ROOT 覆盖根路径） */
if (!process.env.SM_ROOT) {
  process.env.SM_ROOT = path.resolve(__dirname, '..');
}

const smBackend = path.join(__dirname, 'service-manager');
const sm = (file: string) => import(pathToFileURL(path.join(smBackend, file)).href);

const { settings } = await sm('config.js');
const {
  listServices,
  getService,
  getServiceByNameTarget,
  createService,
  updateService,
  deleteService,
  reorderServices,
} = await sm('db.js');
const { processManager } = await sm('processManager.js');
const { readServiceLogs, renameLog, logFileName } = await sm('serviceLogs.js');
const { getSshProfileRecord } = await sm('sshRemote.js');

/** 允许中文等 Unicode 字母/数字；不可含路径分隔符 */
const NAME_RE = /^[\p{L}\p{N}_.-]+$/u;

function isValidServiceName(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const t = name.trim();
  if (!t || t.length > 64) return false;
  if (/[/\\]/.test(t)) return false;
  return NAME_RE.test(t);
}

function normalizeSshProfileId(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'local') return null;
  return String(raw);
}

function validateSshTarget(sshProfileId: string | null): string | null {
  if (!sshProfileId) return null;
  const bundle = getSshProfileRecord(sshProfileId) as {
    profile: { name: string };
    hasStoredCredential: boolean;
  } | null;
  if (!bundle) return 'SSH 配置不存在';
  if (!bundle.hasStoredCredential) {
    return `SSH「${bundle.profile.name}」未保存凭据，请先在设置中保存密码或私钥`;
  }
  return null;
}

type SmRecord = ReturnType<typeof getService>;

function recordToResponse(record: NonNullable<SmRecord>) {
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
    key: record.key,
    created_at: record.created_at,
    updated_at: record.updated_at,
    status: processManager.getStatus(record.key),
  };
}

/** 请求里的目标设备：本地为空串，远端为 SSH 配置 id */
function targetOf(req: Request): string {
  const fromQuery = typeof req.query.target === 'string' ? req.query.target : '';
  const fromBody =
    req.body && typeof req.body.target === 'string' ? (req.body.target as string) : '';
  const target = fromQuery || fromBody;
  return target === 'local' ? '' : target;
}

function recordOf(req: Request): NonNullable<SmRecord> | null {
  return getServiceByNameTarget(req.params.name, targetOf(req));
}

function requireTerminalSession(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthRequired()) {
    next();
    return;
  }
  const token = resolveAuthToken(req.headers.cookie, req.headers.authorization);
  if (verifyToken(token)) {
    next();
    return;
  }
  res.status(401).json({ detail: '请先登录浏览器终端' });
}

export function registerServiceManagerRoutes(app: Express): void {
  app.get('/api/sm/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'service-manager',
      embedded: true,
      data_dir: settings.dataDir,
    });
  });

  app.get('/api/sm/services', requireTerminalSession, (_req, res) => {
    res.json(listServices().map((r) => recordToResponse(r)));
  });

  app.put('/api/sm/services/order', requireTerminalSession, (req, res) => {
    const order = (req.body || {}).order;
    const result = reorderServices(order) as { ok: boolean; detail?: string };
    if (!result.ok) {
      res.status(422).json({ detail: result.detail || '排序无效' });
      return;
    }
    res.json({ ok: true });
  });

  app.get('/api/sm/services/:name', requireTerminalSession, (req, res) => {
    const record = recordOf(req);
    if (!record) {
      res.status(404).json({ detail: '服务不存在' });
      return;
    }
    res.json(recordToResponse(record));
  });

  app.post('/api/sm/services', requireTerminalSession, (req, res) => {
    const body = req.body || {};
    if (!isValidServiceName(body.name)) {
      res.status(422).json({
        detail: '名称无效（1–64 字符，可用中文，不可含 / 或 \\）',
      });
      return;
    }
    if (!body.command?.trim()) {
      res.status(422).json({ detail: '命令不能为空' });
      return;
    }
    const sshProfileId = normalizeSshProfileId(body.ssh_profile_id);
    if (getServiceByNameTarget(body.name, sshProfileId ?? '')) {
      res.status(409).json({ detail: '该设备上已有同名服务' });
      return;
    }
    const sshErr = validateSshTarget(sshProfileId);
    if (sshErr) {
      res.status(422).json({ detail: sshErr });
      return;
    }
    const record = createService({ ...body, ssh_profile_id: sshProfileId });
    if (record.keep_running) {
      processManager.syncKeepRunningPolicy(record.key);
    }
    res.status(201).json(recordToResponse(record));
  });

  app.patch('/api/sm/services/:name', requireTerminalSession, (req, res) => {
    const oldName = req.params.name;
    let record = recordOf(req);
    if (!record) {
      res.status(404).json({ detail: '服务不存在' });
      return;
    }
    const keyOfInitial = record.key;
    const body = req.body || {};
    if (body.name != null && body.name !== oldName) {
      if (!isValidServiceName(body.name)) {
        res.status(422).json({
          detail: '名称无效（1–64 字符，可用中文，不可含 / 或 \\）',
        });
        return;
      }
    }
    const sshProfileId =
      body.ssh_profile_id !== undefined
        ? normalizeSshProfileId(body.ssh_profile_id)
        : record.ssh_profile_id;
    const sshErr = validateSshTarget(sshProfileId);
    if (sshErr) {
      res.status(422).json({ detail: sshErr });
      return;
    }
    const nextTarget =
      body.ssh_profile_id !== undefined ? normalizeSshProfileId(body.ssh_profile_id) ?? '' : record.ssh_profile_id ?? '';
    if (nextTarget !== (record.ssh_profile_id ?? '') || (body.name && body.name !== record.name)) {
      const dup = getServiceByNameTarget(body.name ?? record.name, nextTarget);
      if (dup && dup.id !== record.id) {
        res.status(409).json({ detail: '该设备上已有同名服务' });
        return;
      }
    }
    const keepPatch =
      body.keep_running !== undefined ||
      body.autostart !== undefined ||
      body.restart_on_failure !== undefined;
    record = updateService(record.key, {
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
    if (record) {
      // 改名 / 换目标设备：运行时和日志都要跟着迁移，否则状态会显示成"已停止"
      const renamed = record.key !== keyOfInitial;
      if (renamed) {
        processManager.rename(keyOfInitial, record.key);
        renameLog(keyOfInitial, record.key);
      }
      if (keepPatch || renamed) {
        if (record.keep_running) {
          processManager.syncKeepRunningPolicy(record.key);
        } else {
          processManager.clearKeepRunningPolicy(record.key);
        }
      }
    }
    res.json(recordToResponse(record!));
  });

  app.delete('/api/sm/services/:name', requireTerminalSession, async (req, res) => {
    const record = recordOf(req);
    if (!record) {
      res.status(404).json({ detail: '服务不存在' });
      return;
    }
    await processManager.removeRuntime(record.key, record);
    deleteService(record.key);
    res.json({ ok: true, message: `已删除服务 ${record.name}` });
  });

  app.get('/api/sm/services/:name/logs', requireTerminalSession, async (req, res) => {
    const record = recordOf(req);
    if (!record) {
      res.status(404).json({ detail: '服务不存在' });
      return;
    }
    const lines = Math.min(Math.max(Number(req.query.lines) || 500, 1), 5000);
    const { content, truncated } = await readServiceLogs(record, lines);
    res.json({ content, lines, truncated });
  });

  app.post('/api/sm/services/:name/start', requireTerminalSession, async (req, res) => {
    const record = recordOf(req);
    if (!record) {
      res.status(404).json({ detail: '服务不存在' });
      return;
    }
    const status = await processManager.start(record);
    const ok = status.state === 'running';
    res.json({
      ok,
      message: ok ? '已启动' : status.last_error || '启动失败',
      status,
    });
  });

  app.post('/api/sm/services/:name/stop', requireTerminalSession, async (req, res) => {
    const record = recordOf(req);
    if (!record) {
      res.status(404).json({ detail: '服务不存在' });
      return;
    }
    const status = await processManager.stopWithRecord(record);
    res.json({ ok: true, message: '已停止', status });
  });

  app.post('/api/sm/services/:name/restart', requireTerminalSession, async (req, res) => {
    const record = recordOf(req);
    if (!record) {
      res.status(404).json({ detail: '服务不存在' });
      return;
    }
    const status = await processManager.restart(record);
    const ok = status.state === 'running';
    res.json({
      ok,
      message: ok ? '已重启' : status.last_error || '重启失败',
      status,
    });
  });
}

export async function bootstrapServiceManager(): Promise<void> {
  const records = listServices();
  // 老日志按名字命名（<name>.log），现在按 key 命名：迁移一次
  for (const record of records) {
    try {
      const oldPath = path.join(settings.dataDir, 'logs', `${record.name}.log`);
      const newPath = path.join(settings.dataDir, 'logs', logFileName(record.key));
      if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
        fs.renameSync(oldPath, newPath);
      }
    } catch {
      /* ignore */
    }
  }
  for (const record of records) {
    await processManager.reconcileRecord(record);
  }
  await processManager.ensureKeepRunningAll(records);
  console.log(
    `[Service Manager] 已嵌入终端服务，数据目录: ${settings.dataDir}`,
  );
}
