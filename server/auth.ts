import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadAccessPassword(): string {
  const fromEnv = process.env.ACCESS_PASSWORD?.trim();
  if (fromEnv) return fromEnv;

  const filePath =
    process.env.ACCESS_PASSWORD_FILE ||
    path.join(__dirname, '../.access_password');
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf8').trim();
  }
  return '';
}

export function isAuthRequired(): boolean {
  return loadAccessPassword().length > 0;
}

function signPayload(payloadB64: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
}

export function issueToken(): string | null {
  const secret = loadAccessPassword();
  if (!secret) return null;
  const payloadB64 = Buffer.from(
    JSON.stringify({ iat: Math.floor(Date.now() / 1000) }),
  ).toString('base64url');
  return `${payloadB64}.${signPayload(payloadB64, secret)}`;
}

export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const secret = loadAccessPassword();
  if (!secret) return true;

  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signPayload(payloadB64, secret);

  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function verifyPassword(input: string): boolean {
  const secret = loadAccessPassword();
  if (!secret) return true;
  try {
    const a = Buffer.from(input);
    const b = Buffer.from(secret);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}
