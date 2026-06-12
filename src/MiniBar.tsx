import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emit } from "@tauri-apps/api/event";

interface RecordingStatus {
  is_recording: boolean;
  elapsed_ms: number;
  subtitle_count: number;
  output_path: string | null;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function MiniBar() {
  const [elapsed, setElapsed] = useState(0);
  const [subCount, setSubCount] = useState(0);

  useEffect(() => {
    const id = window.setInterval(async () => {
      try {
        const s = await invoke<RecordingStatus>("get_status");
        setElapsed(s.elapsed_ms);
        setSubCount(s.subtitle_count);
        if (!s.is_recording) {
          await getCurrentWebviewWindow().close();
        }
      } catch {}
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const openSubtitle = async () => {
    const existing = await WebviewWindow.getByLabel("subtitle");
    if (existing) {
      await existing.show();
      await existing.setFocus();
      return;
    }
    new WebviewWindow("subtitle", {
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
    });
  };

  const stop = async () => {
    try {
      // Let the main window run the full stop flow (hotkey cleanup, restore UI, etc).
      await emit("screenrec://stop");
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <div className="minibar" data-tauri-drag-region>
      <div className="minibar-dot" />
      <div className="minibar-time">{formatTime(elapsed)}</div>
      <button className="minibar-btn" title="插入字幕 (Ctrl+Alt+S)" onClick={openSubtitle}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
          <path d="M4 4h16v16H4V4zm2 6v2h12v-2H6zm0 4v2h8v-2H6z" />
        </svg>
        {subCount > 0 && <span className="minibar-badge">{subCount}</span>}
      </button>
      <button className="minibar-btn stop" title="停止录制 (Ctrl+Alt+R)" onClick={stop}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
          <rect x="5" y="5" width="14" height="14" rx="2" />
        </svg>
      </button>
    </div>
  );
}
