#!/usr/bin/env bash
# vidcat — 把视频逐帧编码成 SIXEL 刷进终端（不需要叠加层，走 @xterm/addon-image）。
#
# 与 vidopen 的区别：
#   termvid  叠加一个真正的 <video>，有声音/进度条/全屏，靠浏览器解码（推荐）
#   vidcat   纯终端协议逐帧播放，无声音、不能 seek，但"就是终端里的像素"
#
# 默认只播前 5 秒，而且是"边抽边播"：ffmpeg 在后台写帧，画面一就绪就开始放，
# 不用等整段抽完（1080p 视频抽 3000 帧要两分多钟，等完再放是不可接受的）。
#
# 用法：
#   vidcat demo.mp4                    # 前 5 秒、10fps、自动按终端像素尺寸缩放
#   vidcat --full --fps 8 demo.mp4     # 整段播放（自己想清楚，很慢）
#   vidcat --start 60 --duration 10 demo.mp4
#   vidcat --cols 80 demo.mp4          # 宽 80 列
#   vidcat --text demo.mp4             # 字符画模式（chafa），不支持 sixel 的终端也能看
set -euo pipefail

FPS=10
BOX_W=""
BOX_H=""
COLS=""
START=""
DURATION="0"   # 默认整段：边取边播，Ctrl+C 停
LOOP=0
TEXT_MODE=0
# 默认 inline：主屏上从当前命令行往下画，左右/上下都跟着终端排版走（像 imgcat 那样嵌在命令流里）；
# fullscreen：备用屏 + 关 sixel 滚动，每帧覆盖视口左上角（旧行为）
INLINE=1
USE_ALT=0
SIXEL_NOSCROLL=0
INLINE_ROWS=0
# INLINE_DREW: 屏幕上已经有画面块了；INLINE_MID: 中断时正处在"帧写到一半"
INLINE_DREW=0
INLINE_MID=0
# 抽帧背压：领先播放太多就 SIGSTOP ffmpeg，避免整段播放时一路抽到底白占 CPU/磁盘
FFMPEG_STOPPED=0
BACKLOG_MAX=60
BACKLOG_MIN=15
MAX_FRAMES=3000
MAX_PIXELS=100000
# 画面质量默认交给 img2sixel 原生设置：256 色 + 抖动（最好看，但每帧解码量最大）。
# 觉得卡可以自己降：--colors 32 --no-dither（体积/解码量约降到 1/3），
# 脚本不会背着你改颜色——自适应只调帧率。
COLORS=256
DITHER=1
# 每秒六色负载预算（KB/s），用于按实际画面自适应降色/降帧
BUDGET_KB=400
PROXY_REQ=0
PROXY_FILE=""
FAST_DECODE=0
# 默认画面占窗口宽/高的百分比（等比适配到这个框以内）
FIT_PERCENT=80
FFMPEG_PID=""

usage() {
  cat <<'EOF'
用法: vidcat [选项] <视频文件>

  --fps N        帧率（默认 10）
  --duration S   只播 S 秒（默认 0 = 整段实时播放；Ctrl+C 可随时停）
  --full         等价 --duration 0（保留兼容）
  --start S      从第 S 秒开始（默认 0，配合 -ss 快速定位）
  --w PX         画面宽度像素
  --h PX         画面高度像素（与 --w 同时给出时按"装进这个框"缩放）
  --cols N       宽度按终端列数（自动查询单元格像素，查不到就按 8px/列）
  --loop         循环播放
  --max-frames N 最多抽 N 帧（默认 3000，防止塞满磁盘）
  --fit N        画面最大占窗口宽/高的百分比（默认 80）；等比适配，不会超出
  --max-pixels N 分辨率上限：保证 宽*高 <= N（默认 100000，约 421x237 @16:9；0 = 不限）
  --colors N     sixel 调色板颜色数 8/16/32/64/128/256（默认 256，画质优先）
  --dither       开启抖动（默认开，等同 img2sixel 原生默认）
  --no-dither    关闭抖动：体积/解码量约降到 1/3，卡的时候用
  --budget KB/s  每秒负载预算（默认 400），超了只降帧率，不动你的颜色设置
  --proxy [文件] 先把片段转成小代理再播（4K/HEVC 这类源在这类机器上解码极慢时用；
                 不指定路径则放 /tmp/vidcat-proxy-<hash>.mp4，下次自动复用）
  --fast-decode  跳过去块滤波，解码快约 20%（画面略差）
  --text         用 chafa 输出字符画（替代 SIXEL）
  --inline       内联播放（默认）：在当前命令行下方原地重画，命令和输出都保留
  --fullscreen   全屏播放：备用屏 + 关 sixel 滚动，每帧覆盖视口左上角（旧行为）
  --no-alt       兼容旧参数：不用备用屏，但仍是关滚动的"覆盖式"画法
  -h, --help     显示本帮助

边抽边播；播放中按 Ctrl+C 退出，终端状态会自动恢复。
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --fps) FPS="${2:?--fps 需要一个值}"; shift 2 ;;
    --w) BOX_W="${2:?--w 需要一个值}"; shift 2 ;;
    --h) BOX_H="${2:?--h 需要一个值}"; shift 2 ;;
    --cols) COLS="${2:?--cols 需要一个值}"; shift 2 ;;
    --start) START="${2:?--start 需要一个值}"; shift 2 ;;
    --duration) DURATION="${2:?--duration 需要一个值}"; shift 2 ;;
    --full) DURATION="0"; shift ;;
    --max-frames) MAX_FRAMES="${2:?--max-frames 需要一个值}"; shift 2 ;;
    --max-pixels) MAX_PIXELS="${2:?--max-pixels 需要一个值}"; shift 2 ;;
    --fit) FIT_PERCENT="${2:?--fit 需要一个值}"; shift 2 ;;
    --colors) COLORS="${2:?--colors 需要一个值}"; shift 2 ;;
    --dither) DITHER=1; shift ;;
    --no-dither) DITHER=0; shift ;;
    --budget) BUDGET_KB="${2:?--budget 需要一个值}"; shift 2 ;;
    --proxy)
      PROXY_REQ=1
      if [[ $# -ge 2 && "$2" != -* ]]; then PROXY_FILE="$2"; shift 2; else shift; fi
      ;;
    --fast-decode) FAST_DECODE=1; shift ;;
    --loop) LOOP=1; shift ;;
    --text) TEXT_MODE=1; shift ;;
    --inline) INLINE=1; USE_ALT=0; SIXEL_NOSCROLL=0; shift ;;
    --fullscreen) INLINE=0; USE_ALT=1; SIXEL_NOSCROLL=1; shift ;;
    --no-alt) INLINE=0; USE_ALT=0; SIXEL_NOSCROLL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "vidcat: 未知参数: $1" >&2; usage >&2; exit 2 ;;
    *) INPUT="$1"; shift ;;
  esac
done

if [[ -z "${INPUT:-}" ]]; then
  usage >&2
  exit 2
fi
if [[ ! -f "$INPUT" ]]; then
  echo "vidcat: 找不到文件: $INPUT" >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "vidcat: 需要 ffmpeg（apt install ffmpeg）" >&2
  exit 1
fi
if (( TEXT_MODE )); then
  command -v chafa >/dev/null 2>&1 || { echo "vidcat: --text 模式需要 chafa" >&2; exit 1; }
else
  command -v img2sixel >/dev/null 2>&1 || {
    echo "vidcat: 需要 img2sixel（apt install libsixel-bin），或用 --text" >&2
    exit 1
  }
fi

TMPDIR_FRAMES="$(mktemp -d "${TMPDIR:-/tmp}/vidcat.XXXXXX")"

restore_terminal() {
  # 收尾/中断时把光标挪到画面块之外，避免提示符压在画面底边上：
  #   帧已画完 -> 光标在块的最后一行，换行即可
  #   帧写到一半被 Ctrl+C（序列不完整会被丢弃）-> 光标还在块顶行，要再下移 rows-1 行
  if (( INLINE && INLINE_DREW )); then
    printf '\r\n'
    if (( INLINE_MID && INLINE_ROWS > 1 )); then
      printf '\033[%dB' "$((INLINE_ROWS - 1))"
    fi
    INLINE_DREW=0
    INLINE_MID=0
  fi
  if (( TEXT_MODE == 0 && SIXEL_NOSCROLL )); then
    printf '\033[?80l'
  fi
  printf '\033[?25h'
  if (( USE_ALT )); then
    printf '\033[?1049l'
  fi
}

cleanup() {
  # 还在抽帧就把它一起收掉，避免留下 ffmpeg 进程。
  # 注意：被 SIGSTOP 的进程不会处理挂起的信号，必须先 CONT，否则 kill/wait 会一直卡住。
  if [[ -n "$FFMPEG_PID" ]] && kill -0 "$FFMPEG_PID" 2>/dev/null; then
    kill -CONT "$FFMPEG_PID" 2>/dev/null || true
    kill -TERM "$FFMPEG_PID" 2>/dev/null || true
    local waited=0
    while kill -0 "$FFMPEG_PID" 2>/dev/null && (( waited < 10 )); do
      sleep 0.1
      waited=$((waited + 1))
    done
    kill -KILL "$FFMPEG_PID" 2>/dev/null || true
    wait "$FFMPEG_PID" 2>/dev/null || true
    FFMPEG_PID=""
  fi
  restore_terminal
  rm -rf "$TMPDIR_FRAMES"
}
on_interrupt() {
  cleanup
  exit 130
}
trap cleanup EXIT
trap on_interrupt INT TERM

# 向终端查询单元格像素尺寸（addon-image 默认开启了 getCellSizePixels），应答形如 CSI 6;H;W t
# 注意：本函数是用 <(...) 调用的，stdout 是管道，所以查询序列必须显式写到 /dev/tty
query_cell_px() {
  local saved reply
  saved="$(stty -g 2>/dev/null || true)"
  [[ -n "$saved" ]] || return 1
  stty raw -echo 2>/dev/null || return 1
  if [[ -w /dev/tty ]]; then
    printf '\033[16t' >/dev/tty
  else
    printf '\033[16t' >&2
  fi
  IFS= read -r -t 0.4 -d 't' reply 2>/dev/null || true
  stty "$saved" 2>/dev/null || true
  # 应答形如 ESC [ 6 ; <高> ; <宽> t（read -d t 已吃掉结尾的 t）
  if [[ "$reply" =~ \[6\;([0-9]+)\;([0-9]+)$ ]]; then
    printf '%s %s\n' "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}" # width height
    return 0
  fi
  return 1
}

# 优先用 stty size（读 PTY 的 ioctl，不会被继承来的 LINES/COLUMNS 干扰），tput 兜底
PTY_ROWS=""
PTY_COLS=""
if read -r PTY_ROWS PTY_COLS < <(stty size 2>/dev/null); then :; fi
COLS="${COLS:-${PTY_COLS:-$(tput cols 2>/dev/null || echo 80)}}"
ROWS="${ROWS:-${PTY_ROWS:-$(tput lines 2>/dev/null || echo 24)}}"

CELL_W=""
CELL_H=""
if (( TEXT_MODE == 0 )) && [[ -z "$BOX_W" && -z "$BOX_H" ]]; then
  if read -r cw ch < <(query_cell_px); then
    CELL_W="$cw"
    CELL_H="$ch"
  fi
  # 默认框 = 窗口宽/高 × FIT_PERCENT%（默认 80%），等比适配后画面不会超出窗口
  if [[ -n "$CELL_W" ]]; then
    BOX_W=$((COLS * CELL_W * FIT_PERCENT / 100))
    BOX_H=$((ROWS * CELL_H * FIT_PERCENT / 100))
  else
    # 查询失败：按常见等宽字体 8x16 估算
    BOX_W=$((COLS * 8 * FIT_PERCENT / 100))
    BOX_H=$((ROWS * 16 * FIT_PERCENT / 100))
  fi
fi

if [[ -n "$COLS" && -z "$BOX_W" && -z "$BOX_H" ]]; then
  BOX_W=$((COLS * ${CELL_W:-8} * FIT_PERCENT / 100))
fi

# 源视频尺寸：用来把框补成同样的宽高比、以及算最终输出尺寸
SRC_W=""
SRC_H=""
if command -v ffprobe >/dev/null 2>&1; then
  SRC_DIMS="$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:s=x -- "$INPUT" 2>/dev/null | head -1 || true)"
  if [[ "$SRC_DIMS" =~ ^([0-9]+)x([0-9]+)$ ]]; then
    SRC_W="${BASH_REMATCH[1]}"
    SRC_H="${BASH_REMATCH[2]}"
  fi
  unset SRC_DIMS
fi

# 只给了一边时，用源的宽高比补出另一边（否则像素上限会把画面压成奇怪的比例）
if [[ -n "$SRC_W" && -n "$SRC_H" ]]; then
  if [[ -n "$BOX_W" && -z "$BOX_H" ]]; then
    BOX_H=$((BOX_W * SRC_H / SRC_W))
  elif [[ -z "$BOX_W" && -n "$BOX_H" ]]; then
    BOX_W=$((BOX_H * SRC_W / SRC_H))
  fi
fi

# 先把源按比例装进框，得到实际输出尺寸
OUT_W=""
OUT_H=""
if [[ -n "$SRC_W" && -n "$SRC_H" && -n "$BOX_W" && -n "$BOX_H" ]]; then
  read -r OUT_W OUT_H < <(awk -v sw="$SRC_W" -v sh="$SRC_H" -v bw="$BOX_W" -v bh="$BOX_H" 'BEGIN{
    s = (bw / sw < bh / sh) ? bw / sw : bh / sh;
    printf "%d %d\n", int(sw * s), int(sh * s);
  }')
elif [[ -n "$BOX_W" && -n "$BOX_H" ]]; then
  OUT_W="$BOX_W"
  OUT_H="$BOX_H"
fi

# 像素上限（默认 60000）：等比缩小，保证 宽*高 <= MAX_PIXELS
CAPPED=0
if (( TEXT_MODE == 0 && MAX_PIXELS > 0 )); then
  if [[ -n "$OUT_W" && -n "$OUT_H" ]] && (( OUT_W * OUT_H > MAX_PIXELS )); then
    CAPPED=1
    read -r OUT_W OUT_H < <(awk -v w="$OUT_W" -v h="$OUT_H" -v m="$MAX_PIXELS" 'BEGIN{
      s = sqrt(m / (w * h));
      printf "%d %d\n", int(w * s), int(h * s);
    }')
  elif [[ -z "$OUT_W" && -n "$BOX_W" ]] && (( BOX_W * BOX_W > MAX_PIXELS )); then
    CAPPED=1
    OUT_W="$(awk -v m="$MAX_PIXELS" 'BEGIN{printf "%d", int(sqrt(m))}')"
  fi
  # 取整后可能刚好超一点点，逐像素收到满足为止
  while [[ -n "$OUT_W" && -n "$OUT_H" ]] && (( OUT_W * OUT_H > MAX_PIXELS && OUT_W > 2 && OUT_H > 2 )); do
    OUT_W=$((OUT_W - 1))
    OUT_H=$((OUT_H - 1))
  done
fi

FILTER="fps=${FPS}"
if [[ -n "$OUT_W" && -n "$OUT_H" ]]; then
  # 已经是算好的精确尺寸（写 PNG，不要求偶数）
  FILTER+=",scale=${OUT_W}:${OUT_H}"
elif [[ -n "$OUT_W" ]]; then
  FILTER+=",scale=${OUT_W}:-2"
elif [[ -n "$OUT_H" ]]; then
  FILTER+=",scale=-2:${OUT_H}"
elif [[ -n "$BOX_W" && -n "$BOX_H" ]]; then
  FILTER+=",scale=w=${BOX_W}:h=${BOX_H}:force_original_aspect_ratio=decrease"
elif [[ -n "$BOX_W" ]]; then
  FILTER+=",scale=w=${BOX_W}:-2"
elif [[ -n "$BOX_H" ]]; then
  FILTER+=",scale=h=${BOX_H}:-2"
fi

UNLIMITED=0
[[ "$DURATION" == "0" ]] && UNLIMITED=1

# 内联模式每帧要把光标移回图像块顶部，需要知道图像占了几行
if (( INLINE )); then
  if (( TEXT_MODE )); then
    INLINE_ROWS=$((ROWS - 1))
  else
    _h="${OUT_H:-${BOX_H:-0}}"
    _cell="${CELL_H:-16}"
    if (( _h > 0 )); then
      INLINE_ROWS=$(( (_h + _cell - 1) / _cell ))
    fi
  fi
  (( INLINE_ROWS < 1 )) && INLINE_ROWS=0
fi

# --proxy：4K HEVC 这类源在这类机器上软件解码只有个位数帧率（实测 2.5 帧/秒），
# 先把需要的片段转成同样大小的小代理（x264），后续播放/重播/循环就都是磁盘速度了。
if (( PROXY_REQ )); then
  PROXY_W="${OUT_W:-998}"
  if [[ -z "$PROXY_FILE" ]]; then
    PROXY_KEY="$(printf '%s|%s|%s|%s|%s' "$INPUT" "$START" "$DURATION" "$FPS" "$PROXY_W" | md5sum | cut -c1-10)"
    PROXY_FILE="${TMPDIR:-/tmp}/vidcat-proxy-${PROXY_KEY}.mp4"
  fi
  if [[ -s "$PROXY_FILE" && "$PROXY_FILE" -nt "$INPUT" ]]; then
    : # 已缓存，直接用
  else
    PROXY_ARGS=(-v error -nostdin -y)
    [[ -n "$START" ]] && PROXY_ARGS+=(-ss "$START")
    PROXY_ARGS+=(-i "$INPUT")
    (( UNLIMITED == 0 )) && PROXY_ARGS+=(-t "$DURATION")
    PROXY_ARGS+=(-vf "fps=${FPS},scale=${PROXY_W}:-2" -c:v libx264 -preset ultrafast -crf 28 -an "$PROXY_FILE")
    if ! ffmpeg "${PROXY_ARGS[@]}"; then
      echo "vidcat: 代理生成失败，改用直读源文件" >&2
      rm -f "$PROXY_FILE"
    fi
  fi
  if [[ -s "$PROXY_FILE" ]]; then
    INPUT="$PROXY_FILE"
    START=""
    DURATION="0"
    UNLIMITED=1
    # 代理已经是目标尺寸，抽帧时再 scale 到同样大小等于没缩放
    [[ -n "$OUT_W" ]] && FILTER="fps=${FPS},scale=${OUT_W}:${OUT_H:-$OUT_W}"
  fi
fi

DURATION_TEXT=""
if (( UNLIMITED )); then
  DURATION_TEXT="整段边取边播（${START:+从 ${START}s 起，}最多 ${MAX_FRAMES} 帧）"
else
  DURATION_TEXT="前 ${DURATION} 秒${START:+（从 ${START}s 起）}"
fi
CAP_NOTE=""
if (( CAPPED )); then
  CAP_NOTE="，已按上限 ${MAX_PIXELS} 压缩"
fi
if (( TEXT_MODE )); then
  SIZE_TEXT="字符画 ${COLS}x${ROWS} 字符"
elif [[ -n "$OUT_W" && -n "$OUT_H" ]]; then
  SIZE_TEXT="${OUT_W}x${OUT_H}（$((OUT_W * OUT_H)) px${CAP_NOTE}）"
elif [[ -n "$BOX_W" || -n "$BOX_H" ]]; then
  SIZE_TEXT="${BOX_W:+${BOX_W}px 宽 }${BOX_H:+${BOX_H}px 高 }以内${CAP_NOTE}"
else
  SIZE_TEXT="原始尺寸"
fi
ENCODE_TEXT=""
if (( TEXT_MODE == 0 )); then
  DITHER_TEXT="/无抖动"
  (( DITHER )) && DITHER_TEXT="/抖动（img2sixel 默认）"
  ENCODE_TEXT="，${COLORS} 色${DITHER_TEXT}，预算 ${BUDGET_KB}KB/s"
fi
printf 'vidcat: %s @ %s fps，输出 %s%s，边抽边播（Ctrl+C 退出）\n' \
  "$DURATION_TEXT" "$FPS" "$SIZE_TEXT" "$ENCODE_TEXT"

FFMPEG_ARGS=(-v error -nostdin -y)
# 4K/HEVC 软件解码是瓶颈时，跳过去块滤波能快约 20%
(( FAST_DECODE )) && FFMPEG_ARGS+=(-skip_loop_filter all)
# -ss 放在 -i 前面走快速定位，长视频不用从头解
[[ -n "$START" ]] && FFMPEG_ARGS+=(-ss "$START")
FFMPEG_ARGS+=(-i "$INPUT")
if (( UNLIMITED == 0 )); then
  FFMPEG_ARGS+=(-t "$DURATION")
fi
FFMPEG_ARGS+=(-vf "$FILTER" -frames:v "$MAX_FRAMES" "$TMPDIR_FRAMES/%06d.png")
ffmpeg "${FFMPEG_ARGS[@]}" 2>"$TMPDIR_FRAMES/ffmpeg.log" &
FFMPEG_PID=$!

# 进入播放状态
if (( INLINE )); then
  # 内联：另起一行开始画，不动屏幕内容和滚动区
  printf '\r\n\033[?25l'
else
  if (( USE_ALT )); then
    printf '\033[?1049h'
  fi
  printf '\033[2J\033[H\033[?25l'
  if (( TEXT_MODE == 0 && SIXEL_NOSCROLL )); then
    printf '\033[?80h'
  fi
fi

INTERVAL_MS="$(awk -v f="$FPS" 'BEGIN{printf "%d", (f > 0 ? 1000 / f : 0)}')"
TXT_SIZE="$((COLS - 1))x$((ROWS - 1))"

# sixel 编码参数：颜色数 + 是否抖动（抖动会让 run 数暴增，体积/解码量都翻倍）
IMG2SIXEL_ARGS=(-p "$COLORS")
(( DITHER )) || IMG2SIXEL_ARGS+=(-d none)
ENCODE_TMP="$TMPDIR_FRAMES/encode.six"
CUR_FPS="$FPS"
BYTES_SEEN=0
BYTES_SUM=0
BYTES_WARNED=0

# chafa ≥1.4 用 -f/--format 选输出格式，老版本（Ubuntu 20.04 的 1.2.1）没有该选项，
# 默认就是字符画输出，所以按 help 探测一次
CHAFA_ARGS=(-c 256)
if chafa --help 2>&1 | grep -q -- '--format'; then
  CHAFA_ARGS+=(-f symbols)
fi

ms_now() { date +%s%3N; }

sleep_ms() {
  local ms="$1"
  if (( ms >= 1000 )); then
    sleep "$((ms / 1000)).$(printf '%03d' $((ms % 1000)))"
  else
    sleep "0.$(printf '%03d' "$ms")"
  fi
}

frame_count() {
  local -a files=("$TMPDIR_FRAMES"/*.png)
  printf '%s' "${#files[@]}"
}

resume_ffmpeg() {
  if (( FFMPEG_STOPPED )); then
    kill -CONT "$FFMPEG_PID" 2>/dev/null || true
    FFMPEG_STOPPED=0
  fi
}

# 抽帧领先太多就挂起；剩余缓冲不足就提前续跑（不要等到一帧都没有才唤醒）
throttle_ffmpeg() {
  local produced
  produced="$(frame_count)"
  if (( FFMPEG_STOPPED )); then
    (( produced - $1 <= BACKLOG_MIN )) && resume_ffmpeg
    return 0
  fi
  if (( produced - $1 > BACKLOG_MAX )); then
    kill -STOP "$FFMPEG_PID" 2>/dev/null && FFMPEG_STOPPED=1 || true
  fi
}

# 等第 N 帧写完：ffmpeg 直接写目标文件，用 PNG 结束块 IEND 判断完整性，避免读到半个文件
wait_frame() {
  local path="$1"
  while :; do
    if [[ -s "$path" ]] && tail -c 12 "$path" 2>/dev/null | grep -q IEND; then
      return 0
    fi
    if ! kill -0 "$FFMPEG_PID" 2>/dev/null; then
      # ffmpeg 收工了，这一帧不会再有
      [[ -s "$path" ]] && tail -c 12 "$path" 2>/dev/null | grep -q IEND && return 0
      return 1
    fi
    sleep 0.02
  done
}

# 按实测字节数限制每秒负载：只降帧率，颜色始终按用户设置来（画质优先）
adapt_budget() {
  local bytes="$1" per_sec_kb fps_need
  (( BUDGET_KB > 0 && bytes > 0 )) || return 0
  per_sec_kb=$((bytes * CUR_FPS / 1024))
  (( per_sec_kb > BUDGET_KB )) || return 0
  fps_need=$((BUDGET_KB * 1024 / bytes))
  (( fps_need < 1 )) && fps_need=1
  (( fps_need >= CUR_FPS )) && return 0
  CUR_FPS="$fps_need"
  INTERVAL_MS="$(awk -v f="$CUR_FPS" 'BEGIN{printf "%d", 1000 / f}')"
  return 0
}

# 解码产帧速率跟不上目标帧率时，直接把帧率降到实测值：
# 这样是"稳定地慢"，而不是一帧快一帧停（后者体感就是卡）。
adapt_decode_rate() {
  local -a seen=("$@")
  local n=${#seen[@]}
  (( n >= 5 )) || return 0
  local span=$(( seen[n - 1] - seen[1] ))
  (( span > 0 )) || return 0
  local x10=$(( (n - 2) * 10000 / span ))    # 帧/秒 × 10
  local fps=$(( x10 / 10 ))
  (( fps < 1 )) && fps=1
  if (( x10 < CUR_FPS * 85 / 10 )); then
    (( fps >= CUR_FPS )) && return 0
    CUR_FPS="$fps"
    INTERVAL_MS="$(awk -v f="$CUR_FPS" 'BEGIN{printf "%d", 1000 / f}')"
  fi
  return 0
}

render_frame() {
  local path="$1"
  if (( TEXT_MODE )); then
    printf '\033[H'
    chafa "${CHAFA_ARGS[@]}" -s "$TXT_SIZE" -- "$path"
    return
  fi
  # 先编码到临时文件（便于量字节数做预算自适应），再整块写到终端
  if img2sixel "${IMG2SIXEL_ARGS[@]}" -o "$ENCODE_TMP" -- "$path" 2>/dev/null; then
    local bytes
    bytes=$(wc -c <"$ENCODE_TMP")
    BYTES_SEEN=$((BYTES_SEEN + 1))
    BYTES_SUM=$((BYTES_SUM + bytes))
    # 前几帧就够判断了，之后偶尔复核一次
    if (( BYTES_SEEN <= 3 || BYTES_SEEN % 30 == 0 )); then
      adapt_budget "$((BYTES_SUM / BYTES_SEEN))"
    fi
    cat "$ENCODE_TMP"
  else
    img2sixel "${IMG2SIXEL_ARGS[@]}" -- "$path"
  fi
}

frame_path() { printf '%s/%06d.png' "$TMPDIR_FRAMES" "$1"; }

play_once() {
  local i=0 path t0 dt rem
  local -a seen=()
  while :; do
    i=$((i + 1))
    path="$(frame_path "$i")"
    [[ -s "$path" ]] || resume_ffmpeg
    wait_frame "$path" || break
    # 前几帧的到达时刻用来估算"解码产帧速率"（第 1 帧含启动开销，丢掉）
    if (( i <= 7 )); then
      seen+=("$(ms_now)")
      (( i == 7 )) && adapt_decode_rate "${seen[@]}"
    fi
    if (( INLINE && i > 1 && INLINE_ROWS > 1 )); then
      printf '\033[%dA\r' "$((INLINE_ROWS - 1))"
    fi
    t0="$(ms_now)"
    (( INLINE )) && INLINE_MID=1
    render_frame "$path"
    if (( INLINE )); then INLINE_MID=0; INLINE_DREW=1; fi
    # 只把"渲染"计入耗时：等抽帧的时间不算，这样不会越播越快
    dt=$(( $(ms_now) - t0 ))
    rem=$(( INTERVAL_MS - dt ))
    (( rem > 0 )) && sleep_ms "$rem"
    throttle_ffmpeg "$i"
  done
  (( i > 1 ))
}

if ! play_once; then
  printf '\033[?80l\033[?25h\033[?1049l'
  echo "vidcat: 没有抽到任何帧，看看 ffmpeg 的报错：" >&2
  sed -n '1,5p' "$TMPDIR_FRAMES/ffmpeg.log" >&2 || true
  exit 1
fi

if (( INLINE )); then
  restore_terminal
fi

if (( LOOP )); then
  resume_ffmpeg
  wait "$FFMPEG_PID" 2>/dev/null || true
  FFMPEG_PID=""
  while :; do
    local -i n=0
    for path in "$TMPDIR_FRAMES"/*.png; do
      n=$((n + 1))
      throttle_ffmpeg 0
      if (( INLINE && n > 1 && INLINE_ROWS > 1 )); then
        printf '\033[%dA\r' "$((INLINE_ROWS - 1))"
      fi
      t0="$(ms_now)"
      (( INLINE )) && INLINE_MID=1
      render_frame "$path"
      if (( INLINE )); then INLINE_MID=0; INLINE_DREW=1; fi
      dt=$(( $(ms_now) - t0 ))
      rem=$(( INTERVAL_MS - dt ))
      (( rem > 0 )) && sleep_ms "$rem"
    done
  done
fi
