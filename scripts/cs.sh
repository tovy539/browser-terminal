#!/usr/bin/env bash
# cs [路径] —— 在浏览器终端的当前窗口所指向的设备上，用 code-server 打开目录或文件
#
# 原理：本机窗口启动时，服务端会把 BT_APP_URL / BT_CODE_TOKEN / BT_PANE_ID 注入到
# shell 环境；本命令带着这些凭据请求服务端，由服务端按该窗口的目标设备启动
# code-server，并通过 WebSocket 让浏览器自动打开对应的标签页。
# 跟的是文件时，会打开它所在目录并用 code-server 的 payload 参数定位到该文件。
set -u

if [ -z "${BT_APP_URL:-}" ] || [ -z "${BT_CODE_TOKEN:-}" ] || [ -z "${BT_PANE_ID:-}" ]; then
  echo "cs: 当前窗口没有 code-server 凭据。" >&2
  echo "    cs 只能在浏览器终端的『本机』窗口里运行（SSH 窗口暂不支持）。" >&2
  exit 1
fi

target=${1:-$PWD}
case "$target" in
  "~") target=$HOME ;;
  "~/"*) target="$HOME/${target#'~/'}" ;;
esac
if [ ! -e "$target" ]; then
  echo "cs: 路径不存在: $target" >&2
  exit 1
fi

folder=""
file=""
if [ -d "$target" ]; then
  folder=$(cd "$target" && pwd)
elif [ -f "$target" ]; then
  folder=$(cd "$(dirname "$target")" && pwd)
  file="$folder/$(basename "$target")"
else
  echo "cs: 不是普通文件或目录: $target" >&2
  exit 1
fi

payload=$(printf '{"token":"%s","pane":"%s","folder":"%s","file":"%s"}' \
  "$BT_CODE_TOKEN" "$BT_PANE_ID" "${folder//\"/\\\"}" "${file//\"/\\\"}")
resp=$(curl -sk --max-time 180 -X POST "$BT_APP_URL/api/code/open-pane" \
  -H 'Content-Type: application/json' --data-binary "$payload" 2>/dev/null)

url=$(printf '%s' "$resp" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')
if [ -z "$url" ]; then
  err=$(printf '%s' "$resp" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
  echo "cs: ${err:-请求服务端失败（$BT_APP_URL）}" >&2
  exit 1
fi

if [ -n "$file" ]; then
  echo "cs: 已在该窗口的设备上打开 code-server 并定位到 $file"
else
  echo "cs: 已在该窗口的设备上打开 code-server → $folder"
fi
