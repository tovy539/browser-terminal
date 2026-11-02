import crypto from "crypto";
import { settings } from "./config.js";

export function requireAdmin(req, res, next) {
  if (!settings.adminPassword) {
    return res.status(503).json({ detail: "未配置管理密码，请设置 SM_ADMIN_PASSWORD" });
  }
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="Service Manager"');
    return res.status(401).json({ detail: "需要登录" });
  }
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  } catch {
    res.set("WWW-Authenticate", 'Basic realm="Service Manager"');
    return res.status(401).json({ detail: "需要登录" });
  }
  const i = decoded.indexOf(":");
  const user = i >= 0 ? decoded.slice(0, i) : decoded;
  const pass = i >= 0 ? decoded.slice(i + 1) : "";
  const userOk = timingSafeEqual(user, settings.adminUser);
  const passOk = timingSafeEqual(pass, settings.adminPassword);
  if (!userOk || !passOk) {
    res.set("WWW-Authenticate", 'Basic realm="Service Manager"');
    return res.status(401).json({ detail: "用户名或密码错误" });
  }
  req.adminUser = user;
  next();
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
