import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";

interface WindowInfo {
  title: string;
  process_name: string;
}

type CaptureMode = "screen" | "window";

function shortenPath(p: string, max = 36): string {
  if (p.length <= max) return p;
  const tail = p.slice(-(max - 3));
  return `…${tail}`;
}

export default function Settings() {
  const [outputDir, setOutputDir] = useState("");
  const [framerate, setFramerate] = useState(30);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [showCursor, setShowCursor] = useState(true);
  const [autoHide, setAutoHide] = useState(true);
  const [captureMode, setCaptureMode] = useState<CaptureMode>("screen");
  const [selectedWindow, setSelectedWindow] = useState("");
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [showWindowPicker, setShowWindowPicker] = useState(false);
  const [lastOutput, setLastOutput] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Request current settings from main window on mount.
  useEffect(() => {
    emit("settings:request");
  }, []);

  // Receive settings snapshot from main window.
  useEffect(() => {
    const unlistenPromise = listen<{
      autoHide: boolean;
      captureMode: CaptureMode;
      framerate: number;
      includeAudio: boolean;
      lastOutput: string | null;
      outputDir: string;
      selectedWindow: string;
      showCursor: boolean;
    }>("settings:sync", (e) => {
      const s = e.payload;
      setOutputDir(s.outputDir ?? "");
      setFramerate(s.framerate ?? 30);
      setIncludeAudio(s.includeAudio ?? false);
      setShowCursor(s.showCursor !== false);
      setAutoHide(s.autoHide !== false);
      setCaptureMode(s.captureMode ?? "screen");
      setSelectedWindow(s.selectedWindow ?? "");
      setLastOutput(s.lastOutput ?? null);
      setLoading(false);
    });
    return () => { unlistenPromise.then((u) => u()); };
  }, []);

  const update = (key: string, value: unknown) => {
    emit("settings:update", { key, value });
  };

  const pickFolder = async () => {
    const selected = await openDialog({
      directory: true,
      multiple: false,
      defaultPath: outputDir || undefined,
    });
    if (typeof selected === "string") {
      setOutputDir(selected);
      update("outputDir", selected);
    }
  };

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

  const pickWindow = (title: string) => {
    setSelectedWindow(title);
    setCaptureMode("window");
    update("selectedWindow", title);
    update("captureMode", "window");
    setShowWindowPicker(false);
  };

  const close = () => {
    getCurrentWindow().close().catch(() => {});
  };

  if (loading) {
    return (
      <div className="settings-window">
        <div className="settings-loading">加载中…</div>
      </div>
    );
  }

  return (
    <div className="settings-window">
      <div className="settings-header">
        <span className="settings-title">设置</span>
        <button className="icon-btn" onClick={close} title="关闭">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Mode: screen / window */}
      <div className="segmented">
        <button
          className={`seg-btn ${captureMode === "screen" ? "active" : ""}`}
          onClick={() => { setCaptureMode("screen"); update("captureMode", "screen"); }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 4h18v12H3z" opacity=".25" /><path d="M3 4h18a1 1 0 011 1v11a1 1 0 01-1 1H3a1 1 0 01-1-1V5a1 1 0 011-1zm0 2v10h18V6H3zm5 14h8v2H8z" />
          </svg>
          全屏
        </button>
        <button
          className={`seg-btn ${captureMode === "window" ? "active" : ""}`}
          onClick={() => {
            if (selectedWindow) {
              setCaptureMode("window");
              update("captureMode", "window");
            } else {
              refreshWindows();
              setShowWindowPicker(true);
            }
          }}
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
            <span className="path-pill" onClick={() => { refreshWindows(); setShowWindowPicker(true); }} title={selectedWindow}>
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
            onChange={(e) => { const v = Number(e.target.value); setFramerate(v); update("framerate", v); }}
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
            onClick={() => { const v = !includeAudio; setIncludeAudio(v); update("includeAudio", v); }}
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
            onClick={() => { const v = !showCursor; setShowCursor(v); update("showCursor", v); }}
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
            onClick={() => { const v = !autoHide; setAutoHide(v); update("autoHide", v); }}
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
        {lastOutput && (
          <div className="card-row">
            <div className="card-row-label">
              <span className="icon-bubble green">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
              </span>
              最近输出
            </div>
            <span
              className="path-pill"
              onClick={() => invoke("reveal_in_explorer", { path: lastOutput }).catch(() => {})}
              title={lastOutput}
            >
              {shortenPath(lastOutput, 32)}
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
    </div>
  );
}