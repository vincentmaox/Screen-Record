import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";

interface RecordingStatus {
  is_recording: boolean;
  output_path: string | null;
  elapsed_ms: number;
  subtitle_count: number;
}

const SUBTITLE_HOTKEY = "CommandOrControl+Alt+S";

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
  const [toast, setToast] = useState<string | null>(null);
  const tickRef = useRef<number | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2200);
  };

  useEffect(() => {
    invoke<string>("default_output_dir").then(setOutputDir).catch(() => {});
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
    }, 250);
    return () => {
      if (tickRef.current) window.clearInterval(tickRef.current);
    };
  }, [status.is_recording]);

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
      x: undefined,
      y: undefined,
    });
    win.once("tauri://error", (e) => console.error("subtitle window error", e));
  };

  const registerHotkey = async () => {
    try {
      await unregister(SUBTITLE_HOTKEY).catch(() => {});
      await register(SUBTITLE_HOTKEY, async (e) => {
        if (e.state === "Pressed") await openSubtitleWindow();
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
    try {
      await invoke("start_recording", {
        opts: {
          output_dir: outputDir,
          framerate,
          include_audio: includeAudio,
          audio_device: null,
        },
      });
      await registerHotkey();
      const s = await invoke<RecordingStatus>("get_status");
      setStatus(s);
      showToast("开始录制 · 按 Ctrl+Alt+S 插入字幕");
    } catch (e: any) {
      showToast(`启动失败: ${e}`);
    }
  };

  const stop = async () => {
    try {
      const finalPath = await invoke<string>("stop_recording");
      await unregister(SUBTITLE_HOTKEY).catch(() => {});
      const existing = await WebviewWindow.getByLabel("subtitle");
      if (existing) await existing.close();
      setStatus({ is_recording: false, output_path: finalPath, elapsed_ms: 0, subtitle_count: 0 });
      showToast(`已保存 · ${shortenPath(finalPath, 40)}`);
    } catch (e: any) {
      showToast(`保存失败: ${e}`);
    }
  };

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
          <div className="timer-label">
            {status.is_recording ? "REC" : "READY"}
          </div>
        </div>
        <button
          className={`record-btn ${status.is_recording ? "recording" : ""}`}
          onClick={status.is_recording ? stop : start}
          aria-label={status.is_recording ? "Stop" : "Start"}
        >
          <span className="record-btn-inner" />
        </button>
      </div>

      <div className="card">
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
        录制中按 <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>S</kbd> 弹出字幕输入框
      </div>

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
