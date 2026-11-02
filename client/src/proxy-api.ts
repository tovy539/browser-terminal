export interface ProxyEntry {
  id: string;
  name: string;
  slug: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  /** 上游基础路径（默认 /） */
  basePath?: string;
  /** 「打开」按钮附加的路径，例如 /admin */
  openPath?: string;
  createdAt?: string;
}

export interface ProxyInput {
  name: string;
  slug: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
  open_path?: string;
}

function parseError(body: unknown): string {
  if (body && typeof body === 'object') {
    const o = body as { error?: unknown; detail?: unknown };
    if (typeof o.error === 'string') return o.error;
    if (typeof o.detail === 'string') return o.detail;
  }
  return '请求失败';
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(parseError(body) || res.statusText);
  return body as T;
}

export const proxyApi = {
  list: () => request<ProxyEntry[]>('/api/proxies'),
  create: (body: ProxyInput) =>
    request<ProxyEntry>('/api/proxies', { method: 'POST', body: JSON.stringify(body) }),
  update: (id: string, body: Partial<ProxyInput>) =>
    request<ProxyEntry>(`/api/proxies/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  reorder: (order: string[]) =>
    request<ProxyEntry[]>('/api/proxies/order', { method: 'PUT', body: JSON.stringify({ order }) }),
  remove: (id: string) =>
    request<{ ok: boolean }>(`/api/proxies/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
