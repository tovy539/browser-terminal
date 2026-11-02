import type { Express, NextFunction, Request, Response } from 'express';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';
import { fetchHostMetrics, parsePaneConnection } from './host-metrics.js';

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

export function registerHostMetricsRoutes(app: Express): void {
  app.post('/api/host/metrics', requireAuth, async (req, res) => {
    try {
      const connection = parsePaneConnection(req.body);
      const metrics = await fetchHostMetrics(connection);
      res.json({ metrics });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '采集失败';
      res.status(502).json({ error: msg });
    }
  });
}
