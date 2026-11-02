import path from 'path';
import type { Server } from 'http';
import type { Express, NextFunction, Request, Response } from 'express';
import httpProxy from 'http-proxy';
import { isAuthRequired, verifyToken } from './auth.js';
import { resolveAuthToken } from './cookies.js';
import {
  createProxy,
  deleteProxy,
  basePathError,
  findProxyForPath,
  getProxy,
  getProxyBySlug,
  listProxies,
  normalizeBasePath,
  reorderProxies,
  normalizeOpenPath,
  openPathError,
  slugError,
  targetError,
  updateProxy,
  type ProxyEntry,
} from './proxy-store.js';

/** 浏览器抓取时不带 cookie 的公开元数据，不要求登录 */
const PUBLIC_METADATA = /^\/(?:manifest\.webmanifest|favicon\.(?:ico|svg|png)|apple-touch-icon[\w.-]*\.png|robots\.txt)$/i;

/** 反代时要去掉的"客户端来源"头：让上游看到的是本机/服务器的地址 */
const FORWARD_HEADERS = [
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'forwarded',
  'via',
  'true-client-ip',
  'cf-connecting-ip',
  'x-client-ip',
  'x-cluster-client-ip',
  'x-originating-ip',
];

const proxy = httpProxy.createProxyServer({
  ws: true,
  changeOrigin: true,
  secure: false,
  xfwd: false,
});

function authorized(req: Request): boolean {
  if (!isAuthRequired()) return true;
  const token = resolveAuthToken(req.headers.cookie, req.headers.authorization);
  return verifyToken(token);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authorized(req)) {
    res.status(401).json({ error: '未授权' });
    return;
  }
  next();
}

function targetOf(entry: ProxyEntry): string {
  return `${entry.scheme}://${entry.host}:${entry.port}`;
}

export function registerProxyRoutes(app: Express, server: Server): void {
  // ---------- 管理接口 ----------
  app.get('/api/proxies', requireAuth, (_req: Request, res: Response) => {
    res.json(listProxies());
  });

  app.post('/api/proxies', requireAuth, (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const slug = typeof body.slug === 'string' ? body.slug.trim().toLowerCase() : '';
    const host = typeof body.host === 'string' ? body.host.trim() : '';
    const scheme = body.scheme === 'https' ? 'https' : 'http';
    // 端口留空（0/NaN）→ 按协议取默认：http 80 / https 443
    const port = Number(body.port) || (scheme === 'https' ? 443 : 80);
    const slugErr = slugError(slug);
    if (slugErr) {
      res.status(422).json({ error: slugErr });
      return;
    }
    if (getProxyBySlug(slug)) {
      res.status(409).json({ error: `路径名「${slug}」已被占用` });
      return;
    }
    const basePath = normalizeBasePath(body.base_path);
    const bErr = basePathError(basePath);
    if (bErr) {
      res.status(422).json({ error: bErr });
      return;
    }
    const openPath = normalizeOpenPath(body.open_path);
    const oErr = openPathError(openPath);
    if (oErr) {
      res.status(422).json({ error: oErr });
      return;
    }
    const tErr = targetError(host, port);
    if (tErr) {
      res.status(422).json({ error: tErr });
      return;
    }
    res.status(201).json(
      createProxy({ name, slug, host, port, scheme, basePath, openPath }),
    );
  });

  app.patch('/api/proxies/:id', requireAuth, (req: Request, res: Response) => {
    const entry = getProxy(req.params.id);
    if (!entry) {
      res.status(404).json({ error: '反代不存在' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<ProxyEntry> = {};
    if (typeof body.name === 'string') patch.name = body.name;
    if (typeof body.slug === 'string') patch.slug = body.slug.trim().toLowerCase();
    if (typeof body.host === 'string') patch.host = body.host;
    if (body.port != null) {
      const schemeForPort =
        body.scheme === 'http' || body.scheme === 'https'
          ? body.scheme
          : (patch.scheme ?? entry.scheme);
      patch.port = Number(body.port) || (schemeForPort === 'https' ? 443 : 80);
    }
    if (body.scheme === 'http' || body.scheme === 'https') patch.scheme = body.scheme;
    if (body.base_path !== undefined) {
      const bp = normalizeBasePath(body.base_path);
      const bErr = basePathError(bp);
      if (bErr) {
        res.status(422).json({ error: bErr });
        return;
      }
      patch.basePath = bp;
    }
    if (body.open_path !== undefined) {
      const op = normalizeOpenPath(body.open_path);
      const oErr = openPathError(op);
      if (oErr) {
        res.status(422).json({ error: oErr });
        return;
      }
      patch.openPath = op;
    }
    if (patch.slug != null) {
      const slugErr = slugError(patch.slug);
      if (slugErr) {
        res.status(422).json({ error: slugErr });
        return;
      }
      const dup = getProxyBySlug(patch.slug);
      if (dup && dup.id !== entry.id) {
        res.status(409).json({ error: `路径名「${patch.slug}」已被占用` });
        return;
      }
    }
    const tErr = targetError(
      patch.host ?? entry.host,
      patch.port ?? entry.port,
    );
    if (tErr) {
      res.status(422).json({ error: tErr });
      return;
    }
    const next = updateProxy(entry.id, patch);
    res.json(next ?? entry);
  });

  app.put('/api/proxies/order', requireAuth, (req: Request, res: Response) => {
    const order = (req.body as { order?: unknown })?.order;
    if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) {
      res.status(422).json({ error: '排序格式无效' });
      return;
    }
    res.json(reorderProxies(order as string[]));
  });

  app.delete('/api/proxies/:id', requireAuth, (req: Request, res: Response) => {
    if (!deleteProxy(req.params.id)) {
      res.status(404).json({ error: '反代不存在' });
      return;
    }
    res.json({ ok: true });
  });

  // ---------- 反代本体 ----------
  app.use('/svc', (req: Request, res: Response) => {
    const rawUrl = req.url ?? '/';
    const qIndex = rawUrl.indexOf('?');
    const query = qIndex >= 0 ? rawUrl.slice(qIndex) : '';
    const relRaw = (qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl).replace(/^\/+/, '');
    const entry = findProxyForPath(relRaw);
    const slug = entry?.slug ?? '';
    if (!entry) {
      res.status(404).type('text/html').send(errorPage('反代不存在', `没有配置路径名「${slug}」的反代。`));
      return;
    }
    // 先算出转发路径再鉴权：下面这些是浏览器抓取时**不带 cookie** 的静态元数据，
    // 一并要求登录会让页面报 401（例如 dsh 的 manifest.webmanifest）
    const basePath = entry.basePath ?? '/';
    // 只有"挂在应用根"时才补尾斜杠（相对资源路径依赖它）；
    // 配了上游基础路径（例如 /admin）时保持原样，否则相对 API 路径会错位
    if (basePath === '/' && relRaw === slug) {
      const qs = req.originalUrl.includes('?')
        ? req.originalUrl.slice(req.originalUrl.indexOf('?'))
        : '';
      const lastSegment = slug.split('/').pop() ?? slug;
      res.redirect(302, `${lastSegment}/${qs}`);
      return;
    }
    // 剥掉 /svc/<slug> 前缀，拼上上游基础路径
    const rest = relRaw.slice(slug.length).replace(/^\/+/, '');
    if (!authorized(req) && !PUBLIC_METADATA.test(`/${rest}`)) {
      res
        .status(401)
        .type('text/html')
        .send(errorPage('需要先登录', '请先登录 browser-terminal，再访问这个反代地址。', true));
      return;
    }
    (req as Request & { proxySlug?: string }).proxySlug = slug;
    req.url = `${upstreamPath(basePath, rest)}${query}`;
    proxy.web(req, res, { target: targetOf(entry) }, (err) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res
        .status(502)
        .type('text/html')
        .send(
          errorPage(
            '反代目标不可达',
            `无法连接 ${entry.host}:${entry.port}（${err.message}）。请确认该服务正在运行、端口填写正确。`,
          ),
        );
    });
  });

  // 把 Origin 对齐到上游：不少应用（如 dsh web）会校验 Origin 与 Host 同源，
  // 经过反代后浏览器发来的 Origin 是外部域名，会被判 403
  const alignOrigin = (
    proxyReq: import('http').ClientRequest,
    req: import('http').IncomingMessage,
  ): void => {
    const slug = (req as unknown as Request & { proxySlug?: string }).proxySlug;
    const entry = slug ? getProxyBySlug(slug) : undefined;
    if (!entry) return;
    const origin = `${entry.scheme}://${entry.host}:${entry.port}`;
    if (proxyReq.getHeader('origin')) proxyReq.setHeader('origin', origin);
    // 去掉 nginx 带进来的客户端身份头：否则上游（如 ip.cn）会显示浏览器 IP 而不是本机 IP
    for (const name of FORWARD_HEADERS) proxyReq.removeHeader(name);
    // Referer 同样对齐：外部地址里带着应用前缀（/myterminal/…），有些应用会据此推断 base path
    const referer = proxyReq.getHeader('referer');
    if (typeof referer === 'string' && referer) {
      try {
        const ref = new URL(referer);
        if (ref.host !== `${entry.host}:${entry.port}`) {
          proxyReq.setHeader('referer', `${origin}/`);
        }
      } catch {
        proxyReq.removeHeader('referer');
      }
    }
  };
  proxy.on('proxyReq', alignOrigin);
  proxy.on('proxyReqWs', alignOrigin);

  proxy.on('proxyRes', (proxyRes, req) => {
    const slug = (req as Request & { proxySlug?: string }).proxySlug;
    if (!slug) return;
    const location = proxyRes.headers.location;
    if (typeof location === 'string') {
      proxyRes.headers.location = rewriteLocation(location, slug, req);
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    if (!url.startsWith('/svc/')) return;
    if (!authorized(req as unknown as Request)) {
      socket.destroy();
      return;
    }
    const relRaw = url.slice('/svc/'.length);
    const entry = findProxyForPath(relRaw);
    if (!entry) {
      socket.destroy();
      return;
    }
    const slug = entry.slug;
    const basePath = entry.basePath ?? '/';
    (req as unknown as Request & { proxySlug?: string }).proxySlug = slug;
    const rest = relRaw.slice(slug.length).replace(/^\/+/, '');
    req.url = upstreamPath(basePath, rest);
    proxy.ws(req, socket, head, { target: targetOf(entry) }, () => socket.destroy());
  });
}

/**
 * 把上游的绝对 Location 改写成**相对**地址：
 * 这样无论应用被挂在 /myterminal/ 还是根路径，浏览器都会把前缀带上。
 */
function rewriteLocation(
  location: string,
  slug: string,
  req: { headers: { host?: string }; originalUrl?: string; url?: string },
): string {
  let loc = location;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(loc)) {
    try {
      const parsed = new URL(loc);
      const current = new URL(`http://${req.headers.host ?? 'localhost'}`);
      const entry = getProxyBySlug(slug);
      const upstreamHost = entry ? `${entry.host}:${entry.port}` : '';
      if (parsed.host !== upstreamHost && parsed.host !== current.host) {
        return location; // 指向外部站点，原样保留
      }
      loc = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return location;
    }
  }
  if (!loc.startsWith('/')) return loc; // 已经是相对地址
  // 上游可能把自己的基础路径写进 Location（/admin/login 之类）：先去掉再挂到 slug 下
  const basePath = getProxyBySlug(slug)?.basePath ?? '/';
  let upstreamLoc = loc;
  if (
    basePath !== '/' &&
    (upstreamLoc === basePath || upstreamLoc.startsWith(`${basePath}/`))
  ) {
    upstreamLoc = upstreamLoc.slice(basePath.length) || '/';
  }
  const rawPath = req.originalUrl ?? req.url ?? '/';
  const reqPath = rawPath.split('?')[0];
  const target = `/svc/${slug}${upstreamLoc}`;
  const rel = path.posix.relative(path.posix.dirname(reqPath), target);
  return rel || './';
}

/** 上游实际路径：basePath 为 / 时就是 rest，否则 basePath + /rest */
function upstreamPath(basePath: string, rest: string): string {
  if (!basePath || basePath === '/') return `/${rest}`;
  return rest ? `${basePath}/${rest}` : basePath;
}

function errorPage(title: string, detail: string, showLoginLink = false): string {
  const escaped = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const login = showLoginLink
    ? '<a class="btn" href="../../">去登录</a>'
    : '<a class="btn" href="javascript:location.reload()">重试</a>';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escaped(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #1e1e1e;
    color: #ccc; font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .box { max-width: 560px; padding: 28px 32px; border: 1px solid #3d3d3d; border-radius: 12px; background: #252526; }
  h1 { margin: 0 0 10px; font-size: 16px; color: #eee; }
  p { margin: 0 0 18px; color: #aaa; word-break: break-all; }
  .btn { display: inline-block; padding: 7px 14px; border-radius: 8px; background: #0e639c; color: #fff; text-decoration: none; }
</style></head>
<body><div class="box"><h1>${escaped(title)}</h1><p>${escaped(detail)}</p>${login}</div></body></html>`;
}
