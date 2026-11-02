export type ServiceState = 'running' | 'stopped' | 'failed' | 'starting';

export interface ServiceStatus {
  state: ServiceState;
  pid: number | null;
  uptime_seconds: number | null;
  exit_code: number | null;
  last_error: string | null;
  started_at: string | null;
}

export interface Service {
  id: number;
  name: string;
  description: string;
  command: string;
  working_dir: string;
  env: Record<string, string>;
  keep_running: boolean;
  /** @deprecated 与 keep_running 同步，仅兼容旧 API */
  autostart?: boolean;
  restart_on_failure?: boolean;
  /** null 表示本机；否则为设置中的 SSH 配置 id */
  ssh_profile_id: string | null;
  /** 服务唯一标识（目标设备 + 名字） */
  key?: string;
  created_at: string;
  updated_at: string;
  status: ServiceStatus;
}

export type ServiceInput = Omit<
  Service,
  'id' | 'created_at' | 'updated_at' | 'status'
>;

export type ServicePatch = Partial<ServiceInput> & { name?: string };

function parseDetail(body: unknown): string {
  if (body && typeof body === 'object' && 'detail' in body) {
    const d = (body as { detail: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  if (body && typeof body === 'object' && 'error' in body) {
    const e = (body as { error: unknown }).error;
    if (typeof e === 'string') return e;
  }
  return '请求失败';
}

/** 目标设备 → 查询参数（本机为空） */
function targetQuery(target?: string | null): string {
  const t = target ?? '';
  return t && t !== 'local' ? `?target=${encodeURIComponent(t)}` : '';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(parseDetail(body) || res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface ServiceLogs {
  content: string;
  lines: number;
  truncated: boolean;
}

export const smApi = {
  health: () => request<{ ok: boolean }>('/api/sm/health'),
  list: () => request<Service[]>('/api/sm/services'),
  reorder: (order: string[]) =>
    request<{ ok: boolean }>('/api/sm/services/order', {
      method: 'PUT',
      body: JSON.stringify({ order }),
    }),
  logs: (name: string, target: string | null | undefined, lines = 500) =>
    request<ServiceLogs>(
      `/api/sm/services/${encodeURIComponent(name)}/logs?lines=${lines}&target=${encodeURIComponent(target ?? '')}`,
    ),
  create: (body: ServiceInput) =>
    request<Service>('/api/sm/services', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  update: (name: string, target: string | null | undefined, body: ServicePatch) =>
    request<Service>(`/api/sm/services/${encodeURIComponent(name)}${targetQuery(target)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  remove: (name: string, target: string | null | undefined) =>
    request<{ ok: boolean }>(
      `/api/sm/services/${encodeURIComponent(name)}${targetQuery(target)}`,
      { method: 'DELETE' },
    ),
  start: (name: string, target: string | null | undefined) =>
    request<{ ok: boolean; message: string }>(
      `/api/sm/services/${encodeURIComponent(name)}/start${targetQuery(target)}`,
      { method: 'POST' },
    ),
  stop: (name: string, target: string | null | undefined) =>
    request<{ ok: boolean; message: string }>(
      `/api/sm/services/${encodeURIComponent(name)}/stop${targetQuery(target)}`,
      { method: 'POST' },
    ),
  restart: (name: string, target: string | null | undefined) =>
    request<{ ok: boolean; message: string }>(
      `/api/sm/services/${encodeURIComponent(name)}/restart${targetQuery(target)}`,
      { method: 'POST' },
    ),
};
