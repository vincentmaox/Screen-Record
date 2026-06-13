import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow, LogicalSize, PhysicalPosition, currentMonitor } from "@tauri-apps/api/window";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";

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
type Pane = "bar" | "settings" | "subtitle" | "windowPicker";

const SUBTITLE_HOTKEY = "CommandOrControl+Alt+S";
const STOP_HOTKEY = "CommandOrControl+Alt+R";
const SETTINGS_KEY = "screenrec.settings.v1";

const BAR_W = 320;
const BAR_H = 56;
const PILL_W = 96;
const PILL_H = 32;
const PANEL_W = 460;
const PANEL_H = 600;
const SUB_W = 560;
const SUB_H = 200;

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

interface Persisted {
  outputDir: string;
  framerate: number;
  includeAudio: boolean;
  showCursor: boolean;
  captureMode: CaptureMode;
  selectedWindow: string;
}

function loadSettings(): Partial<Persisted> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function saveSettings(s: Persisted) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

export default function App() {
  const persisted = loadSettings();
  const [status, setStatus] = useState<RecordingStatus>({
    is_recording: false,
    output_path: null,
    elapsed_ms: 0,
    subtitle_count: 0,
  });
  const [outputDir, setOutputDir] = useState<string>(persisted.outputDir ?? "");
  const [framerate, setFramerate] = useState(persisted.framerate ?? 30);
  const [includeAudio, setIncludeAudio] = useState(persisted.includeAudio ?? false);
  const [showCursor, setShowCursor] = useState(persisted.showCursor !== false);
  const [captureMode, setCaptureMode] = useState<CaptureMode>(persisted.captureMode ?? "screen");
  const [selectedWindow, setSelectedWindow] = useState<string>(persisted.selectedWindow ?? "");
  const [pane, setPane] = useState<Pane>("bar");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [subtitleText, setSubtitleText] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [pillExpanded, setPillExpanded] = useState(false);
  const tickRef = useRef<number | null>(null);
  const stopRef = useRef<() => void>(() => {});
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const savedPosRef = useRef<{ x: number; y: number } | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  // Resize the window to fit current pane.
  // While recording in bar pane, shrink to a small pill unless hovered.
  useEffect(() => {
    const w = getCurrentWindow();
    let target: { width: number; height: number };
    switch (pane) {
      case "settings":
      case "windowPicker":
        target = { width: PANEL_W, height: PANEL_H }; break;
      case "subtitle":
        target = { width: SUB_W, height: SUB_H }; break;
      default:
        if (status.is_recording && !pillExpanded) {
          target = { width: PILL_W, height: PILL_H };
        } else {
          target = { width: BAR_W, height: BAR_H };
        }
    }
    w.setSize(new LogicalSize(target.width, target.height)).catch((e) => console.error("setSize failed", e));
  }, [pane, status.is_recording, pillExpanded]);

  // Default output dir on first run.
  useEffect(() => {
    if (!outputDir) {
      invoke<string>("default_output_dir").then(setOutputDir).catch(() => {});
    }
  }, []);

  // Persist on change.
  useEffect(() => {
    saveSettings({ outputDir, framerate, includeAudio, showCursor, captureMode, selectedWindow });
  }, [outputDir, framerate, includeAudio, showCursor, captureMode, selectedWindow]);

  // Status polling.
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
    return () => { if (tickRef.current) window.clearInterval(tickRef.current); };
  }, [status.is_recording]);

  // Auto-focus subtitle input when shown.
  useEffect(() => {
    if (pane === "subtitle") {
      setTimeout(() => subtitleInputRef.current?.focus(), 50);
    }
  }, [pane]);

  const refreshWindows = async () => {
    try {
      const list = await invoke<WindowInfo[]>("list_windows");
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
    setPane("windowPicker");
  };

  const registerHotkeys = async () => {
    try {
      await unregister(SUBTITLE_HOTKEY).catch(() => {});
      await unregister(STOP_HOTKEY).catch(() => {});
      await register(SUBTITLE_HOTKEY, async (e) => {
        if (e.state === "Pressed") {
          const w = getCurrentWindow();
          await w.show().catch(() => {});
          await w.setFocus().catch(() => {});
          setPane("subtitle");
        }
      });
      await register(STOP_HOTKEY, async (e) => {
        if (e.state === "Pressed") await stopRef.current();
      });
    } catch (err) {
      console.warn("hotkey register failed (non-fatal)", err);
    }
  };

  const start = async () => {
    if (!outputDir) {
      showToast("请先在设置中选择保存位置");
      setPane("settings");
      return;
    }
    if (captureMode === "window" && !selectedWindow) {
      showToast("请选择要录制的窗口");
      await openWindowPicker();
      return;
    }

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

    setPane("bar");
    setPillExpanded(false);
    try { await registerHotkeys(); } catch {}

    // Snap pill to top-right corner of current monitor.
    try {
      const w = getCurrentWindow();
      const pos = await w.outerPosition();
      savedPosRef.current = { x: pos.x, y: pos.y };
      const mon = await currentMonitor();
      if (mon) {
        const physW = mon.size.width;
        const scale = mon.scaleFactor || 1;
        // Place at physical right-edge minus pill width (in physical px).
        const x = Math.max(0, physW - Math.round((PILL_W + 12) * scale));
        const y = Math.round(12 * scale);
        await w.setPosition(new PhysicalPosition(x, y));
      }
    } catch (e) { console.warn("pill snap failed", e); }

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
      setStatus({ is_recording: false, output_path: finalPath, elapsed_ms: 0, subtitle_count: 0 });
      setPane("bar");
      setPillExpanded(false);
      // Restore previous window position if we snapped to top-right.
      if (savedPosRef.current) {
        try {
          await getCurrentWindow().setPosition(
            new PhysicalPosition(savedPosRef.current.x, savedPosRef.current.y)
          );
        } catch {}
        savedPosRef.current = null;
      }
      showToast(`已保存`);
    } catch (e: any) {
      showToast(`保存失败: ${e}`);
    }
  };

  useEffect(() => { stopRef.current = stop; });

  const submitSubtitle = async () => {
    const text = subtitleText.trim();
    if (!text) { setPane("bar"); return; }
    try {
      const count = await invoke<number>("add_subtitle", { text });
      setStatus((s) => ({ ...s, subtitle_count: count }));
      setSubtitleText("");
      setPane("bar");
      showToast(`已记录字幕 #${count}`);
    } catch (e: any) {
      showToast(`字幕失败: ${e}`);
    }
  };

  const closeApp = async () => {
    try { await getCurrentWindow().close(); } catch (e) { console.error("close failed", e); }
  };

  const pickFolder = async () => {
    const selected = await openDialog({
      directory: true, multiple: false,
      defaultPath: outputDir || undefined,
    });
    if (typeof selected === "string") setOutputDir(selected);
  };

  const pickWindow = (title: string) => {
    setSelectedWindow(title);
    setCaptureMode("window");
    setPane("settings");
  };

  const reveal = async () => {
    if (status.output_path) await invoke("reveal_in_explorer", { path: status.output_path });
  };

  const timerText = useMemo(() => formatTime(status.elapsed_ms), [status.elapsed_ms]);

  // ============ RENDER ============
  if (pane === "bar") {
    // Compact pill mode while recording (collapses to a small dot+timer in the
    // top-right corner so it doesn't obstruct the screen). Hover to expand.
    if (status.is_recording && !pillExpanded) {
      return (
        <div
          className="float-pill"
          onMouseEnter={() => setPillExpanded(true)}
          onClick={() => setPillExpanded(true)}
          title="悬停展开 · Ctrl+Alt+R 停止"
        >
          <span className="fp-dot" />
          <span className="fp-time">{timerText}</span>
        </div>
      );
    }

    return (
      <div
        className={`float-bar ${status.is_recording ? "recording" : ""}`}
        onMouseLeave={() => { if (status.is_recording) setPillExpanded(false); }}
      >
        <button
          className="fb-btn fb-btn-ghost"
          onClick={() => setPane("settings")}
          title="设置"
          disabled={status.is_recording}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>

        <button
          className={`fb-record ${status.is_recording ? "recording" : ""}`}
          onClick={status.is_recording ? stop : start}
          title={status.is_recording ? "停止 (Ctrl+Alt+R)" : "开始录制"}
        >
          <span className="fb-record-inner" />
        </button>

        <div className="fb-timer" data-tauri-drag-region title="拖动以移动">
          <span className={`fb-timer-text ${status.is_recording ? "rec" : ""}`} data-tauri-drag-region>{timerText}</span>
          <span className="fb-timer-label" data-tauri-drag-region>{captureMode === "window" ? "窗口" : "全屏"}</span>
        </div>

        <button
          className="fb-btn fb-btn-ghost"
          onClick={() => setPane("subtitle")}
          title="插入字幕 (Ctrl+Alt+S)"
          disabled={!status.is_recording}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M4 4h16v16H4V4zm2 6v2h12v-2H6zm0 4v2h8v-2H6z" />
          </svg>
          {status.subtitle_count > 0 && <span className="fb-badge">{status.subtitle_count}</span>}
        </button>

        <button
          className="fb-btn fb-btn-close"
          onClick={closeApp}
          title="退出"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {toast && <div className="fb-toast">{toast}</div>}
      </div>
    );
  }

  if (pane === "subtitle") {
    return (
      <div className="panel-window subtitle-pane">
        <div className="panel-header" data-tauri-drag-region>
          <span className="panel-title">插入字幕</span>
          <span className="panel-time">{timerText}</span>
        </div>
        <input
          ref={subtitleInputRef}
          className="subtitle-input-large"
          value={subtitleText}
          onChange={(e) => setSubtitleText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitSubtitle();
            else if (e.key === "Escape") { setSubtitleText(""); setPane("bar"); }
          }}
          placeholder="输入字幕内容，回车记录…"
          autoFocus
        />
        <div className="panel-footer">
          <button className="btn btn-ghost-light" onClick={() => { setSubtitleText(""); setPane("bar"); }}>取消 (Esc)</button>
          <button className="btn btn-primary" onClick={submitSubtitle}>记录 (Enter)</button>
        </div>
        {toast && <div className="fb-toast">{toast}</div>}
      </div>
    );
  }

  if (pane === "windowPicker") {
    return (
      <div className="panel-window">
        <div className="panel-header" data-tauri-drag-region>
          <button className="icon-btn" onClick={() => setPane("settings")} title="返回">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="panel-title">选择窗口</span>
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
      </div>
    );
  }

  // pane === "settings"
  return (
    <div className="panel-window">
      <div className="panel-header" data-tauri-drag-region>
        <span className="panel-title">设置</span>
        <button className="icon-btn" onClick={() => setPane("bar")} title="完成">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="segmented">
        <button
          className={`seg-btn ${captureMode === "screen" ? "active" : ""}`}
          onClick={() => setCaptureMode("screen")}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 4h18v12H3z" opacity=".25" /><path d="M3 4h18a1 1 0 011 1v11a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1zm0 2v10h18V6H3zm5 14h8v2H8z" />
          </svg>
          全屏
        </button>
        <button
          className={`seg-btn ${captureMode === "window" ? "active" : ""}`}
          onClick={() => selectedWindow ? setCaptureMode("window") : openWindowPicker()}
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
          <div className={`switch ${includeAudio ? "on" : ""}`} onClick={() => setIncludeAudio((v) => !v)} role="switch" aria-checked={includeAudio} />
        </div>
        <div className="card-row">
          <div className="card-row-label">
            <span className="icon-bubble orange">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M7 2l-3 8h2l-4 12h16l-4-12h2l-3-8h-6zm1 2h4l1.5 4h-7l1.5-4zm-1.5 6h9l3.5 10h-16l3.5-10z"/></svg>
            </span>
            录制鼠标
          </div>
          <div className={`switch ${showCursor ? "on" : ""}`} onClick={() => setShowCursor((v) => !v)} role="switch" aria-checked={showCursor} />
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
        {status.output_path && (
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
      {toast && <div className="fb-toast">{toast}</div>}
    </div>
  );
}
