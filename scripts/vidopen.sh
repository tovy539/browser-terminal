#!/usr/bin/env bash
# vidopen <文件> —— 在浏览器里新开一个页面播放该音视频（类似 cs 打开 code-server）
#
# 原理：本机窗口启动时服务端注入了 BT_APP_URL / BT_CODE_TOKEN / BT_PANE_ID；
# 本命令带凭据请求服务端，服务端登记一个播放会话并通过 WebSocket 让浏览器新开
# /video/<id> 页面，页面里的 <video>/<audio> 走 /api/video（支持 Range、可拖进度条）。
set -u

if [ -z "${BT_APP_URL:-}" ] || [ -z "${BT_CODE_TOKEN:-}" ] || [ -z "${BT_PANE_ID:-}" ]; then
  echo "vidopen: 当前窗口没有凭据。" >&2
  echo "         vidopen 只能在浏览器终端的『本机』窗口里运行（SSH 窗口暂不支持）。" >&2
  exit 1
fi

if [ $# -lt 1 ]; then
  echo "用法: vidopen <文件>" >&2
  exit 1
fi

file=$1
case "$file" in
  "~") file=$HOME ;;
  "~/"*) file="$HOME/${file#'~/'}" ;;
esac
if [ ! -e "$file" ]; then
  echo "vidopen: 文件不存在: $file" >&2
  exit 1
fi
file=$(cd "$(dirname "$file")" && pwd)/$(basename "$file")

payload=$(printf '{"token":"%s","pane":"%s","path":"%s"}' \
  "$BT_CODE_TOKEN" "$BT_PANE_ID" "${file//\"/\\\"}")
resp=$(curl -sk --max-time 30 -X POST "$BT_APP_URL/api/vid/open" \
  -H 'Content-Type: application/json' --data-binary "$payload" 2>/dev/null)

url=$(printf '%s' "$resp" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
if [ -z "$url" ]; then
  err=$(printf '%s' "$resp" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
  echo "vidopen: ${err:-请求服务端失败（$BT_APP_URL）}" >&2
  exit 1
fi

echo "vidopen: 已在新页面打开 $file"
