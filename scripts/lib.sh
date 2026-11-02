# shellcheck shell=bash
# Shared helpers for run.sh / build.sh

list_lan_ipv4() {
  local ip
  if command -v ip >/dev/null 2>&1; then
    while IFS= read -r ip; do
      [[ -n "${ip}" ]] && printf '%s\n' "${ip}"
    done < <(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
    return 0
  fi
  if command -v hostname >/dev/null 2>&1; then
    read -r -a _ips <<< "$(hostname -I 2>/dev/null || true)"
    for ip in "${_ips[@]}"; do
      [[ -n "${ip}" ]] && printf '%s\n' "${ip}"
    done
  fi
}

url_scheme() {
  if [[ "${HTTPS:-1}" == "0" ]]; then
    echo "http"
  else
    echo "https"
  fi
}

print_access_urls() {
  local port="$1"
  local label="${2:-Open}"
  local scheme
  scheme="$(url_scheme)"

  echo "${label} ${scheme}://localhost:${port}"
  local ip
  local any=0
  while IFS= read -r ip; do
    echo "       ${scheme}://${ip}:${port}"
    any=1
  done < <(list_lan_ipv4)

  if [[ "${any}" -eq 0 ]]; then
    echo "       (未检测到局域网 IPv4，请在本机用 ip addr 查看)"
  fi

  if [[ "${scheme}" == "https" ]]; then
    echo "       (自签名证书：浏览器会提示不安全，需手动继续访问或信任证书)"
  fi
}

# 兼容旧调用名
print_http_urls() {
  print_access_urls "$@"
}
