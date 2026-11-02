#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/lib.sh
source "${ROOT}/scripts/lib.sh"

RUN_DIR="${ROOT}/.run"
PID_FILE="${RUN_DIR}/server.pid"
LOG_FILE="${RUN_DIR}/server.log"
DEV_PID_FILE="${RUN_DIR}/dev.pid"
DEV_LOG_FILE="${RUN_DIR}/dev.log"

HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"
VITE_PORT="${VITE_PORT:-5173}"
HTTPS="${HTTPS:-1}"
TLS_KEY="${TLS_KEY:-${ROOT}/certs/server.key}"
TLS_CERT="${TLS_CERT:-${ROOT}/certs/server.crt}"
ACCESS_PASSWORD_FILE="${ACCESS_PASSWORD_FILE:-${ROOT}/.access_password}"

ensure_access_password() {
  if [[ -n "${ACCESS_PASSWORD:-}" ]]; then
    export ACCESS_PASSWORD
    return
  fi
  if [[ -f "${ACCESS_PASSWORD_FILE}" ]]; then
    ACCESS_PASSWORD="$(tr -d '\n\r' < "${ACCESS_PASSWORD_FILE}")"
    export ACCESS_PASSWORD
    return
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    echo "Set ACCESS_PASSWORD or create ${ACCESS_PASSWORD_FILE}"
    exit 1
  fi
  ACCESS_PASSWORD="$(openssl rand -base64 12 | tr -dc 'A-Za-z0-9' | head -c 12)"
  printf '%s' "${ACCESS_PASSWORD}" >"${ACCESS_PASSWORD_FILE}"
  chmod 600 "${ACCESS_PASSWORD_FILE}"
  export ACCESS_PASSWORD
  echo "已生成访问密码，保存在 ${ACCESS_PASSWORD_FILE}"
  echo "访问密码: ${ACCESS_PASSWORD}"
}

ensure_tls_certs() {
  if [[ "${HTTPS}" == "0" ]]; then
    return
  fi
  if [[ -f "${TLS_CERT}" && -f "${TLS_KEY}" ]]; then
    return
  fi
  echo "TLS certificate not found, generating..."
  "${ROOT}/scripts/gen-cert.sh"
}


cd "${ROOT}"

mkdir -p "${RUN_DIR}"

is_running() {
  [[ -f "${PID_FILE}" ]] || return 1
  local pid
  pid="$(cat "${PID_FILE}")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

is_dev_running() {
  [[ -f "${DEV_PID_FILE}" ]] || return 1
  local pid
  pid="$(cat "${DEV_PID_FILE}")"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

# 递归终止进程及其全部后代。
# 启动链实际是 npm/npx -> sh -> node(.bin/tsx) -> 真实服务进程，
# PID 文件只记录顶层，只 kill 顶层会留下孤儿进程，故须按树杀净。
kill_process_tree() {
  local pid="$1"
  local child
  for child in $(ps -o pid= --ppid "${pid}" 2>/dev/null); do
    kill_process_tree "${child}"
  done
  kill "${pid}" 2>/dev/null || true
}

ensure_runtime_deps() {
  if [[ ! -d "${ROOT}/node_modules" ]]; then
    echo "Missing node_modules. Run: ./build.sh  (or npm install)"
    exit 1
  fi
}

require_prod_build() {
  if [[ ! -f "${ROOT}/dist/client/index.html" ]]; then
    echo "Production build not found. Run first: ./build.sh"
    exit 1
  fi
}

# 等端口真正能响应（服务端启动时要先 reconcile 远端服务，可能十几秒）
wait_for_http() {
  local port="$1" tries="${2:-60}"
  local scheme="https"
  [[ "${HTTPS}" == "0" ]] && scheme="http"
  local i
  for ((i = 0; i < tries; i++)); do
    if curl -sk -o /dev/null --max-time 2 "${scheme}://127.0.0.1:${port}/" 2>/dev/null; then
      return 0
    fi
    is_running || return 1
    sleep 0.5
  done
  return 1
}

wait_for_port_free() {
  local port="$1" tries="${2:-40}"
  local i
  for ((i = 0; i < tries; i++)); do
    if ! ss -ltn 2>/dev/null | grep -q ":${port} "; then
      return 0
    fi
    sleep 0.25
  done
  return 1
}

cmd_start() {
  local mode="${1:-prod}"

  if [[ "${mode}" == "dev" ]]; then
    cmd_dev_start
    return
  fi

  if is_running; then
    echo "Service already running (PID $(cat "${PID_FILE}"))."
    exit 0
  fi

  ensure_runtime_deps
  require_prod_build
  ensure_tls_certs
  ensure_access_password

  echo "Starting production server on ${HOST}:${PORT} (HTTPS=${HTTPS})..."
  nohup setsid env NODE_ENV=production \
    HOST="${HOST}" PORT="${PORT}" HTTPS="${HTTPS}" \
    TLS_KEY="${TLS_KEY}" TLS_CERT="${TLS_CERT}" \
    ACCESS_PASSWORD="${ACCESS_PASSWORD}" \
    npx tsx server/index.ts >>"${LOG_FILE}" 2>&1 &
  echo $! >"${PID_FILE}"
  sleep 0.5

  if is_running; then
    if wait_for_http "${PORT}"; then
      echo "Started (PID $(cat "${PID_FILE}")). Log: ${LOG_FILE}"
    else
      echo "Started (PID $(cat "${PID_FILE}")), but port ${PORT} is not ready yet. Log: ${LOG_FILE}"
    fi
    print_http_urls "${PORT}" "Open"
  else
    echo "Failed to start. See ${LOG_FILE}"
    rm -f "${PID_FILE}"
    exit 1
  fi
}

cmd_dev_start() {
  if is_dev_running; then
    echo "Dev service already running (PID $(cat "${DEV_PID_FILE}"))."
    exit 0
  fi
  if is_running; then
    echo "Production service is running. Stop it first: ./run.sh stop"
    exit 1
  fi

  ensure_runtime_deps
  ensure_tls_certs
  ensure_access_password

  echo "Starting dev (Vite :${VITE_PORT} + API/WS :${PORT}, HTTPS=${HTTPS}) on ${HOST}..."
  nohup setsid env HOST="${HOST}" PORT="${PORT}" HTTPS="${HTTPS}" \
    TLS_KEY="${TLS_KEY}" TLS_CERT="${TLS_CERT}" VITE_PORT="${VITE_PORT}" \
    ACCESS_PASSWORD="${ACCESS_PASSWORD}" \
    npm run dev >>"${DEV_LOG_FILE}" 2>&1 &
  echo $! >"${DEV_PID_FILE}"
  sleep 1

  if is_dev_running; then
    echo "Dev started (PID $(cat "${DEV_PID_FILE}")). Log: ${DEV_LOG_FILE}"
    print_http_urls "${VITE_PORT}" "Frontend"
    echo "WebSocket/backend port: ${PORT}"
    print_http_urls "${PORT}" "Backend (HTTP/WS)"
  else
    echo "Failed to start dev. See ${DEV_LOG_FILE}"
    rm -f "${DEV_PID_FILE}"
    exit 1
  fi
}

cmd_stop() {
  local stopped=0

  if is_dev_running; then
    local pid
    pid="$(cat "${DEV_PID_FILE}")"
    echo "Stopping dev (PID ${pid})..."
    kill -- "-${pid}" 2>/dev/null || true
    kill_process_tree "${pid}"
    wait "${pid}" 2>/dev/null || true
    rm -f "${DEV_PID_FILE}"
    stopped=1
  fi

  if is_running; then
    local pid
    pid="$(cat "${PID_FILE}")"
    echo "Stopping service (PID ${pid})..."
    kill -- "-${pid}" 2>/dev/null || true
    kill_process_tree "${pid}"
    wait "${pid}" 2>/dev/null || true
    rm -f "${PID_FILE}"
    stopped=1
  fi

  if [[ "${stopped}" -eq 0 ]]; then
    echo "Service is not running."
  else
    echo "Stopped."
  fi
}

cmd_restart() {
  local mode="${1:-prod}"
  cmd_stop
  wait_for_port_free "${PORT}" || true
  cmd_start "${mode}"
}

cmd_status() {
  if is_running; then
    echo "Production: running (PID $(cat "${PID_FILE}"), ${HOST}:${PORT})"
    print_http_urls "${PORT}" "URLs"
  elif is_dev_running; then
    echo "Dev: running (PID $(cat "${DEV_PID_FILE}"), Vite :${VITE_PORT}, WS :${PORT})"
    print_http_urls "${VITE_PORT}" "Frontend"
  else
    echo "Not running."
    exit 1
  fi
}

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [options]

Commands:
  start [prod|dev]   Start service (prod requires ./build.sh first)
  stop               Stop prod or dev service
  restart [prod|dev] Restart service
  status             Show running state and access URLs

Environment:
  HOST        Bind address (default: 0.0.0.0)
  PORT        Backend port (default: 3000)
  VITE_PORT   Dev frontend port (default: 5173)
  HTTPS       1 = TLS (default), 0 = plain HTTP/WS
  TLS_KEY     Private key path (default: certs/server.key)
  TLS_CERT    Certificate path (default: certs/server.crt)

Examples:
  ./build.sh && ./run.sh start
  ./run.sh start dev
  HTTPS=0 ./run.sh start          # 不使用 HTTPS
  ./scripts/gen-cert.sh           # IP 变化后重新生成证书
  HOST=0.0.0.0 PORT=8080 ./run.sh restart
EOF
}

main() {
  local cmd="${1:-}"
  shift || true

  case "${cmd}" in
    start)
      cmd_start "${1:-prod}"
      ;;
    stop)
      cmd_stop
      ;;
    restart)
      cmd_restart "${1:-prod}"
      ;;
    status)
      cmd_status
      ;;
    -h|--help|help|"")
      usage
      [[ -z "${cmd}" ]] && exit 1
      ;;
    *)
      echo "Unknown command: ${cmd}"
      usage
      exit 1
      ;;
  esac
}

main "$@"
