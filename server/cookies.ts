export const AUTH_COOKIE = 'bt_auth';

const MAX_AGE_SEC =
  Number(process.env.AUTH_COOKIE_MAX_AGE_DAYS || 30) * 24 * 3600;

export function readAuthCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq);
    if (name !== AUTH_COOKIE) continue;
    return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

export function resolveAuthToken(
  cookieHeader: string | undefined,
  authorization: string | undefined,
): string | null {
  const fromCookie = readAuthCookie(cookieHeader);
  if (fromCookie) return fromCookie;
  return extractBearer(authorization);
}

function extractBearer(authorization: string | undefined): string | null {
  if (!authorization?.startsWith('Bearer ')) return null;
  return authorization.slice(7).trim() || null;
}

export function authCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE_SEC}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearAuthCookieHeader(secure: boolean): string {
  const parts = [
    `${AUTH_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
