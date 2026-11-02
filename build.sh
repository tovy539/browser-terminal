#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

if [[ ! -d "${ROOT}/node_modules" ]]; then
  echo "Installing dependencies..."
  # 显式带上 dev：NODE_ENV=production 时 npm 会跳过 vite/tsx 等构建依赖
  npm install --include=dev
fi

echo "Building frontend..."
npm run build

echo "Build OK: ${ROOT}/dist/client"
