#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib.sh
source "${ROOT}/scripts/lib.sh"

CERT_DIR="${ROOT}/certs"
KEY_FILE="${CERT_DIR}/server.key"
CRT_FILE="${CERT_DIR}/server.crt"
DAYS="${CERT_DAYS:-825}"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl not found. Install openssl to generate HTTPS certificates."
  exit 1
fi

mkdir -p "${CERT_DIR}"

alt_idx=1
declare -a san_lines=(
  "DNS.${alt_idx} = localhost"
)
alt_idx=$((alt_idx + 1))
san_lines+=("IP.${alt_idx} = 127.0.0.1")
alt_idx=$((alt_idx + 1))

while IFS= read -r ip; do
  [[ -z "${ip}" ]] && continue
  [[ "${ip}" == "127.0.0.1" ]] && continue
  san_lines+=("IP.${alt_idx} = ${ip}")
  alt_idx=$((alt_idx + 1))
done < <(list_lan_ipv4)

CONF="$(mktemp)"
trap 'rm -f "${CONF}"' EXIT

{
  echo '[req]'
  echo 'distinguished_name = req_distinguished_name'
  echo 'x509_extensions = v3_req'
  echo 'prompt = no'
  echo '[req_distinguished_name]'
  echo 'CN = browser-terminal'
  echo '[v3_req]'
  echo 'subjectAltName = @alt_names'
  echo '[alt_names]'
  printf '%s\n' "${san_lines[@]}"
} >"${CONF}"

echo "Generating self-signed certificate (${DAYS} days)..."
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "${KEY_FILE}" \
  -out "${CRT_FILE}" \
  -days "${DAYS}" \
  -config "${CONF}" \
  -extensions v3_req 2>/dev/null

chmod 600 "${KEY_FILE}"
echo "Wrote ${CRT_FILE}"
echo "Wrote ${KEY_FILE}"
echo "局域网 IP 变更后请重新运行: ./scripts/gen-cert.sh"
