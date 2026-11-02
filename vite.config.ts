import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const certDir = path.join(rootDir, 'certs');
const keyPath = path.join(certDir, 'server.key');
const certPath = path.join(certDir, 'server.crt');

const httpsEnabled =
  process.env.HTTPS !== '0' &&
  fs.existsSync(keyPath) &&
  fs.existsSync(certPath);

const tls = httpsEnabled
  ? {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
    }
  : undefined;

const backendTarget = httpsEnabled
  ? `https://localhost:${process.env.PORT || 3000}`
  : `http://localhost:${process.env.PORT || 3000}`;

export default defineConfig({
  root: 'client',
  server: {
    host: '0.0.0.0',
    port: Number(process.env.VITE_PORT) || 5173,
    https: tls,
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: backendTarget,
        ws: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.join(rootDir, 'client/index.html'),
        browser: path.join(rootDir, 'client/browser.html'),
      },
    },
  },
});
