import type { Express, Request, Response, NextFunction } from 'express';
import {
  deleteSshProfile,
  listSshProfiles,
  upsertSshProfile,
  type SshAuthType,
} from './ssh-profiles.js';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isAuthRequired()) {
    next();
    return;
  }
  const token = resolveAuthToken(req.headers.cookie, req.headers.authorization);
  if (verifyToken(token)) {
    next();
    return;
  }
  res.status(401).json({ error: '未授权' });
}

export function registerSshRoutes(app: Express): void {
  app.get('/api/ssh/profiles', requireAuth, (_req, res) => {
    res.json({ profiles: listSshProfiles() });
  });

  app.post('/api/ssh/profiles', requireAuth, (req, res) => {
    const body = req.body as Record<string, unknown>;
    const authType = body.authType as SshAuthType;
    if (
      authType !== 'password' &&
      authType !== 'publicKey' &&
      authType !== 'systemKey'
    ) {
      res.status(400).json({ error: 'authType 无效' });
      return;
    }
    const profile = upsertSshProfile({
      id: typeof body.id === 'string' ? body.id : undefined,
      name: String(body.name ?? ''),
      host: String(body.host ?? ''),
      port: Number(body.port) || 22,
      username: String(body.username ?? ''),
      authType,
      password: typeof body.password === 'string' ? body.password : undefined,
      privateKey: typeof body.privateKey === 'string' ? body.privateKey : undefined,
    });
    res.json({ profile });
  });

  app.delete('/api/ssh/profiles/:id', requireAuth, (req, res) => {
    const ok = deleteSshProfile(req.params.id);
    if (!ok) {
      res.status(404).json({ error: '未找到' });
      return;
    }
    res.json({ ok: true });
  });
}
