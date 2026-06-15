# ScreenRecord 开发手册

> 给冷启动的 Claude / 协作者看 — 30 秒掌握项目骨架与决策。

## 项目定位

**便携式 Windows 屏幕录制器**。U 盘解压即用、不写注册表、可在公司受限 PC 上运行。
核心卖点：浮动条 UI + 实时字幕烧录 + 录后字幕编辑器 + 多格式输出 + 单 exe 发布。

## 技术栈

- **Tauri 2** + **Rust 1.x**（后端、窗口、IPC、ffmpeg 子进程管理）
- **React 19** + **TypeScript** + **Vite 7**（前端 UI）
- **ffmpeg**（屏幕抓帧 + 编码 + 字幕烧录） — `release/ScreenRecord/ffmpeg.exe` (gyan.dev essentials_build, GPL, 含 ddagrab + libvpx-vp9 + libopus)
- **WebView2 Fixed Runtime**（嵌入到 `release/ScreenRecord/WebView2Runtime/`，应对没装 Edge 的机器）
- **架构**：v0.3.0 起为**单窗口 + React DOM pane 切换**（不再用多 webview）

## 关键文件路径

```
src/
  main.tsx              直接挂载 <App />，无路由
  App.tsx               pane 状态机：bar | settings | subtitle | windowPicker | subtitleEditor
  App.css               .float-bar / .float-pill / .panel-window / .se-* 编辑器样式
  Settings.tsx          v0.3.0 起未被引用（保留以备回滚）
  MiniBar.tsx           v0.3.0 起未被引用
  SubtitleWindow.tsx    v0.3.0 起未被引用
src-tauri/
  src/lib.rs            Tauri builder + invoke handlers 注册
  src/recorder.rs       录制核心：start / stop / add_subtitle / list_windows /
                         list_audio_devices / list_recordings /
                         burn_subtitles_to_video / import_srt
  capabilities/default.json   单窗口权限：core:window:allow-* + fs/dialog/shell/global-shortcut
  tauri.conf.json       主窗口 320×56、decorations:false、alwaysOnTop:true
  binaries/ffmpeg.exe   .gitignore 忽略；从 release/ 复制
release/ScreenRecord/   分发包目录（.gitignore 忽略）
  ScreenRecord.exe      构建产物（从 src-tauri/target/release/screen-record.exe 拷贝）
  ffmpeg.exe            分发用 ffmpeg（含 ddagrab + VP9 + Opus）
  WebView2Runtime/      嵌入运行时
  Recordings/           默认录制输出目录
  使用说明.txt          中文用户手册
build-tools/            wv2 嵌入相关脚本
```

## 核心数据结构（recorder.rs）

```rust
OutputFormat { Mp4, Mkv, Webm }          // v0.4.0 格式选择
RecordOptions {                           // 前端传给 start_recording
  output_dir, framerate, include_audio,
  audio_device: Option<String>,           // dshow 设备名
  capture_mode: { Screen, Window },
  window_title, show_cursor,
  output_format: OutputFormat,            // v0.4.0 新增
}
SubtitleEntry { start_ms, end_ms: Option<i64>, text }  // 录制中用 None，编辑器用 Some
SubtitleInput { start_ms, end_ms, text }               // 编辑器专用（end_ms 必填）
RecordingInfo { filename, path, size_bytes, modified }  // 录制文件列表
```

## 构建发布流程

```bash
# 开发
pnpm dev                              # vite + tauri dev
pnpm tauri dev                        # 完整 Tauri dev（含 Rust 编译）

# 发布构建
pnpm tsc --noEmit                     # 类型检查
pnpm tauri build --no-bundle          # 编译 release exe（不打 nsis 安装包）

# 拷贝到分发目录
cp src-tauri/target/release/screen-record.exe release/ScreenRecord/ScreenRecord.exe

# tag + push
git add ... && git commit -m "release(vX.Y.Z): ..."
git tag vX.Y.Z
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  git push origin main --tags

# GitHub Release（gh CLI，需带代理）
HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
  "/c/Program Files/GitHub CLI/gh.exe" release create vX.Y.Z \
    release/ScreenRecord-vX.Y.Z-lite.zip \
    --title "vX.Y.Z — ..." \
    --notes-file release/vX.Y.Z-notes.md
```

> **GitHub push 失败 → 提醒打开 Clash Verge VPN**（127.0.0.1:7897）。CLI 默认不走代理。
> **gh CLI** 安装在 `C:\Program Files\GitHub CLI\gh.exe`，不在 bash PATH 里，调用时需完整路径。

## 录制管道（v0.4.0）

**MP4/MKV 路径**：
```
ffmpeg -y
  -filter_complex "ddagrab=output_idx=0:framerate=N:draw_mouse=0|1,
                   hwdownload,format=bgra[,crop=W:H:X:Y]"
  [-f dshow -i audio=<device_name>]
  -c:v libx264 -preset superfast -tune zerolatency
  -pix_fmt yuv420p -crf 23 -threads 2
  [-c:a aac -b:a 128k]
  output.{mp4|mkv}
```

**WebM 路径**：
```
ffmpeg -y
  -filter_complex "ddagrab=..."
  [-f dshow -i audio=<device_name>]
  -c:v libvpx-vp9 -crf 30 -b:v 0 -threads 2
  [-c:a libopus -b:a 128k]
  output.webm
```

- ddagrab 是**滤镜**不是 demuxer，走 `-filter_complex`，**不带 `-i`**。
- libx264 不能直接吃 ddagrab 的 GPU BGRA → 必须 `hwdownload,format=bgra` 转回 CPU。
- WebM 不需 `-pix_fmt yuv420p`（libvpx-vp9 自行处理）；CRF 30 ≈ H.264 CRF 23。
- 音频设备：`audio_device: Option<String>`，None → fallback `virtual-audio-capturer`。
- 进程优先级 `BELOW_NORMAL_PRIORITY_CLASS`；`CREATE_NO_WINDOW` 隐藏黑窗。

**字幕烧录**：
- MP4/MKV: `-c:v libx264 -preset superfast -crf 23 -pix_fmt yuv420p -c:a copy`
- WebM: `-c:v libvpx-vp9 -crf 30 -b:v 0 -c:a libopus -b:a 128k`（AAC → Opus 重编码）

## 历次反复踩过的坑

1. **gdigrab 在 DWM/DirectX 应用上输出白屏** — 改成全屏 capture + crop（v0.2.2）。
2. **gdigrab 引发实时鼠标抖动** — CPU-path BitBlt 抢占 GPU 合成，治标各种参数无效，最终改 ddagrab 才根治（v0.3.0）。
3. **新建 WebviewWindow 静默失败** — Tauri 2 capabilities 没加 `core:webview` 权限。v0.3.0 直接放弃多窗口，改单窗口 + DOM pane。
4. **Tauri 2 的 PhysicalPosition vs LogicalPosition** — `outerPosition()` 返回物理像素；要还原必须用 `PhysicalPosition` 包装。
5. **ffmpeg subtitles 滤镜 Windows 路径**：必须把 `\` 替换成 `/`，并把 `:` 转义为 `\:`。

## 用户偏好（重要）

- 用户身份：双世界（理论 + 工程），核电工程师 / 虚空建筑师。
- **拒绝半截工作**、拒绝过度防御性编程、拒绝凭空创建文档。
- 输出：约束先行，能转化为 Z 轴套利振幅才算价值，否则 24 小时内清零。
- 工程类任务（核电/RCC-M/ASME）必须严谨零容错；数字/AI 任务可以"土法子调试"。
- 触发关键词：核电/力学/RCC-M/工艺 → 切换核电工程师模式（与本项目无关）。

## 安全硬约束

参见 `~/.claude/CLAUDE.md`。**绝对不读** `*.env` `*credentials*` `*secrets*` `*.key` `~/.claude/settings.json`。
验证字段存在用 `grep -c FIELD_NAME 文件`，验证非空用 `python -c "..."` 输出 True/False。
