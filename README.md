# Browser Terminal

基于 **node-pty** 与 **xterm.js** 的浏览器终端：顶部标签页，下方为可分割的终端窗口。

## 快捷键

| 快捷键 | 作用 |
|--------|------|
| Alt + → / ← / ↓ / ↑ | 在当前窗口右 / 左 / 下 / 上分割 |
| Alt + Backspace | 关闭当前窗口（至少保留一个窗口；关闭后焦点回到第一个窗口） |
| 进程结束后 Enter | 重新连接当前窗口 |
| 进程结束后 Esc | 关闭当前窗口 |
| Alt + Q | 在同标签页内切换窗口（Shift + Alt + Q 反向） |
| 双击标签 | 重命名标签 |
| 标签右侧 × | 关闭标签 |

标签页、分割布局与终端会话在**服务端共享**：多台设备/浏览器打开同一地址时会实时同步（布局、窗口大小、终端输入输出）。状态保存在服务器 `.run/shared-app-state.json`。

分割线可拖动以调整相邻窗口大小。

## 脚本运行（推荐）

服务默认绑定 **0.0.0.0**，并默认启用 **HTTPS**（自签名证书，WebSocket 为 WSS）。首次 `run.sh start` 会自动生成 `certs/` 下证书；浏览器首次访问需接受安全提示。

`run.sh start` 会打印 `https://localhost:...` 与本机局域网 IP 地址。

```bash
chmod +x build.sh run.sh scripts/gen-cert.sh
./build.sh              # 编译前端（首次会 npm install）
./run.sh start          # 生产模式，https://…:3000
./run.sh start dev      # 开发：https://…:5173 + 后端 :3000
./run.sh stop
./run.sh restart
./run.sh status
```

- 关闭 HTTPS：`HTTPS=0 ./run.sh start`
- 局域网 IP 变更后：`./scripts/gen-cert.sh` 然后 `./run.sh restart`

## 访问密码

首次 `./run.sh start` 若未设置 `ACCESS_PASSWORD`，会自动生成密码并写入项目根目录 `.access_password`（启动日志也会打印一次）。

打开页面需先输入密码；验证成功后写入 **HttpOnly Cookie**（默认约 30 天），同一浏览器下次打开可自动登录。

## SSH 远程终端

登录后 **⚙ 设置** 配置 SSH；标签栏 **+** 选择本地或 SSH 目标。凭据保存在本机 `.run/ssh-profiles.json`。

## 终端内看图

终端已加载 `@xterm/addon-image`，可直接在窗口内渲染图片，支持两种协议：

- **SIXEL**（`\x1bP...q`），工具：`img2sixel file.png`、`chafa -f sixel file.png`（chafa ≥ 1.4 才支持 sixel 输出）、`timg -p sixel file.png`
- **iTerm2 内联图片协议**（OSC 1337），工具：仓库自带 `scripts/imgcat.sh`（无依赖，可直接 scp 到远端主机使用）

```bash
imgcat demo.png             # 仓库自带脚本；./scripts/imgcat.sh 亦可，本机已装到 /usr/local/bin
imgcat -w 50% demo.png      # 宽度取终端宽度的 50%，也支持 -H 高度、Npx、auto
cat demo.png | imgcat -     # 从标准输入读取
imgcat a.png b.png          # 多张自动垂直堆叠（每张后补换行，文字/下一张不会压在图片底边上）
img2sixel demo.png          # SIXEL 路线（需 libsixel-bin）
chafa -f symbols demo.png   # 纯文字彩色预览，任何终端都行
```

终端里的网址默认**可点击**（`@xterm/addon-web-links`），点一下会在新标签页打开。

限制：图片只随输出流实时渲染，**重新连接时由服务端 scrollback 回放**，超大序列可能被 scrollback 体积上限截断而丢失；单图上限为 16M 像素、IIP/SIXEL 序列各 20MB/25MB；Kitty graphics 协议不支持。

## 播放视频/音频（`vidopen`，新开页面）

终端协议放不了视频，所以 `vidopen` 不在终端里画，而是像 `cs` 打开 code-server 一样**新开一个浏览器页面**播放：

```bash
vidopen demo.mp4              # 仓库自带脚本；./scripts/vidopen.sh 亦可，本机已装到 /usr/local/bin
vidopen ~/Movies/a.mkv        # 支持 ~ 和相对路径
```

- 页面地址是 `/video/<一次性 id>`（2 小时有效），页面里的 `<video>/<audio>` 走 `/api/video`（**HTTP Range**，可拖进度条），解码/声音/全屏全部交给浏览器，服务器 CPU 不参与。
- 只能在**本机**窗口里用（要读本机文件）；SSH 窗口会提示暂不支持。
- 可播后缀：`mp4 m4v webm ogv mov mkv mp3 m4a aac wav flac oga gif`（接口只放行这些，避免变成通用文件读取口，且需登录）。
- **编码取决于浏览器**：Chrome/Edge/Safari 的 H.264 MP4、VP9/WebM 都可以；纯 Chromium 或未装系统解码器的 Firefox 播不了 H.264，这种情况用 WebM 最稳：
  `ffmpeg -i in.mp4 -c:v libvpx-vp9 -b:v 400k -c:a libopus out.webm`

## 终端内逐帧播放（`vidcat`，不新开页面）

就想在终端里看"像素"（不新开页面），可以用 `vidcat`：ffmpeg 抽帧 → `img2sixel` 编码 → 逐帧刷进终端（`\x1b[?80h` 让每帧覆盖同一位置，走备用屏，退出自动恢复）。实测吞吐上限约 0.8–0.9 MB/s：

| 画面 | 每帧 | 实测帧率 |
|---|---|---|
| 160×120 简单 | ~5 KB | ≥19 fps |
| 160×120 复杂 | ~31 KB | ~29 fps |
| 320×240 复杂 | ~88 KB | ~9 fps |

```bash
vidcat demo.mp4                     # 默认内联：整段实时边取边播 / 10fps / ≤窗口宽高 80% 且 宽*高 ≤ 10 万 / 256 色 + 抖动
vidcat --fit 50 demo.mp4                         # 画面缩到窗口的 50%
vidcat --colors 32 --no-dither demo.mp4          # 卡的时候：体积/解码量降到约 1/3
vidcat --colors 16 --max-pixels 30000 demo.mp4   # 更省：颜色和像素都再降一档
vidcat --proxy 4k.mp4               # 4K/HEVC 源：先转小代理再播（同参数自动复用）
vidcat --proxy /tmp/p.mp4 --fast-decode 4k.mp4   # 指定代理路径 + 跳过去块滤波
vidcat --max-pixels 60000 demo.mp4               # 把像素上限收紧到 6 万（默认 10 万；0 = 不限）
vidcat --max-pixels 0 --fit 100 demo.mp4         # 放开两个限制：占满窗口
vidcat --start 60 --duration 10 demo.mp4         # 只看第 60 秒起的 10 秒（默认整段）
vidcat --full --fps 8 demo.mp4      # 整段播放（3000 帧兜底）
vidcat --text demo.mp4              # chafa 字符画模式（不需要 sixel 支持）
vidcat --fullscreen demo.mp4        # 旧画法：备用屏 + 关滚动，每帧覆盖视口左上角
```

**两种播放位置**（默认内联）：

| 模式 | 画在哪 | 终端内容 | 播完 |
|---|---|---|---|
| `--inline`（默认） | 命令行的**下一行**起，每帧把光标移回同一位置重画 | 命令、输出、滚动历史都保留 | 最后一帧留在原地，提示符在它下面（Ctrl+C 中断也一样） |
| `--fullscreen` | **视口左上角**（备用屏 + `\x1b[?80h` 关滚动） | 被备用屏盖住 | 回到原来的屏幕，帧不保留 |

内联模式实测：画面落在 y=60px（第 3 行往下），高度正好一帧（183px，不会一帧帧往下堆），上方的 `BEFORE_MARKER`、`vidcat` 命令行文字都还在。

> 关于"文字压在画面底边"：`@xterm/addon-image` 用的是 VT340 语义——画完图光标停在**图片最后一行**，所以调用方要自己补换行。`imgcat` 每张图后补 `\n`；`vidcat --inline` 在正常结束和 Ctrl+C 中断时都会把光标移到画面块之外（若中断发生在帧写到一半、六色序列被丢弃，光标还在块顶行，会额外下移 `行数-1`）。实测四种情形 `NEXT_MARKER` 都落在画面下方：imgcat 单图（图 0–199px / 文字 200px）、imgcat 两张（0–319 / 320）、vidcat 正常结束（40–222 / 300）、vidcat Ctrl+C（222 / 360）。

| 尺寸 | 颜色 | 每帧 | 服务端编码 | 实测帧率 |
|---|---|---|---|---|
| **421×237（现默认）** | 256 色 + 抖动 | **72 KB** | ~35 ms | **9.2 fps**（p50=109ms） |
| 421×237（现默认） | 32 色无抖动 | 24 KB | ~12 ms | 预算内，10fps |
| 868×488（`--fit 100 --max-pixels 0`） | 256 色 + 抖动 | 212 KB | 102 ms | 6.7 fps |
| 868×488 | 32 色无抖动 | 81 KB | 32 ms | — |
| 326×183（旧默认） | 256 色 + 抖动 | 57 KB | ~20 ms | 10 fps |

卡不卡有两个独立瓶颈，脚本都会自己实测并在画面上提示。

**瓶颈一：每秒六色负载（客户端解码量）。** 不是像素数或帧率，而是字节/秒。同一 326×183 分辨率下，画面越复杂每帧字节越多（实测同一视频不同片段 31KB–60KB/帧），而 256 色 + 抖动会让颜色 run 数暴涨，是浏览器端每帧几百毫秒长阻塞的主要来源：

| 设置（326×183，重场景） | 字节/帧 | 10fps 负载 | 浏览器端长阻塞 |
|---|---|---|---|
| **256 色 + 抖动（默认，画质优先）** | 56.9 KB | 555 KB/s | 4 次 / 最大 592ms |
| 32 色 + 无抖动（`--colors 32 --no-dither`） | 18.7 KB | 182 KB/s | 1 次 / 最大 182ms |
| 16 色 + 无抖动 | 12.4 KB | 121 KB/s | 1 次 |

**默认尺寸**：两道限制同时生效，等比适配后取更小的那个——① 窗口宽/高的 **80%** 以内（`--fit N` 可调，`--fit 100` = 占满窗口）；② **宽 × 高 ≤ 100000**（`--max-pixels N`，`0` = 不限）。

以 1085×620 的窗口为例：80% 框 = 868×496，16:9 适配得 868×488，再被 10 万像素上限压到 **421×237（99777 px）**——实测渲染出来正好是 421×237、比例不变。

默认保持 img2sixel 原生的 **256 色 + 抖动**，画面最好看。`--colors` / `--no-dither` 完全由你显式控制；`--budget`（默认 400KB/s）只管**帧率**——超预算降帧，**不会背着你改颜色**。

尺寸放大会同时推高单帧字节和编码/解码耗时（同一段 1080p 内容，窗口 1085×620 的 80% = 868×488 ≈ 42 万像素）：

**瓶颈二：服务端解码速度（4K / HEVC 尤其致命）。** `vidcat` 是**服务端软件解码**，4K HEVC 在弱 CPU 上直接顶死。实测 `/root/aa/web/1.mp4`（3840×2160 / 30fps / 54Mbps HEVC）在 2 核 Celeron J3355、容器内无 `/dev/dri`（无硬件解码）的机器上：

| 场景 | 结果 |
|---|---|
| 纯解码 5 秒源视频 | **17.5 s**（≈8.6 源帧/秒）→ 10fps 输出最多 ≈2.5 帧/秒 |
| 直读 4K（默认） | 首帧 5.2s，帧间隔 **419–509ms**（≈2 帧/秒） |
| `--proxy`（代理已生成） | 首帧 **0.38s**，帧间隔 **109ms（=10fps）** |
| 同样帧预先抽好再放（无 ffmpeg 竞争） | 帧间隔 **100ms（=10fps）**，边抽边播则掉到 ~230ms |

- 脚本会实测解码产帧速率，跟不上就把帧率降到实测值（**稳定地慢**，而不是一顿一顿）；负载超预算也只降帧率。**两种自适应都是静默的**。
- **整个播放过程只有开头一行信息**：降帧、代理转码/复用、结束建议都不再打印（`--proxy` 首次转码期间屏幕上会完全没动静，长片可能持续几分钟，中途 `Ctrl+C` 可中断；用 `time` 或另开窗口看 `ffmpeg` 进程可判断进度）。
- `--proxy [文件]`：**代理素材**（video editing 里的 proxy media）——先把要播的片段转成一个又小又好解的替身文件（x264 / 宽度按输出尺寸）再逐帧播，抽帧就从小文件读，弱 CPU 上也能稳定帧率。实测 4 秒 4K 片段：首次 24.7s（其中 18s 是解码原片），之后复用代理 5.8s。默认放 `/tmp/vidcat-proxy-<hash>.mp4`，同参数下次自动复用；想换位置就 `--proxy /path/p.mp4`。
- `--fast-decode`：跳过去块滤波，解码快约 **20%**（实测 18.2s → 14.4s），画面略有块效应。
- 这台机器只有 2 核，ffmpeg 抽帧/编码会和浏览器渲染抢 CPU：同样内容"预抽好再放"是 10fps，"边抽边播"可能掉到 4fps。
- **重视频请直接用 `vidopen`**：`vidopen /root/aa/web/1.mp4`。那条路服务端只做 HTTP Range 取流，**4K HEVC 交给浏览器/客户端解码**，服务器 CPU 不参与，这才是真流畅（60fps、有声音、可拖进度条）。
- **整段实时边取边播**（默认）：第一帧一就绪就开始放，`Ctrl+C` 随时停；只想看一段就 `--duration S`。为避免长视频一路抽到底白占 CPU/磁盘，带**抽帧背压**：领先播放超过 60 帧就 `SIGSTOP` ffmpeg，缓冲降到 15 帧再续跑（`--max-frames` 默认 3000 帧兜底；被挂起的进程要先 `SIGCONT` 才能收到 `Ctrl+C` 的终止信号，脚本已处理）。
- 无声音、不能 seek；播放中 `Ctrl+C` 退出并恢复终端状态（后台 ffmpeg 一并收掉）。
- 需要 `ffmpeg` + `img2sixel`（`apt install ffmpeg libsixel-bin`）+ `ffprobe`；`--text` 模式只需 `chafa`。

## 服务管理（嵌入）

终端里还有 **`cs`** 命令：在**本机**窗口里执行 `cs`（或 `cs <目录>`、`cs <文件>`），会让 code-server 直接打开该窗口的当前目录（跟文件时打开其所在目录并用 `payload` 参数定位到该文件），浏览器自动弹出对应标签页；凭据由服务端注入到窗口环境（`BT_APP_URL` / `BT_CODE_TOKEN` / `BT_PANE_ID`），仅本机窗口可用，SSH 窗口请用 `</>` 按钮。

终端里用 **`cs`** 命令打开 code-server：在**本机**窗口里执行 `cs`（或 `cs <目录>`），会让 code-server 直接打开该窗口的当前目录，浏览器自动弹出对应标签页；凭据由服务端注入到窗口环境（`BT_APP_URL` / `BT_CODE_TOKEN` / `BT_PANE_ID`），仅本机窗口可用。本机同样直接起 code-server；SSH 设备则在远端起 code-server 并 `ssh -L` 转发回来，统一经本服务同一个 HTTPS 端口的 `/code/<设备>/` 反代（复用登录 cookie）。插件市场固定为 **Open VSX**。远端需要先装 code-server（`curl -fsSL https://code-server.dev/install.sh | sh`）；闲置一小时会自动回收实例。日志在 `.run/code-server/<设备>/code-server.log`。

仓库里的 `bin/` 放着 `imgcat` / `vidcat` / `vidopen` / `cs` 的符号链接，本机终端会话启动时会把该目录加到 `PATH` 最前面，所以这些命令在窗口里直接可用。SSH 窗口则在首次连接时把这些脚本同步到远端 `~/.browser_terminal/bin/`（校验和相同就跳过），并通过会话启动命令 + shell 启动文件把该目录加进远端 `PATH`。

### download（把文件下载到浏览器）

在**本机**窗口里执行：

```bash
download a.tar.gz            # 单个文件直接下载
download some-dir/           # 目录打包成 tar.gz
download a.log b.csv         # 多个文件打包成 tar.gz
```

原理：CLI 向终端打印一个 OSC 1339 控制序列（base64 JSON），浏览器端终端解析后带登录态调用 `/api/dl/prepare`；服务端按窗口类型取文件（本机直接读，SSH 窗口用 ssh 把远端文件 / `tar -czf -` 的打包流回传），再由页面触发下载（`Content-Disposition: attachment`）。

- **命令会等下载结束才退出**，并实时显示进度：`下载中 35.3 MB / 150.0 MB  23%`，完成后打印 `download: 完成  150.0 MB（用时 9s）`；失败则红字报错；
- 进度是浏览器把状态行写回该窗口的 stdin（期间 `stty -echo`，不会显示成输入）；
- 远端脚本（`~/.browser_terminal/bin/download`）会在打开 SSH 窗口时自动同步（同一配置 60 秒内只检查一次，校验和不同才上传），所以更新命令后重开窗口即可；
- **下载途中按 Ctrl+C 可取消**：会中断服务端的数据流（浏览器里的下载显示被中断），终端打印 `download: 已取消（已下载 X）` 并立刻回到提示符；
- 下载链接 30 分钟内有效，用过或过期即失效；
- 本机 / SSH 窗口都支持，SSH 窗口无需远端有 curl 也能用（走已有 SSH 连接 + 浏览器）。

### upload（把浏览器里的文件传到服务器）

在**本机或 SSH** 窗口里执行：

```bash
upload                 # 执行后把文件拖进终端窗口（可多次拖入），Ctrl+C 结束
```

执行后**把文件拖进终端窗口**即可（不弹系统文件框，避免个别环境里对话框跑到左上角/鼠标指针消失）；可以多次拖入，按 Ctrl+C 结束。终端里显示进度：

```
~ $ upload
upload: 把文件拖进终端窗口即可上传到 /root/xx（可多次拖入，Ctrl+C 结束）
上传中 5.2 MB / 12.0 MB  43%  a.png
已上传  2 个文件 a.png b.bin（12.0 MB）
upload: 结束  本次共上传 2 个文件，12.0 MB
```

- 拖拽时窗口边框变绿色虚线；同名文件会被覆盖；按 **Ctrl+C** 结束（会中断当前文件并删掉半成品）；
- 远端脚本随窗口打开自动同步（同一配置 60 秒内检查一次）；
- 如果部署在 nginx 后面，记得放开上传体积（默认 1 MB 会直接 413）：
  ```nginx
  location /myterminal/ { client_max_body_size 1024m; ... }
  location /myterminal/svc/ { client_max_body_size 1024m; ... }
  ```

### 无头浏览器（服务端浏览器，出口 IP 就是服务器）

标签栏 **🌐**（反代按钮左边）直接打开**新页面**（`/browser?w=1280&h=720`，默认 1280×720），里面是一台跑在**服务器上**的 Chromium（主界面没有额外菜单/浮层）：

- 工具栏右侧：**⚙ 设置** 和关闭；设置弹框里改**设备模式 / 分辨率 / 显示方式（平铺·原始像素）/ 画质**，改完点**确定**才生效（取消则不生效）；
- 分辨率预设：1920×1080、1440×900、1280×720、1024×768、800×600、640×480，以及「自定义…」（填宽高）；手机：430×932、414×896、390×844、375×667、360×640；

- 页面上「×」左边有两个显示模式按钮：**平铺**（缩放到窗口，铺满可视区）和**原始像素**（按所选分辨率 1:1 显示、不缩放不模糊，周围留黑边，视口比窗口大时可滚动）；鼠标坐标两种模式下都按实际绘制区域（缩放+黑边偏移）换算，不会偏移；模式记在 localStorage
- 工具栏还有两个下拉，**运行中也能改**：**分辨率**（`resize`：改远端设备尺寸 + 重启 screencast + 补快照）和**画质**（自动/流畅 70/标准 85/高清 95；自动 = 原始像素 95、平铺 85）
- 工具栏「**手机模式 / 电脑模式**」下拉：手机模式 = `mobile: true` + 触摸模拟 + Android Chrome UA + 390×844，切电脑模式回到 1280×720 桌面 UA；同时分辨率也是 ≤500 自动进手机模式；
- Chrome 窗口固定开到 2560×1600：screencast 不会超过窗口表面尺寸，1920×1080、手机 2x 帧都是原尺寸（之前会被缩小发虚）

- 刷新浏览器页面会接回原会话（sessionStorage 记录会话 id）；直接关掉页面后会话在 60s 掉线宽限后释放；
- 画面通过 CDP `Page.startScreencast`（JPEG，静止时不发帧）实时回传，鼠标/键盘/滚轮直接注入；拖动（框选文字、拖滑块）时 `mouseMoved` 必须带 `button: left` + `buttons: 1`，否则 Chrome 只当悬停；
- 顶部有两行：**标签页**（弹窗/新窗口自动变成标签页，可点击切换、× 关闭、+ 新建）和工具栏（← → ⟳、地址栏、分辨率、关闭）；
- 点按钮打开的新窗口会作为新标签页保留，随时可以切回原来的页面；
- **出口 IP = 服务器 IP**（实测 `myip.ipip.net` 显示服务器地址），页面里的 JS/CDN 请求也一样；
- 页面触发的下载会**自动转成你的浏览器下载**（服务端先落盘，再走 `dl/<id>`）；
- **会话 vs 标签页**：一次「浏览器」窗口 = 一个会话（一个独立的无头 Chromium 进程 + 独立 cookie/登录态）；同一个会话里开的多个标签页**共用**这个会话（共享 cookie、共享进程）；不同设备/不同 app 标签页各开一个会话；
- 默认最多 **3 个会话**，可在「设置 → 浏览器会话」里改（1–8）；每个会话里标签页数不限（建议别超过 10 个）；空闲 15 分钟自动关闭；
- **声音**：工具栏 🔊 开关（会记住偏好）。Chrome 输出到 PulseAudio 的 per-session null sink，服务端用 ffmpeg 录 `bt_<会话>.monitor` 编码成 WebM/Opus 经 WebSocket 二进制帧推给前端，用 MediaSource 播放（延迟约 0.3–0.6s，~48kbps）；依赖 `pulseaudio`/`pactl`/`ffmpeg`，缺失时音频不可用、其它功能不受影响；
- 浏览器可执行文件优先级：`BT_CHROME` 环境变量 → **官方 Google Chrome**（`/opt/google/chrome/chrome`，自带 H.264/AAC，能播 MP4）→ playwright 缓存的 Chromium → 系统 chromium/google-chrome；
- 只有开源 Chromium 构建时 MP4 放不了（无 H.264/AAC 解码器），需要 `apt-get install ./google-chrome-stable_current_amd64.deb`；本机已装 Chrome 156；
- 找不到浏览器时，点 🌐 会弹出「未找到浏览器」指引：给出下载地址、可复制的安装命令、以及已查找过的路径；
- 运维开关 `BT_BROWSER_DISABLE=1` 可禁用无头浏览器（同样会弹安装指引）；
- 无头浏览器**没有声音**（画面走 CDP screencast，只有视频帧）；要听声音请用 `vidopen` 或 `/video/<id>` 在自己浏览器里播放。

### 反代（把本机端口映射成一个路径）

标签栏里 **⇄**（服务管理左边）打开反代弹窗：**添加反代** 填「名称 / 路径名 / 目标 IP / 端口 / 协议 / 打开路径」，保存后即可通过

```
https://ccnto.x3322.net:6789/myterminal/svc/<路径名>/
```

访问该端口上的 Web 服务（例如 `stock` → `127.0.0.1:9998`、`token-meter` → `127.0.0.1:9999`）。要点：

- 目标地址显示时会省略默认端口（http 80 / https 443）；
- 反代由 **browser-terminal 自己实现**（`/svc/<路径名>/` 前缀，剥离后转发），**nginx 不需要新增 location**，继续用现有的 `/myterminal/` 即可；
- **必须已登录** browser-terminal 才能访问（复用登录 cookie，未登录返回 401 提示页）；
- 路径名只允许单段（小写字母/数字/短横线）；如果应用的页面在子路径（例如 `token-meter` 的后台在 `/admin`），用「打开路径」填 `/admin`，打开按钮会直接跳到 `/svc/token-meter/admin`；
- 目标可以是任意 `IP:端口`（本机、局域网或你先建好的隧道出口都行）；协议支持 http/https（https 自签会跳过校验）；
- 支持 WebSocket；若上游用 WS，nginx 的 `/myterminal/` location 需要带 `Upgrade` / `Connection` 头；
- **nginx 注意**：如果 `/myterminal/` 那个 location 用了 `sub_filter` 改写响应体（把 `"/api/` 改成 `"/myterminal/api/` 之类），必须再给反代加一个**不做改写**的 location，否则上游应用里的路径也会被改写（例如 dsh web 的 WebSocket 会变成 `/svc/dsh/myterminal/api/remote.mux` 而连不上）：
  ```nginx
  location /myterminal/svc/ {
      proxy_pass https://127.0.0.1:3000/svc/;
      proxy_ssl_verify off;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_read_timeout 999600s;
      proxy_send_timeout 999600s;
      proxy_buffering off;
  }
  ```
- 反代会**去掉** `X-Forwarded-For` / `X-Real-IP` / `Forwarded` / `True-Client-IP` / `CF-Connecting-IP` 等"客户端来源"头，让上游看到的是本机/服务器地址（否则 ip.cn 这类站点会显示浏览器 IP）。注意：页面若用 JS 去请求**别家域名**（如 ip.cn 的 `my.ip.cn/json`），那个请求是浏览器直发的，反代管不到；
- 反代会把请求的 `Origin` 头**对齐到上游地址**（有些应用会校验 Origin 与 Host 同源，比如 dsh web，否则 HTTP/WS 都会被判 403）；
- 上游应用若使用**绝对路径**（`/static`、`/api`）会指到域名根，需要在应用侧配置 base path，或改用端口直连（`stock` / `token-meter` 都是相对路径，可直接用）；
- 「打开」按当前页面路径拼链接（`/myterminal/svc/<路径名>/`），新标签页打开；目标没启动时显示 502 提示页。

标签栏 **▣** 打开服务管理弹窗。左侧按目标设备分页签（**本机** + 设置里的每台 SSH 设备，标签竖向多行、超高自动折列，带 `运行中/总数` 计数），每个页签只显示该目标的服务；**服务名在同一设备内唯一，不同设备可以重名**（比如小米和本机都能叫 `cloudflared`）；在某个页签下点「新建服务」会默认建到那台设备上。后端代码在 **`server/service-manager/`**，数据（SQLite、日志）在仓库根目录 **`data/`**（已 gitignore）。

若曾使用外部 Service Manager，可把原 `data/` 目录复制到本仓库根目录后重启。也可通过 `SM_ROOT` 指定数据根路径（其下需有 `data/` 子目录）：

```bash
export SM_ROOT=/path/to/browser-terminal
./run.sh restart
```

## 结构

- `server/` — Express + WebSocket + node-pty，SSH，嵌入服务管理（`/api/sm/*`，实现见 `server/service-manager/`），媒体取流 `/api/video`（`server/video-routes.ts`）
- `client/` — Vite + xterm.js；终端插件：`@xterm/addon-image`（看图）与 `client/src/video-overlay.ts`（OSC 9998 视频叠加层）
- `scripts/` — `imgcat.sh`（iTerm2 内联图）、`vidopen.sh`（新页面播放音视频）、`vidcat.sh`（逐帧 sixel / 字符画播放）、`cs.sh`（当前目录打开 code-server）、证书脚本
