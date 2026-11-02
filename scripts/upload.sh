#!/usr/bin/env bash
# upload —— 把浏览器里的文件拖进终端窗口，上传到当前目录
#
# 用法：
#   upload          # 执行后把文件拖进终端窗口（可多次拖入），Ctrl+C 结束
#
# 原理：向终端打印 OSC 1339 请求，浏览器端进入"接收拖拽"状态（不弹系统文件框），
# 拖入的文件逐个 POST 到 /api/ul/<id>/file；服务端按窗口类型落盘（本机直接写，
# SSH 窗口用 ssh 的 `cat > 文件` 流过去）。上传进度写回本进程 stdin，
# 所以终端里有实时进度；Ctrl+C 结束。
set -u

if [ "$#" -gt 0 ]; then
  case "$1" in
    -h|--help)
      echo "用法: upload     （无参数；执行后把文件拖进终端窗口，可多次拖入，Ctrl+C 结束）" >&2
      exit 0
      ;;
  esac
  echo "upload: 不需要参数。执行 upload 后把文件拖进终端窗口即可。" >&2
  exit 1
fi

if [ -z "${BT_PANE_ID:-}" ]; then
  echo "upload: 当前窗口没有凭据。" >&2
  echo "        upload 需要在浏览器终端窗口里运行（本机或 SSH 窗口都支持）。" >&2
  exit 1
fi

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

json=$(printf '{"reqId":"%s","action":"upload","cwd":"%s","dropOnly":true}' \
  "$req_id" "$(json_escape "$(pwd)")")
payload=$(printf '%s' "$json" | base64 2>/dev/null | tr -d '\r\n')
if [ -z "$payload" ]; then
  echo "upload: 系统缺少 base64，无法发起上传" >&2
  exit 1
fi

stty_saved=""
if [ -t 0 ] && stty_saved=$(stty -g 2>/dev/null); then
  stty -echo 2>/dev/null || true
  trap 'stty "$stty_saved" 2>/dev/null || stty echo 2>/dev/null || true' EXIT
fi

printf '\033]1339;%s\007' "$payload"

started=$(date +%s 2>/dev/null || echo 0)
printf 'upload: 把文件拖进终端窗口即可上传到 %s（可多次拖入，Ctrl+C 结束）\n' "$(pwd)"
printf '\r\033[K等待拖入文件…'

total_files=0
total_bytes=0
last_bytes=0
last_shown=""

while :; do
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
        shown="$(human "${bytes:-0}") / $(human "$total")  ${pct}%"
      else
        shown="$(human "${bytes:-0}")"
      fi
      [ -n "${msg:-}" ] && shown="$shown  $msg"
      if [ "$shown" != "$last_shown" ]; then
        printf '\r\033[K上传中 %s' "$shown"
        last_shown=$shown
      fi
      ;;
    batch)
      # 一轮拖拽完成：打印小结，继续等下一轮（msg = "<数量> <文件名...>"）
      count=${msg%% *}
      case "$count" in ''|*[!0-9]*) count=0 ;; esac
      total_files=$(( total_files + count ))
      total_bytes=$(( total_bytes + ${bytes:-0} ))
      names=${msg#* }
      printf '\r\033[K\033[32m已上传\033[0m %s 个文件：%s（%s）\n' "$count" "${names:-?}" "$(human "${bytes:-0}")"
      printf '\r\033[K等待拖入文件…'
      last_shown=""
      last_bytes=0
      ;;
    error)
      printf '\r\033[K\033[31mupload: %s\033[0m\n' "${msg:-上传失败}"
      printf '\r\033[K等待拖入文件…'
      last_shown=""
      ;;
  esac
done

# 排空管道，避免残留进度行被 shell 当命令执行
while IFS= read -r -t 0.2 _ 2>/dev/null; do :; done
printf '\r\033[K'
printf '\033[33mupload: 结束\033[0m  本次共上传 %s 个文件，%s\n' "$total_files" "$(human "$total_bytes")"
exit 0
