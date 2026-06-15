# Changelog

所有版本变更记录。版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.4.0] — 2026-06-15

### 新功能

- **多输出格式**：录制输出支持 MP4 / MKV / WebM 三种容器格式。
  - MP4 / MKV：libx264 + AAC（与 v0.3.0 相同的编码参数）
  - WebM：libvpx-vp9 + libopus（web 友好，CRF 30 恒质量模式）
  - 字幕烧录自动匹配录制格式，WebM 格式下音频从 AAC 重编码为 Opus
  - 设置面板新增"输出格式"下拉框
- **音频设备选择**：录制音频不再硬编码 `virtual-audio-capturer`。
  - 新增 `list_audio_devices` 命令（解析 ffmpeg dshow 设备列表）
  - 设置面板"录制音频"开关下方新增设备下拉框（仅开启音频时显示）
  - 选中的设备名持久化到 localStorage，下次启动自动回显
- **录后字幕编辑器**：解决"一边录一边写字幕很困难"的问题。
  - 新增 `subtitleEditor` pane：选择录制文件 → 手动添加字幕条目（开始/结束时间+文本）→ 烧录
  - 支持导入 SRT 文件（UTF-8）
  - 新增 Tauri 命令：`list_recordings` / `burn_subtitles_to_video` / `import_srt`
  - `SubtitleEntry` 增加 `end_ms: Option<i64>`，实时字幕 `add_subtitle` 仍设为 None（向后兼容）
  - 设置面板底部增加"字幕编辑器"入口

### 基础设施

- 版本号 0.3.0 → 0.4.0（Cargo.toml / package.json / tauri.conf.json）
- gh CLI v2.94.0 安装完成，账号 `vincentmaox` 已登录
- v0.3.0 GitHub Release 已发布：https://github.com/vincentmaox/Screen-Record/releases/tag/v0.3.0

### 文件变更
- `src-tauri/src/recorder.rs`：新增 `OutputFormat` 枚举 / `RecordingInfo` / `SubtitleInput` struct；`start_recording` 格式感知编解码器；`burn_subtitles` 增加 `output_format` 参数；新增 4 个 Tauri 命令
- `src-tauri/src/lib.rs`：注册 4 个新命令
- `src/App.tsx`：新增 `subtitleEditor` pane；`OutputFormat` / `audioDevice` 持久化；格式/设备下拉框；编辑器完整 UI
- `src/App.css`：字幕编辑器全套样式（`.se-*`）

## [0.3.0] — 2026-06-13

### 重大架构变更
- **单窗口架构**：废弃 v0.2.x 的多 webview 方案（主窗口 + Settings + MiniBar + SubtitleWindow）。
  改为**唯一一个 Tauri 窗口** + React 内 `pane` 状态机（`bar` / `settings` / `subtitle` / `windowPicker`），
  通过 `getCurrentWindow().setSize(LogicalSize)` 动态调整窗口尺寸。
  - **原因**：v0.2.x 的设置/字幕按钮"点了没反应" — 根因是 `new WebviewWindow()` 在 Tauri 2 capabilities 不全时静默失败。
  - 顺带去掉了 `emit/listen` 事件总线，所有状态改成单进程内 React state。
- **抓帧后端从 gdigrab 切到 ddagrab**：
  - gdigrab 是 CPU-path BitBlt，繁忙系统下导致**实时屏幕鼠标抖**（OBS 不用它的原因）。
  - ddagrab 走 DXGI Desktop Duplication API（GPU-path，与 OBS 同机制）。
  - 滤镜链：`ddagrab=output_idx=0:framerate=N:draw_mouse=0|1,hwdownload,format=bgra[,crop=W:H:X:Y]`
  - 当前 `release/ScreenRecord/ffmpeg.exe`（gyan.dev essentials_build）已自带 ddagrab，**无需更换**。

### UI 体验
- 录制开始 → 浮动条**自动缩成 96×32 小药丸**（红点 + 计时），贴右上角（距右 12px、距顶 12px）。
- 鼠标 hover 药丸 → 展开回完整 bar；移开 → 缩回。
- 停止录制 → bar 恢复到录制前的原位置。
- 窗口默认尺寸：320×56（bar），460×600（settings/windowPicker），560×200（subtitle pane）。

### 已知/待办
- **窗口模式跟随移动**：当前是录制开始那一刻 snap 到窗口屏幕坐标后做 crop，窗口被拖动后 crop 区域不动。
  做"实时跟随"需要在 ffmpeg 进程外通过 zmq filter 或改造为 WGC API 抓帧。**推迟到 v0.4.0**。
- 用户 2026-06-13 报告的"窗口模式没反应"未确认根因（是录到全屏还是 UI 反馈不够）。

### 文件变更
- `src/App.tsx`：完整重写为 pane 状态机
- `src/main.tsx`：剥离 subtitle/minibar/settings 路由
- `src/App.css`：新增 `.panel-window` `.subtitle-input-large` `.float-pill` 等
- `src-tauri/src/recorder.rs`：`-f gdigrab -i desktop` → `-filter_complex ddagrab=...`
- `src-tauri/capabilities/default.json`：收缩到单窗口 + 显式 `core:window:allow-*` 权限
- `src-tauri/tauri.conf.json`：主窗口 320×56、`decorations:false`、`alwaysOnTop:true`
- `src/Settings.tsx` / `src/MiniBar.tsx` / `src/SubtitleWindow.tsx`：保留文件但已不被 main.tsx 引用

## [0.2.3] — 2026-06-12（git tag）
- 真正修复自动隐藏；缓解鼠标抖动（threads 限制 + BELOW_NORMAL 优先级）
- **后续证明 0.2.3 的抖动修复治标不治本，0.3.0 才是根治（gdigrab → ddagrab）**

## [0.2.2] — 2026-06
- 修窗口模式白屏（gdigrab title= 在 DWM 应用上失败）：改为 desktop capture + crop
- 修自动隐藏（minimize 移出 try/catch）
- 降低轮询频率 250ms → 1000ms

## [0.2.1] — 2026-06
- 内嵌 WebView2 Fixed Runtime（兼容离线/受限 PC）

## [0.2.0] — 2026-06
- 窗口捕获模式 + 自动隐藏主窗口 + 浮动 mini bar

## [0.1.0] — 2026-06
- 首版 scaffold，全屏录制 + 字幕烧录
