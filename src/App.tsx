import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { listen } from "@tauri-apps/api/event";

interface RecordingStatus {
  is_recording: boolean;
  output_path: string | null;
  elapsed_ms: number;
  subtitle_count: number;
}

interface WindowInfo {
  title: string;
  process_name: string;
}

type CaptureMode = "screen" | "window";

const SUBTITLE_HOTKEY = "CommandOrControl+Alt+S";
const STOP_HOTKEY = "CommandOrControl+Alt+R";

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function shortenPath(p: string, max = 36): string {
  if (p.length <= max) return p;
  const tail = p.slice(-(max - 3));
  return `…${tail}`;
}

export default function App() {
  const [status, setStatus] = useState<RecordingStatus>({
    is_recording: false,
    output_path: null,
    elapsed_ms: 0,
    subtitle_count: 0,
  });
  const [outputDir, setOutputDir] = useState<string>("");
  const [framerate, setFramerate] = useState(30);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [showCursor, setShowCursor] = useState(true);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("screen");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedWindow, setSelectedWindow] = useState<string>("");
  const [showWindowPicker, setShowWindowPicker] = useState(false);
  const [autoHide, setAutoHide] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const tickRef = useRef<number | null>(null);
  const stopRef = useRef<() => void>(() => {});

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  useEffect(() => {
    invoke<string>("default_output_dir").then(setOutputDir).catch(() => {});
  }, []);

  // Listen for stop request emitted by the mini bar.
  useEffect(() => {
    const unlistenPromise = listen("screenrec://stop", () => {
      stopRef.current();
    });
    return () => {
      unlistenPromise.then((un) => un());
    };
  }, []);

  useEffect(() => {
    if (!status.is_recording) {
      if (tickRef.current) window.clearInterval(tickRef.current);
      return;
    }
    tickRef.current = window.setInterval(async () => {
      try {
        const s = await invoke<RecordingStatus>("get_status");
        setStatus(s);
      } catch {}
    }, 1000);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [status.is_recording]);

  const refreshWindows = async () => {
    try {
      const list = await invoke<WindowInfo[]>("list_windows");
      // Filter out our own windows.
      const filtered = list.filter(
        (w) => !w.title.includes("ScreenRecord") && w.process_name.toLowerCase() !== "screenrecord.exe"
      );
      setWindows(filtered);
    } catch (e) {
      console.error(e);
    }
  };

  const openWindowPicker = async () => {
    await refreshWindows();
    setShowWindowPicker(true);
  };

  const openSubtitleWindow = async () => {
    const existing = await WebviewWindow.getByLabel("subtitle");
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return;
    }
    const win = new WebviewWindow("subtitle", {
      url: "index.html?window=subtitle",
      title: "Subtitle",
      width: 560,
      height: 180,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: true,
      center: false,
    });
    win.once("tauri://error", (e) => console.error("subtitle window error", e));
  };

  const openMiniBar = async () => {
    const existing = await WebviewWindow.getByLabel("minibar");
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return;
    }
    const win = new WebviewWindow("minibar", {
      url: "index.html?window=minibar",
      title: "Recording",
      width: 240,
      height: 56,
      decorations: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focus: false,
      x: 24,
      y: 24,
    });
    win.once("tauri://error", (e) => console.error("minibar error", e));
  };

  const registerHotkeys = async () => {
    try {
      await unregister(SUBTITLE_HOTKEY).catch(() => {});
      await unregister(STOP_HOTKEY).catch(() => {});
      await register(SUBTITLE_HOTKEY, async (e) => {
        if (e.state === "Pressed") await openSubtitleWindow();
      });
      await register(STOP_HOTKEY, async (e) => {
        if (e.state === "Pressed") await stop();
      });
    } catch (err) {
      console.warn("hotkey register failed", err);
    }
  };

  const start = async () => {
    if (!outputDir) {
      showToast("请先选择保存位置");
      return;
    }
    if (captureMode === "window" && !selectedWindow) {
      showToast("请先选择要录制的窗口");
      await openWindowPicker();
      return;
    }

    // 1) Start ffmpeg recording — this is the only critical step.
    try {
      await invoke("start_recording", {
        opts: {
          output_dir: outputDir,
          framerate,
          include_audio: includeAudio,
          audio_device: null,
          capture_mode: captureMode,
          window_title: captureMode === "window" ? selectedWindow : null,
          show_cursor: showCursor,
        },
      });
    } catch (e: any) {
      showToast(`启动失败: ${e}`);
      return;
    }

    // 2) Immediately hide main window so it stops covering the captured area.
    //    MUST happen before any optional step that could fail (registerHotkeys
    //    often throws on company PCs with global-shortcut group policies).
    if (autoHide) {
      try {
        await getCurrentWindow().hide();
        console.log("main window hidden");
      } catch (err) {
        console.error("hide failed", err);
      }
    }

    // 3) Everything after this is best-effort — hotkeys, mini-bar, status poll.
    try {
      await registerHotkeys();
    } catch (err) {
      console.warn("registerHotkeys failed", err);
    }

    try {
      await openMiniBar();
    } catch (err) {
      console.warn("openMiniBar failed", err);
    }

    try {
      const s = await invoke<RecordingStatus>("get_status");
      setStatus(s);
    } catch {}

    showToast("开始录制 · Ctrl+Alt+S 字幕 · Ctrl+Alt+R 停止");
  };

  const stop = async () => {
    try {
      const finalPath = await invoke<string>("stop_recording");
      await unregister(SUBTITLE_HOTKEY).catch(() => {});
      await unregister(STOP_HOTKEY).catch(() => {});
      const subWin = await WebviewWindow.getByLabel("subtitle");
      if (subWin) await subWin.close();
      const miniWin = await WebviewWindow.getByLabel("minibar");
      if (miniWin) await miniWin.close();

      // Restore main window (it was hidden via hide() during start).
      try {
        const w = getCurrentWindow();
        await w.show();
        await w.unminimize();
        await w.setFocus();
      } catch {}

      setStatus({ is_recording: false, output_path: finalPath, elapsed_ms: 0, subtitle_count: 0 });
      showToast(`已保存 · ${shortenPath(finalPath, 40)}`);
    } catch (e: any) {
      showToast(`保存失败: ${e}`);
    }
  };

  useEffect(() => {
    stopRef.current = stop;
  });

  const pickFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: outputDir || undefined,
    });
    if (typeof selected === "string") setOutputDir(selected);
  };

  const reveal = async () => {
    if (status.output_path) await invoke("reveal_in_explorer", { path: status.output_path });
  };

  const pickWindow = (title: string) => {
    setSelectedWindow(title);
    setCaptureMode("window");
    setShowWindowPicker(false);
  };

  const timerText = useMemo(() => formatTime(status.elapsed_ms), [status.elapsed_ms]);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand">
          <div className="brand-dot" />
          <div>
            <div className="brand-title">ScreenRecord</div>
            <div className="brand-subtitle">便携 · 极简 · 字幕速记</div>
          </div>
        </div>
        {status.subtitle_count > 0 && (
          <span className="chip">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 4h16v16H4V4zm2 6v2h12v-2H6zm0 4v2h8v-2H6z" />
            </svg>
            {status.subtitle_count}
          </span>
        )}
      </header>

      <div className="stage">
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div className={`timer ${status.is_recording ? "recording" : ""}`}>{timerText}</div>
          <div className="timer-label">{status.is_recording ? "REC" : "READY"}</div>
        </div>
        <button
          className={`record-btn ${status.is_recording ? "recording" : ""}`}
          onClick={status.is_recording ? stop : start}
          aria-label={status.is_recording ? "Stop" : "Start"}
        >
          <span className="record-btn-inner" />
        </button>
      </div>

      {/* Mode segmented control */}
      <div className="segmented">
        <button
          className={`seg-btn ${captureMode === "screen" ? "active" : ""}`}
          onClick={() => !status.is_recording && setCaptureMode("screen")}
          disabled={status.is_recording}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 4h18v12H3z" opacity=".25" /><path d="M3 4h18a1 1 0 011 1v11a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1zm0 2v10h18V6H3zm5 14h8v2H8z" />
          </svg>
          全屏
        </button>
        <button
          className={`seg-btn ${captureMode === "window" ? "active" : ""}`}
          onClick={() => !status.is_recording && (selectedWindow ? setCaptureMode("window") : openWindowPicker())}
          disabled={status.is_recording}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 5h16v3H4z" /><path d="M4 5h16v14H4z" opacity=".25" /><path d="M4 5h16a1 1 0 011 1v13a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm0 2v12h16V7H4z" />
          </svg>
          窗口
        </button>
      </div>

      <div className="card">
        {captureMode === "window" && (
          <div className="card-row">
            <div className="card-row-label">
              <span className="icon-bubble blue">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M4 5h16v14H4z"/></svg>
              </span>
              选择窗口
            </div>
            <span className="path-pill" onClick={openWindowPicker} title={selectedWindow}>
              {selectedWindow ? shortenPath(selectedWindow, 28) : "点击选择…"}
            </span>
          </div>
        )}
        <div className="card-row">
          <div className="card-row-label">
            <span className="icon-bubble blue">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h16v12H4z" opacity=".4"/><path d="M4 18h16v2H4z"/></svg>
            </span>
            帧率
          </div>
          <select
            className="select"
            value={framerate}
            onChange={(e) => setFramerate(Number(e.target.value))}
            disabled={status.is_recording}
          >
            <option value={24}>24 fps</option>
            <option value={30}>30 fps</option>
            <option value={60}>60 fps</option>
          </select>
        </div>
        <div className="card-row">
          <div className="card-row-label">
            <span className="icon-bubble orange">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2a3 3 0 00-3 3v6a3 3 0 006 0V5a3 3 0 00-3-3zm-7 9a7 7 0 0014 0h-2a5 5 0 01-10 0H5zm6 7h2v3h-2z"/></svg>
            </span>
            录制音频
          </div>
          <div
            className={`switch ${includeAudio ? "on" : ""}`}
            onClick={() => !status.is_recording && setIncludeAudio((v) => !v)}
            role="switch"
            aria-checked={includeAudio}
          />
        </div>
        <div className="card-row">
          <div className="card-row-label">
            <span className="icon-bubble orange">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 2l-3 8h2l-4 12h16l-4-12h2l-3-8h-6zm1 2h4l1.5 4h-7l1.5-4zm-1.5 6h9l3.5 10h-16l3.5-10z"/></svg>
            </span>
            录制鼠标
          </div>
          <div
            className={`switch ${showCursor ? "on" : ""}`}
            onClick={() => !status.is_recording && setShowCursor((v) => !v)}
            role="switch"
            aria-checked={showCursor}
          />
        </div>
        <div className="card-row">
          <div className="card-row-label">
            <span className="icon-bubble green">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M19 13H5v-2h14v2zm0-4H5V7h14v2z"/></svg>
            </span>
            开始时隐藏窗口
          </div>
          <div
            className={`switch ${autoHide ? "on" : ""}`}
            onClick={() => !status.is_recording && setAutoHide((v) => !v)}
            role="switch"
            aria-checked={autoHide}
          />
        </div>
        <div className="card-row">
          <div className="card-row-label">
            <span className="icon-bubble purple">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4a2 2 0 00-2 2v12a2 2 0 002 2h16a2 2 0 002-2V8a2 2 0 00-2-2h-8l-2-2z"/></svg>
            </span>
            保存位置
          </div>
          <span className="path-pill" onClick={pickFolder} title={outputDir}>
            {outputDir ? shortenPath(outputDir, 32) : "选择文件夹"}
          </span>
        </div>
        {status.output_path && !status.is_recording && (
          <div className="card-row">
            <div className="card-row-label">
              <span className="icon-bubble green">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              </span>
              最近输出
            </div>
            <span className="path-pill" onClick={reveal} title={status.output_path}>
              {shortenPath(status.output_path, 32)}
            </span>
          </div>
        )}
      </div>

      <div className="hint">
        <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> 字幕 ·{" "}
        <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>R</kbd> 停止录制
      </div>

      {/* Window picker modal */}
      {showWindowPicker && (
        <div className="modal-backdrop" onClick={() => setShowWindowPicker(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>选择窗口</span>
              <button className="icon-btn" onClick={refreshWindows} title="刷新">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M17.65 6.35A7.95 7.95 0 0012 4a8 8 0 108 8h-2a6 6 0 11-1.76-4.24L13 11h7V4l-2.35 2.35z" />
                </svg>
              </button>
            </div>
            <div className="window-list">
              {windows.length === 0 ? (
                <div className="window-empty">未发现可录制窗口，点击右上角刷新</div>
              ) : (
                windows.map((w) => (
                  <button
                    key={w.title}
                    className={`window-item ${selectedWindow === w.title ? "active" : ""}`}
                    onClick={() => pickWindow(w.title)}
                    title={w.title}
                  >
                    <div className="window-item-title">{w.title}</div>
                    <div className="window-item-proc">{w.process_name}</div>
                  </button>
                ))
              )}
            </div>
            <div className="modal-footer">
              <button className="btn btn-ghost-light" onClick={() => setShowWindowPicker(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
