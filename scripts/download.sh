#!/usr/bin/env bash
# download <文件|目录>... —— 把文件通过浏览器下载下来（本机 / SSH 窗口都支持）
#
# 用法：
#   download a.tar.gz
#   download some-dir/                # 目录会打包成 tar.gz
#   download a.log b.csv              # 多个文件会打包成 tar.gz
#
# 原理：向终端输出 OSC 1339 控制序列（base64 JSON），浏览器端终端解析后带登录态
# 调用 /api/dl/prepare，服务端按窗口类型取文件（本机直接读，SSH 窗口用 ssh 把远端
# 文件 / `tar -czf -` 的打包流回传）。下载期间浏览器会把进度写回本进程的 stdin，
# 因此命令会一直等到下载结束才退出，并显示进度。
set -u

usage() {
  echo "用法: download <文件|目录>..." >&2
  echo "      单个文件直接下载；目录或多个文件会打包成 tar.gz；本机/SSH 窗口都支持" >&2
}

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
  usage
  exit 0
fi

if [ -z "${BT_PANE_ID:-}" ]; then
  echo "download: 当前窗口没有凭据。" >&2
  echo "          download 需要在浏览器终端窗口里运行（本机或 SSH 窗口都支持）。" >&2
  exit 1
fi

paths=()
for p in "$@"; do
  case "$p" in
    "~") p=$HOME ;;
    "~/"*) p="$HOME/${p#'~/'}" ;;
  esac
  if [ ! -e "$p" ]; then
    echo "download: 不存在: $p" >&2
    exit 1
  fi
  paths+=("$p")
done

json_escape() {
  local s=$1
  s=${s//\\/\\\\}
  s=${s//\"/\\\"}
  printf '%s' "$s"
}

human() {
  awk -v b="${1:-0}" 'BEGIN {
    split("B KB MB GB TB", u, " ");
    i = 1;
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    if (i == 1) printf "%d %s", b, u[i];
    else printf "%.1f %s", b, u[i];
  }' 2>/dev/null || printf '%s B' "$1"
}

req_id="$$-$(date +%s 2>/dev/null || echo 0)"

json_paths=""
for p in "${paths[@]}"; do
  esc=$(json_escape "$p")
  json_paths="${json_paths:+$json_paths,}\"$esc\""
done
json=$(printf '{"reqId":"%s","cwd":"%s","paths":[%s]}' \
  "$req_id" "$(json_escape "$(pwd)")" "$json_paths")
payload=$(printf '%s' "$json" | base64 2>/dev/null | tr -d '\r\n')
if [ -z "$payload" ]; then
  echo "download: 系统缺少 base64，无法发起下载" >&2
  exit 1
fi

# 关闭回显：浏览器写回 stdin 的进度行不应显示成输入
stty_saved=""
if [ -t 0 ] && stty_saved=$(stty -g 2>/dev/null); then
  stty -echo 2>/dev/null || true
  trap 'stty "$stty_saved" 2>/dev/null || stty echo 2>/dev/null || true' EXIT
fi

# OSC 1339：ESC ] 1339 ; <base64> BEL
printf '\033]1339;%s\007' "$payload"

# Ctrl+C：通知浏览器/服务端取消下载，然后立刻退出（不要留下半截提示符）
cancelled=0
on_int() {
  cancelled=1
  cancel_json=$(printf '{"reqId":"%s","cancel":"%s"}' "$req_id" "$req_id")
  cancel_payload=$(printf '%s' "$cancel_json" | base64 2>/dev/null | tr -d '\r\n')
  if [ -n "$cancel_payload" ]; then
    printf '\033]1339;%s\007' "$cancel_payload"
  fi
}

trap on_int INT

started=$(date +%s 2>/dev/null || echo 0)
target=$(printf '%s ' "${paths[@]}")
printf 'download: 开始下载 %s\n' "$target"
printf '\r\033[K等待浏览器…'

deadline=$(( ${started:-0} + 900 ))
done_state=""
final_bytes=0
final_total=""
final_msg=""
last_shown=""
last_bytes=0

while :; do
  now=$(date +%s 2>/dev/null || echo 0)
  if [ "${now:-0}" -ge "$deadline" ]; then
    printf '\r\033[K'
    echo "download: 超时（15 分钟没有完成）" >&2
    exit 1
  fi
  if [ "$cancelled" = "1" ]; then
    break
  fi
  if ! IFS= read -r -s -t 2 line; then
    continue
  fi
  case "$line" in
    "$req_id|"*) ;;
    *) continue ;;
  esac
  rest=${line#"$req_id|"}
  state=${rest%%|*}
  rest=${rest#*|}
  bytes=${rest%%|*}
  rest=${rest#*|}
  total=${rest%%|*}
  msg=${rest#*|}
  case "$state" in
    progress)
      last_bytes=${bytes:-0}
      if [ -n "${total:-}" ] && [ "${total:-0}" -gt 0 ] 2>/dev/null; then
        pct=$(( ${bytes:-0} * 100 / total ))
        shown="$(human "$bytes") / $(human "$total")  ${pct}%"
      else
        shown="$(human "$bytes")"
      fi
      if [ "$shown" != "$last_shown" ]; then
        printf '\r\033[K下载中 %s' "$shown"
        last_shown=$shown
      fi
      ;;
    done)
      done_state=done
      final_bytes=$bytes
      final_total=$total
      break
      ;;
    error)
      done_state=error
      final_bytes=$bytes
      final_total=$total
      final_msg=$msg
      break
      ;;
  esac
done

# 清掉可能残留的进度行，避免被 shell 当命令执行
while IFS= read -r -t 0.2 _ 2>/dev/null; do :; done

printf '\r\033[K'
if [ "$cancelled" = "1" ] || [ "$done_state" = "cancelled" ]; then
  # 清掉可能残留的进度行再退出，避免被 shell 当命令
  while IFS= read -r -t 0.2 _ 2>/dev/null; do :; done
  printf '\033[33mdownload: 已取消\033[0m  （已下载 %s）\n' "$(human "$last_bytes")"
  exit 130
fi
elapsed=$(( $(date +%s 2>/dev/null || echo 0) - started ))
if [ "$done_state" = "done" ]; then
  printf '\033[32mdownload: 完成\033[0m  %s（用时 %ss）\n' "$(human "$final_bytes")" "$elapsed"
  exit 0
fi
printf '\033[31mdownload: 失败\033[0m  %s\n' "${final_msg:-下载失败}" >&2
exit 1
