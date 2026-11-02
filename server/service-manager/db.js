import Database from "better-sqlite3";
import fs from "fs";
import { settings } from "./config.js";

fs.mkdirSync(settings.dataDir, { recursive: true });

const db = new Database(settings.dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    command TEXT NOT NULL,
    working_dir TEXT NOT NULL DEFAULT '',
    env_json TEXT NOT NULL DEFAULT '{}',
    autostart INTEGER NOT NULL DEFAULT 0,
    restart_on_failure INTEGER NOT NULL DEFAULT 0,
    running_pid INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

const cols = db.prepare("PRAGMA table_info(services)").all().map((c) => c.name);
if (!cols.includes("running_pid")) {
  db.exec("ALTER TABLE services ADD COLUMN running_pid INTEGER");
}
if (!cols.includes("ssh_profile_id")) {
  db.exec("ALTER TABLE services ADD COLUMN ssh_profile_id TEXT");
}
if (!cols.includes("sort_order")) {
  db.exec("ALTER TABLE services ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0");
  const ids = db.prepare("SELECT id FROM services ORDER BY name ASC, id ASC").all();
  const setOrder = db.prepare("UPDATE services SET sort_order = ? WHERE id = ?");
  const assign = db.transaction((rows) => {
    rows.forEach((row, index) => setOrder.run(index, row.id));
  });
  assign(ids);
}
if (!cols.includes("target_key")) {
  db.exec("ALTER TABLE services ADD COLUMN target_key TEXT NOT NULL DEFAULT ''");
  db.exec("UPDATE services SET target_key = COALESCE(ssh_profile_id, '')");
}


if (!cols.includes("keep_running")) {
  db.exec("ALTER TABLE services ADD COLUMN keep_running INTEGER NOT NULL DEFAULT 0");
  db.exec(
    "UPDATE services SET keep_running = 1 WHERE autostart = 1 OR restart_on_failure = 1",
  );
  db.exec(
    "UPDATE services SET autostart = keep_running, restart_on_failure = keep_running",
  );
}

// 老库的 name 是全局 UNIQUE；改成"同一设备内唯一"需要重建表（此时列已补齐）
if (/name\s+TEXT\s+NOT NULL\s+UNIQUE/i.test(
  db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'services'").get()?.sql ?? "",
)) {
  db.exec(`
    BEGIN;
    CREATE TABLE services_migrating (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL,
      working_dir TEXT NOT NULL DEFAULT '',
      env_json TEXT NOT NULL DEFAULT '{}',
      autostart INTEGER NOT NULL DEFAULT 0,
      restart_on_failure INTEGER NOT NULL DEFAULT 0,
      running_pid INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ssh_profile_id TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      keep_running INTEGER NOT NULL DEFAULT 0,
      target_key TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO services_migrating
      (id, name, description, command, working_dir, env_json, autostart, restart_on_failure,
       running_pid, created_at, updated_at, ssh_profile_id, sort_order, keep_running, target_key)
    SELECT id, name, description, command, working_dir, env_json, autostart, restart_on_failure,
       running_pid, created_at, updated_at, ssh_profile_id, sort_order, keep_running,
       COALESCE(ssh_profile_id, '')
    FROM services;
    DROP TABLE services;
    ALTER TABLE services_migrating RENAME TO services;
    COMMIT;
  `);
}

db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_services_name_target ON services(name, target_key)",
);

function resolveKeepRunning(data) {
  if (data.keep_running != null) return !!data.keep_running;
  return !!(data.autostart || data.restart_on_failure);
}

function syncLegacyKeepFlags(kr) {
  return { keep_running: kr, autostart: kr, restart_on_failure: kr };
}

/** 服务唯一标识：同一设备内名字唯一，跨设备可同名 */
export function keyFromParts(name, target) {
  return `${target ?? ""}\u0000${name}`;
}

export function parseServiceKey(key) {
  const i = String(key).indexOf("\u0000");
  if (i < 0) return { target: "", name: String(key) };
  return { target: String(key).slice(0, i), name: String(key).slice(i + 1) };
}

export function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    command: row.command,
    working_dir: row.working_dir,
    env: JSON.parse(row.env_json || "{}"),
    keep_running:
      row.keep_running != null
        ? !!row.keep_running
        : !!(row.autostart || row.restart_on_failure),
    autostart: !!row.autostart,
    restart_on_failure: !!row.restart_on_failure,
    ssh_profile_id: row.ssh_profile_id ?? null,
    key: keyFromParts(row.name, row.ssh_profile_id ?? ""),
    running_pid: row.running_pid ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listServices() {
  return db
    .prepare("SELECT * FROM services ORDER BY sort_order ASC, id ASC")
    .all()
    .map(rowToRecord);
}

export function reorderServices(orderedKeys) {
  if (!Array.isArray(orderedKeys)) {
    return { ok: false, detail: "order 须为服务标识数组" };
  }
  const existing = db
    .prepare("SELECT name, target_key FROM services ORDER BY sort_order ASC, id ASC")
    .all();
  if (orderedKeys.length !== existing.length) {
    return { ok: false, detail: "排序列表与服务数量不一致" };
  }
  const expected = new Set(existing.map((r) => keyFromParts(r.name, r.target_key)));
  const seen = new Set();
  for (const key of orderedKeys) {
    if (typeof key !== "string" || !expected.has(key) || seen.has(key)) {
      return { ok: false, detail: "排序列表包含无效或重复的服务" };
    }
    seen.add(key);
  }
  const now = new Date().toISOString();
  const update = db.prepare(
    "UPDATE services SET sort_order = ?, updated_at = ? WHERE name = ? AND target_key = ?",
  );
  const apply = db.transaction((keys) => {
    keys.forEach((key, index) => {
      const { name, target } = parseServiceKey(key);
      update.run(index, now, name, target);
    });
  });
  apply(orderedKeys);
  return { ok: true };
}

export function getService(key) {
  const { target, name } = parseServiceKey(key);
  return rowToRecord(
    db
      .prepare("SELECT * FROM services WHERE name = ? AND target_key = ?")
      .get(name, target),
  );
}

/** 按（名字, 目标）查 */
export function getServiceByNameTarget(name, target = "") {
  return getService(keyFromParts(name, target));
}

export function setRunningPid(key, pid) {
  const row = getService(key);
  if (!row) return;
  if (row.running_pid === pid) return;
  const now = new Date().toISOString();
  db.prepare(
    "UPDATE services SET running_pid = ?, updated_at = ? WHERE name = ? AND target_key = ?",
  ).run(pid, now, row.name, row.ssh_profile_id ?? "");
}

export function createService(data) {
  const now = new Date().toISOString();
  const kr = resolveKeepRunning(data);
  const maxOrder =
    db.prepare("SELECT COALESCE(MAX(sort_order), -1) AS m FROM services").get()?.m ?? -1;
  const sortOrder = maxOrder + 1;
  const info = db
    .prepare(
      `INSERT INTO services (name, description, command, working_dir, env_json, autostart, restart_on_failure, keep_running, ssh_profile_id, target_key, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      data.name,
      data.description || "",
      data.command,
      data.working_dir || "",
      JSON.stringify(data.env || {}),
      kr ? 1 : 0,
      kr ? 1 : 0,
      kr ? 1 : 0,
      data.ssh_profile_id || null,
      data.ssh_profile_id || "",
      sortOrder,
      now,
      now,
    );
  return getServiceById(Number(info.lastInsertRowid));
}

function getServiceById(id) {
  return rowToRecord(db.prepare("SELECT * FROM services WHERE id = ?").get(id));
}

export function updateService(key, patch) {
  const row = getService(key);
  if (!row) return null;
  const clean = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  );
  const next = { ...row, ...clean };
  const flags = syncLegacyKeepFlags(resolveKeepRunning(next));
  Object.assign(next, flags);
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE services SET name = ?, description = ?, command = ?, working_dir = ?, env_json = ?,
     autostart = ?, restart_on_failure = ?, keep_running = ?, ssh_profile_id = ?, target_key = ?, updated_at = ? WHERE id = ?`,
  ).run(
    next.name,
    next.description,
    next.command,
    next.working_dir,
    JSON.stringify(next.env || {}),
    next.autostart ? 1 : 0,
    next.restart_on_failure ? 1 : 0,
    next.keep_running ? 1 : 0,
    next.ssh_profile_id || null,
    next.ssh_profile_id ?? "",
    now,
    row.id,
  );
  return getService(keyFromParts(next.name, next.ssh_profile_id ?? ""));
}

export function deleteService(key) {
  const row = getService(key);
  if (!row) return;
  db.prepare("DELETE FROM services WHERE id = ?").run(row.id);
}

export { db };
