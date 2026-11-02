export type SshAuthType = 'password' | 'publicKey' | 'systemKey';

export interface SshProfilePublic {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  hasStoredCredential: boolean;
}

export async function fetchSshProfiles(): Promise<SshProfilePublic[]> {
  const res = await fetch('/api/ssh/profiles', { credentials: 'include' });
  if (!res.ok) return [];
  const data = (await res.json()) as { profiles?: SshProfilePublic[] };
  return (data.profiles ?? []).map((p) => ({
    ...p,
    hasStoredCredential: !!p.hasStoredCredential,
  }));
}

export async function saveSshProfile(input: {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  password?: string;
  privateKey?: string;
}): Promise<SshProfilePublic> {
  const res = await fetch('/api/ssh/profiles', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || '保存失败');
  }
  const data = (await res.json()) as { profile: SshProfilePublic };
  return data.profile;
}

export async function deleteSshProfile(id: string): Promise<void> {
  const res = await fetch(`/api/ssh/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'include',
  });
  if (!res.ok) throw new Error('删除失败');
}
