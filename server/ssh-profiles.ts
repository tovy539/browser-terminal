import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type SshAuthType = 'password' | 'publicKey' | 'systemKey';

const SYSTEM_KEY_CANDIDATES = ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_dsa'] as const;

/** 网关用户 ~/.ssh 下是否存在常用默认私钥（连接时交给 OpenSSH 默认策略） */
export function hasSystemSshKeys(): boolean {
  const dir = path.join(os.homedir(), '.ssh');
  for (const name of SYSTEM_KEY_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

export interface SshProfilePublic {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  /** 是否已在服务端保存密码或私钥 */
  hasStoredCredential: boolean;
}

interface SshProfileSecret {
  password?: string;
  privateKey?: string;
}

type StoredProfile = Omit<SshProfilePublic, 'hasStoredCredential'>;

interface StoreFile {
  profiles: StoredProfile[];
  secrets: Record<string, SshProfileSecret>;
}

const storePath =
  process.env.SSH_PROFILES_FILE ||
  path.join(__dirname, '../.run/ssh-profiles.json');

function loadStore(): StoreFile {
  try {
    if (!fs.existsSync(storePath)) {
      return { profiles: [], secrets: {} };
    }
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as StoreFile;
    return {
      profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
      secrets: raw.secrets && typeof raw.secrets === 'object' ? raw.secrets : {},
    };
  } catch {
    return { profiles: [], secrets: {} };
  }
}

function saveStore(store: StoreFile): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(storePath, 0o600);
  } catch {
    /* ignore */
  }
}

function genId(): string {
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

/** OpenSSH 私钥 PEM 必须以换行结尾，否则 ssh 报 error in libcrypto */
export function normalizePrivateKeyPem(key: string): string {
  const trimmed = key.replace(/\r\n/g, '\n').trim();
  if (!trimmed) return trimmed;
  return trimmed.endsWith('\n') ? trimmed : `${trimmed}\n`;
}

function withCredentialFlag(
  pub: Omit<SshProfilePublic, 'hasStoredCredential'>,
  secret: SshProfileSecret | undefined,
): SshProfilePublic {
  let hasStoredCredential = false;
  if (pub.authType === 'password') {
    hasStoredCredential = !!secret?.password;
  } else if (pub.authType === 'systemKey') {
    hasStoredCredential = hasSystemSshKeys();
  } else {
    hasStoredCredential = !!secret?.privateKey;
  }
  return { ...pub, hasStoredCredential };
}

export function listSshProfiles(): SshProfilePublic[] {
  const store = loadStore();
  return store.profiles.map((p) =>
    withCredentialFlag(p, store.secrets[p.id]),
  );
}

export function getSshProfile(id: string): SshProfilePublic | null {
  const store = loadStore();
  const pub = store.profiles.find((p) => p.id === id);
  if (!pub) return null;
  return withCredentialFlag(pub, store.secrets[id]);
}

export function getSshSecret(id: string): SshProfileSecret | null {
  const store = loadStore();
  return store.secrets[id] ?? null;
}

export interface UpsertSshInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authType: SshAuthType;
  password?: string;
  privateKey?: string;
}

export function upsertSshProfile(input: UpsertSshInput): SshProfilePublic {
  const store = loadStore();
  const id = input.id && store.profiles.some((p) => p.id === input.id) ? input.id : genId();

  const pubBase = {
    id,
    name: input.name.trim() || `${input.username}@${input.host}`,
    host: input.host.trim(),
    port: input.port > 0 ? input.port : 22,
    username: input.username.trim(),
    authType: input.authType,
  };

  const idx = store.profiles.findIndex((p) => p.id === id);
  if (idx >= 0) store.profiles[idx] = pubBase;
  else store.profiles.push(pubBase);

  const prev = store.secrets[id] ?? {};
  const secret: SshProfileSecret = { ...prev };
  if (input.authType === 'password') {
    if (input.password) secret.password = input.password;
    delete secret.privateKey;
  } else if (input.authType === 'systemKey') {
    delete secret.password;
    delete secret.privateKey;
  } else {
    if (input.privateKey) {
      secret.privateKey = normalizePrivateKeyPem(input.privateKey);
    }
    delete secret.password;
  }
  store.secrets[id] = secret;

  saveStore(store);
  return withCredentialFlag(pubBase, secret);
}

export function deleteSshProfile(id: string): boolean {
  const store = loadStore();
  const before = store.profiles.length;
  store.profiles = store.profiles.filter((p) => p.id !== id);
  delete store.secrets[id];
  if (store.profiles.length === before) return false;
  saveStore(store);
  return true;
}
