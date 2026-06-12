import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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

export default function SubtitleWindow() {
  const [text, setText] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [count, setCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const id = window.setInterval(async () => {
      try {
        const s = await invoke<RecordingStatus>("get_status");
        setElapsed(s.elapsed_ms);
        setCount(s.subtitle_count);
        if (!s.is_recording) {
          await getCurrentWebviewWindow().close();
        }
      } catch {}
    }, 250);
    return () => window.clearInterval(id);
  }, []);

  const submit = async () => {
    const value = text.trim();
    if (!value) {
      await getCurrentWebviewWindow().close();
      return;
    }
    try {
      await invoke("add_subtitle", { text: value });
      setText("");
      await getCurrentWebviewWindow().close();
    } catch (e) {
      console.error(e);
    }
  };

  const cancel = async () => {
    await getCurrentWebviewWindow().close();
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
    else if (e.key === "Escape") cancel();
  };

  return (
    <div className="subtitle-window">
      <div className="subtitle-card">
        <div className="subtitle-card-header">
          <span className="subtitle-card-title">字幕速记 · {count} 条</span>
          <span className="subtitle-card-time">{formatTime(elapsed)}</span>
        </div>
        <input
          ref={inputRef}
          className="subtitle-input"
          placeholder="输入字幕，回车保存…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="subtitle-actions">
          <button className="btn btn-ghost" onClick={cancel}>取消 (Esc)</button>
          <button className="btn btn-primary" onClick={submit}>保存 (↵)</button>
        </div>
      </div>
    </div>
  );
}
