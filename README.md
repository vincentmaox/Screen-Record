# ScreenRecord

一个**小巧 · 便携 · 免安装**的 Windows 录屏软件 —— 点开即用，按钮一按即录，录制过程中支持快捷键一键插入字幕。

> 国内外主流录屏软件要么臃肿、要么强制安装、要么带水印、要么字幕功能孱弱。ScreenRecord 用一个 < 20MB 的便携 exe 把这四件事一次解决。

## 特性

- **真便携**：单 exe，免安装，可塞进 U 盘随处运行；首次运行不写注册表
- **录制即出片**：H.264 + AAC 封装 MP4，VLC / PotPlayer / Windows 自带播放器 / 浏览器全部能播
- **苹果风 UI**：SF 字体、毛玻璃浮窗、iOS 风开关、呼吸感留白
- **字幕速记**：录制中按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> 弹出毛玻璃浮窗，回车即写入时间戳，结束自动烧录到视频
- **零臃肿**：Tauri 2 + Rust 内核，启动 < 300ms，内存占用 < 80MB

## 技术栈

| 层 | 技术 |
|---|---|
| GUI 壳 | Tauri 2 (Rust + WebView2) |
| 前端 | React 19 + TypeScript + Vite 7 |
| 录屏内核 | FFmpeg (gdigrab + dshow + libx264 + aac) |
| 字幕 | SRT + FFmpeg subtitles filter |
| 全局热键 | tauri-plugin-global-shortcut |

## 使用前置

需要把 `ffmpeg.exe` 放到 `src-tauri/binaries/` 目录下（仓库已 gitignore，因为体积大）。开发环境：

```bash
# 下载 ffmpeg essentials build (推荐 BtbN/FFmpeg-Builds)
# https://github.com/BtbN/FFmpeg-Builds/releases
# 解压后将 ffmpeg.exe 复制到 src-tauri/binaries/ffmpeg.exe
```

发布版本时 ffmpeg.exe 通过 GitHub Releases 附件分发，避免仓库膨胀。

## 开发

```bash
pnpm install
pnpm tauri dev
```

## 打包

```bash
pnpm tauri build
```

产物位于 `src-tauri/target/release/`。

## 项目结构

```
.
├── src/                    # React 前端
│   ├── App.tsx             # 主窗口
│   ├── SubtitleWindow.tsx  # 字幕浮窗
│   └── App.css             # 苹果风样式
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs          # Tauri 入口
│   │   └── recorder.rs     # 录屏核心 (ffmpeg sidecar)
│   ├── binaries/           # 放 ffmpeg.exe (gitignored)
│   └── tauri.conf.json     # 窗口/打包配置
└── package.json
```

## 路线图

- [x] v0.1 MVP：录屏 + 字幕浮窗 + 苹果风 UI
- [ ] v0.2 区域录制（鼠标拖框选区）
- [ ] v0.3 摄像头画中画
- [ ] v0.4 录制后时间轴字幕编辑
- [ ] v0.5 GIF 导出
- [ ] v1.0 真正的单 exe 便携版 (NSIS portable mode)

## License

MIT © vincentmaox
