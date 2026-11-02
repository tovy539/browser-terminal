#!/usr/bin/env bash
# imgcat — 在终端内联显示图片（iTerm2 inline image protocol / OSC 1337）。
#
# 本工程的浏览器终端已加载 @xterm/addon-image，支持该协议；
# iTerm2 / WezTerm / kitty(经 iip) / mintty 等同样可用。
#
# 用法：
#   imgcat demo.png
#   imgcat -w 50% demo.png        # 宽度为终端宽度的 50%
#   imgcat -w 40 -H 20 a.png b.png  # 宽 40 列、高 20 行
#   cat demo.png | imgcat -         # 从标准输入读取
set -euo pipefail

# 与浏览器端 addon-image 的 iipSizeLimit 默认值保持一致
SIZE_LIMIT=20000000

width="auto"
height="auto"
files=()

usage() {
  cat <<'EOF'
用法: imgcat [-w 宽] [-H 高] 文件...

  -w, --width   宽度: N(列) / Npx / N% / auto(默认)
  -H, --height  高度: N(行) / Npx / N% / auto(默认)
  -             从标准输入读取图片
  -h, --help    显示本帮助

示例: imgcat -w 60% screenshot.png
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -w|--width)  width="${2:?--width 需要一个值}"; shift 2 ;;
    -H|--height) height="${2:?--height 需要一个值}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    --)          shift; while [[ $# -gt 0 ]]; do files+=("$1"); shift; done ;;
    -)           files+=("-"); shift ;;
    -*)          echo "imgcat: 未知参数: $1" >&2; usage >&2; exit 2 ;;
    *)           files+=("$1"); shift ;;
  esac
done

if [[ ${#files[@]} -eq 0 ]]; then
  usage >&2
  exit 2
fi

emit() {
  local path="$1" tmp="" size name_b64 data_b64
  if [[ "$path" == "-" ]]; then
    tmp="$(mktemp)"
    cat >"${tmp}"
    path="${tmp}"
  fi

  if [[ ! -f "$path" || ! -r "$path" ]]; then
    echo "imgcat: 无法读取文件: $path" >&2
    [[ -n "$tmp" ]] && rm -f "$tmp"
    return 1
  fi

  size="$(wc -c <"$path" | tr -d '[:space:]')"
  if (( size == 0 )); then
    echo "imgcat: 文件为空: $path" >&2
    [[ -n "$tmp" ]] && rm -f "$tmp"
    return 1
  fi
  if (( size > SIZE_LIMIT )); then
    echo "imgcat: 文件 ${size} 字节，超过浏览器端 ${SIZE_LIMIT} 字节上限，将不会显示" >&2
  fi

  # name 需为 base64 编码的文件名；size 必须与实际字节数一致，否则解码会被截断
  name_b64="$(basename -- "$path" | tr -d '\n' | base64 | tr -d '\n')"
  data_b64="$(base64 <"$path" | tr -d '\n')"

  printf '\033]1337;File=name=%s;size=%s;inline=1;width=%s;height=%s;preserveAspectRatio=1:%s\a' \
    "$name_b64" "$size" "$width" "$height" "$data_b64"

  # addon-image 采用 VT340 语义：画完图光标停在"图片最后一行"上，
  # 不补换行的话，随后的提示符/输出会压在图片底边上（多图之间也不会互相压）
  printf '\n'

  if [[ -n "$tmp" ]]; then
    rm -f "$tmp"
  fi
  return 0
}

idx=0
for f in "${files[@]}"; do
  idx=$((idx + 1))
  # addon-image 的解码是异步的：同一批输出里紧接着发的第二张图会与第一张抢占同一
  # 光标位置而互相覆盖，多图之间留一点时间让上一张先落位（可用 IMGCAT_DELAY 调整）
  if (( idx > 1 )); then
    sleep "${IMGCAT_DELAY:-0.6}"
  fi
  emit "$f" || exit 1
done
