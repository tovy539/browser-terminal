export async function fetchAuthConfig(): Promise<{ required: boolean }> {
  const res = await fetch('/api/auth/config', { credentials: 'include' });
  if (!res.ok) return { required: false };
  return (await res.json()) as { required: boolean };
}

/** 依赖 HttpOnly Cookie（登录后由服务端写入） */
export async function checkStoredAuth(): Promise<boolean> {
  const res = await fetch('/api/auth/check', { credentials: 'include' });
  return res.ok;
}

export async function loginWithPassword(password: string): Promise<void> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || '密码错误');
  }
}

/** 清除服务端 HttpOnly 登录 Cookie，并回到登录页 */
export async function logoutSession(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' });
  const u = new URL(location.href);
  u.searchParams.delete('token');
  location.replace(u.pathname + u.search + u.hash);
}
