import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 嵌入 browser-terminal：默认仓库根目录；独立运行时 SM_ROOT 指向 service-manager 项目根 */
const rootDir = process.env.SM_ROOT
  ? path.resolve(process.env.SM_ROOT)
  : path.resolve(__dirname, "../..");

export const settings = {
  host: process.env.SM_HOST || "0.0.0.0",
  port: Number(process.env.SM_PORT || 60008),
  adminUser: process.env.SM_ADMIN_USER || "admin",
  adminPassword: "",
  dataDir: path.join(rootDir, "data"),
  dbPath: "",
  staticDir: path.join(rootDir, "frontend", "dist"),
  rootDir,
  passwordJustGenerated: false,
};

settings.dbPath = path.join(settings.dataDir, "services.db");

function loadPassword() {
  if (process.env.SM_ADMIN_PASSWORD) {
    settings.adminPassword = process.env.SM_ADMIN_PASSWORD;
    return;
  }
  fs.mkdirSync(settings.dataDir, { recursive: true });
  const pwFile = path.join(settings.dataDir, "admin_password");
  if (fs.existsSync(pwFile)) {
    settings.adminPassword = fs.readFileSync(pwFile, "utf8").trim();
    return;
  }
  const generated = crypto.randomBytes(9).toString("base64url");
  fs.writeFileSync(pwFile, generated, { mode: 0o600 });
  settings.adminPassword = generated;
  settings.passwordJustGenerated = true;
}

loadPassword();
