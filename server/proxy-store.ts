import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const STORE_FILE = path.join(REPO_ROOT, '.run', 'proxies.json');

/** 反代条目：把 /svc/<slug>/... 转发到 <scheme>://<host>:<port>/... */
export interface ProxyEntry {
  id: string;
  /** 展示名称，例如「股票关注」 */
  name: string;
  /** 路径名，例如 stock → /svc/stock/ */
  slug: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  /** 上游基础路径（默认 /），例如 token-meter 的后台在 /admin */
  basePath: string;
  /** 「打开」按钮附加的路径，例如 /admin（空 = 直接打开挂载点） */
  openPath: string;
  createdAt: string;
}

/** 会被终端应用自身路由占用的路径段，不能作为 slug */
const RESERVED_SLUGS = new Set([
  'api',
  'ws',
  'code',
  'video',
  'svc',
  'assets',
  'healthz',
  'login',
  'logout',
  'settings',
  'favicon.ico',
  'manifest.json',
  'index.html',
]);

let entries: ProxyEntry[] | null = null;

function load(): ProxyEntry[] {
  if (entries) return entries;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) as { proxies?: ProxyEntry[] };
    entries = Array.isArray(raw.proxies) ? raw.proxies : [];
  } catch {
    entries = [];
  }
  return entries;
}

function persist(): void {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ proxies: load() }, null, 2), 'utf8');
  fs.renameSync(tmp, STORE_FILE);
}

export function slugError(slug: string): string | null {
  if (!slug) return '路径名不能为空';
  // 只允许单段路径；需要更深路径时用「打开路径」字段
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug)) {
    return '路径名只能用小写字母/数字/短横线，且以字母或数字开头（最长 63 字符，不能含 /）';
  }
  if (RESERVED_SLUGS.has(slug)) {
    return `路径名「${slug}」是系统保留字，请换一个`;
  }
  return null;
}

/** 找出与请求路径最匹配的反代（支持多级路径，最长前缀优先） */
export function findProxyForPath(relPath: string): ProxyEntry | undefined {
  const rel = relPath.replace(/^\/+/, '');
  let best: ProxyEntry | undefined;
  for (const entry of load()) {
    if (rel === entry.slug || rel.startsWith(`${entry.slug}/`)) {
      if (!best || entry.slug.length > best.slug.length) best = entry;
    }
  }
  return best;
}

/** 归一化上游基础路径：'' / '/' → '/'；其它去掉尾部斜杠并要求以 / 开头 */
export function normalizeBasePath(raw: unknown): string {
  let value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value === '/') return '/';
  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/+$/, '');
  return value || '/';
}

export function basePathError(basePath: string): string | null {
  if (basePath === '/') return null;
  if (!basePath.startsWith('/')) return '上游路径必须以 / 开头';
  if (basePath.includes('..') || basePath.includes('?') || basePath.includes('#')) {
    return '上游路径不能包含 .. ? #';
  }
  return null;
}

/** 归一化「打开路径」：'' 或 /admin 这种；去掉尾部斜杠 */
export function normalizeOpenPath(raw: unknown): string {
  let value = typeof raw === 'string' ? raw.trim() : '';
  if (!value || value === '/') return '';
  if (!value.startsWith('/')) value = `/${value}`;
  return value.replace(/\/+$/, '');
}

export function openPathError(openPath: string): string | null {
  if (!openPath) return null;
  if (openPath.includes('..') || openPath.includes('?') || openPath.includes('#')) {
    return '打开路径不能包含 .. ? #';
  }
  return null;
}

export function targetError(host: string, port: number): string | null {
  if (!host) return '目标 IP / 主机名不能为空';
  if (/[\s/@?#]/.test(host)) return '目标 IP / 主机名不能包含空格、/、@、?、#';
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '端口必须是 1–65535';
  return null;
}

export function listProxies(): ProxyEntry[] {
  // 保持文件里的顺序（新增追加到末尾，拖动排序直接改这个顺序）
  return [...load()];
}

/** 按 id 顺序重排；只提交当前列表里存在的 id 即可 */
export function reorderProxies(ids: string[]): ProxyEntry[] {
  const all = load();
  const byId = new Map(all.map((p) => [p.id, p]));
  const ordered: ProxyEntry[] = [];
  for (const id of ids) {
    const entry = byId.get(id);
    if (entry) {
      ordered.push(entry);
      byId.delete(id);
    }
  }
  // 没提交的（新增/并发）保持原顺序放到末尾
  for (const entry of all) {
    if (byId.has(entry.id)) ordered.push(entry);
  }
  entries = ordered;
  persist();
  return ordered;
}

export function getProxyBySlug(slug: string): ProxyEntry | undefined {
  return load().find((p) => p.slug === slug);
}

export function getProxy(id: string): ProxyEntry | undefined {
  return load().find((p) => p.id === id);
}

export function createProxy(input: {
  name: string;
  slug: string;
  host: string;
  port: number;
  scheme?: 'http' | 'https';
  basePath?: unknown;
  openPath?: unknown;
}): ProxyEntry {
  const entry: ProxyEntry = {
    id: `p-${crypto.randomBytes(6).toString('hex')}`,
    name: input.name.trim() || input.slug,
    slug: input.slug,
    host: input.host.trim(),
    port: input.port,
    scheme: input.scheme === 'https' ? 'https' : 'http',
    basePath: normalizeBasePath(input.basePath),
    openPath: normalizeOpenPath(input.openPath),
    createdAt: new Date().toISOString(),
  };
  load().push(entry);
  persist();
  return entry;
}

export function updateProxy(
  id: string,
  patch: Partial<Pick<ProxyEntry, 'name' | 'slug' | 'host' | 'port' | 'scheme'>> & {
    basePath?: unknown;
    openPath?: unknown;
  },
): ProxyEntry | null {
  const all = load();
  const entry = all.find((p) => p.id === id);
  if (!entry) return null;
  if (patch.name != null) entry.name = patch.name.trim() || entry.slug;
  if (patch.slug != null) entry.slug = patch.slug;
  if (patch.host != null) entry.host = patch.host.trim();
  if (patch.port != null) entry.port = patch.port;
  if (patch.scheme != null) entry.scheme = patch.scheme === 'https' ? 'https' : 'http';
  if (patch.basePath !== undefined) entry.basePath = normalizeBasePath(patch.basePath);
  if (patch.openPath !== undefined) entry.openPath = normalizeOpenPath(patch.openPath);
  persist();
  return entry;
}

export function deleteProxy(id: string): boolean {
  const all = load();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) return false;
  all.splice(idx, 1);
  persist();
  return true;
}
