use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use chrono::Local;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(target_os = "windows")]
const BELOW_NORMAL_PRIORITY_CLASS: u32 = 0x0000_4000;

static RECORDER: Lazy<Mutex<RecorderState>> = Lazy::new(|| Mutex::new(RecorderState::default()));

#[derive(Default)]
struct RecorderState {
    child: Option<Child>,
    output_path: Option<PathBuf>,
    started_at: Option<chrono::DateTime<Local>>,
    subtitles: Vec<SubtitleEntry>,
    output_format: Option<OutputFormat>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubtitleEntry {
    pub start_ms: i64,
    #[serde(default)]
    pub end_ms: Option<i64>,
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordOptions {
    pub output_dir: String,
    pub framerate: u32,
    pub include_audio: bool,
    pub audio_device: Option<String>, // dshow device name; None = system default mic
    #[serde(default)]
    pub capture_mode: CaptureMode,
    #[serde(default)]
    pub window_title: Option<String>, // exact title for CaptureMode::Window
    #[serde(default = "default_show_cursor")]
    pub show_cursor: bool,
    #[serde(default)]
    pub output_format: OutputFormat,
}

fn default_show_cursor() -> bool { true }

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum OutputFormat {
    #[default]
    Mp4,
    Mkv,
    Webm,
}

impl OutputFormat {
    fn extension(&self) -> &str {
        match self {
            OutputFormat::Mp4 => "mp4",
            OutputFormat::Mkv => "mkv",
            OutputFormat::Webm => "webm",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    #[default]
    Screen,
    Window,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WindowInfo {
    pub title: String,
    pub process_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordingStatus {
    pub is_recording: bool,
    pub output_path: Option<String>,
    pub elapsed_ms: i64,
    pub subtitle_count: usize,
}

fn ffmpeg_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;

    // 1) Portable mode: ffmpeg.exe sitting next to our exe (U-stick friendly).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let portable = parent.join("ffmpeg.exe");
            if portable.exists() {
                return Ok(portable);
            }
            let portable_sub = parent.join("binaries").join("ffmpeg.exe");
            if portable_sub.exists() {
                return Ok(portable_sub);
            }
        }
    }

    // 2) Installed mode: Tauri resource_dir/binaries/ffmpeg.exe
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled = resource_dir.join("binaries").join("ffmpeg.exe");
        if bundled.exists() {
            return Ok(bundled);
        }
    }

    // 3) Dev mode: src-tauri/binaries/ffmpeg.exe
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join("ffmpeg.exe");
    if dev.exists() {
        return Ok(dev);
    }

    // 4) Last resort: rely on PATH
    Ok(PathBuf::from("ffmpeg"))
}

#[cfg(target_os = "windows")]
fn get_window_rect(title: &str) -> Option<(i32, i32, i32, i32)> {
    use std::ffi::OsString;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, RECT, TRUE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, IsIconic,
        IsWindowVisible,
    };

    // Pass target title + out param via lparam.
    struct Search<'a> {
        wanted: &'a [u16],
        hwnd: HWND,
    }
    let wanted: Vec<u16> = std::ffi::OsStr::new(title).encode_wide().collect();
    let mut search = Search { wanted: &wanted, hwnd: std::ptr::null_mut() };

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let s = &mut *(lparam as *mut Search);
        if s.hwnd != std::ptr::null_mut() { return 0; } // stop
        if IsWindowVisible(hwnd) == 0 { return TRUE; }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 { return TRUE; }
        let mut buf: Vec<u16> = vec![0; (len + 1) as usize];
        let got = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if got <= 0 { return TRUE; }
        let title_slice = &buf[..got as usize];
        if title_slice == s.wanted {
            s.hwnd = hwnd;
            return 0;
        }
        // Fallback: case-sensitive substring match on OsString round-trip
        let _ = OsString::from_wide(title_slice);
        TRUE
    }

    unsafe {
        EnumWindows(Some(enum_proc), &mut search as *mut _ as LPARAM);
        if search.hwnd.is_null() {
            return None;
        }
        // Skip minimized windows — GetWindowRect returns off-screen coords.
        if IsIconic(search.hwnd) != 0 {
            return None;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(search.hwnd, &mut rect) == 0 {
            return None;
        }
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w <= 0 || h <= 0 {
            return None;
        }
        Some((rect.left, rect.top, w, h))
    }
}

#[tauri::command]
pub fn start_recording(app: tauri::AppHandle, opts: RecordOptions) -> Result<String, String> {
    let mut state = RECORDER.lock().map_err(|e| e.to_string())?;
    if state.child.is_some() {
        return Err("Recording already in progress".into());
    }

    let out_dir = PathBuf::from(&opts.output_dir);
    std::fs::create_dir_all(&out_dir).map_err(|e| format!("Create dir failed: {e}"))?;
    let timestamp = Local::now().format("%Y%m%d_%H%M%S").to_string();
    let out_file = out_dir.join(format!("ScreenRecord_{timestamp}.{}", opts.output_format.extension()));

    let ffmpeg = ffmpeg_path(&app)?;

    // ddagrab (DXGI Desktop Duplication API) is GPU-path — same mechanism OBS
    // uses. Eliminates the cursor stutter that gdigrab's CPU BitBlt causes on
    // busy systems. Requires a BtbN GPL-licensed ffmpeg build.

    // Compute crop for window mode (applied in the filter chain below).
    let mut crop_filter: Option<String> = None;
    if let CaptureMode::Window = opts.capture_mode {
        let title = opts
            .window_title
            .as_deref()
            .filter(|s| !s.is_empty())
            .ok_or("Window mode requires a window title")?;
        #[cfg(target_os = "windows")]
        {
            if let Some((x, y, w, h)) = get_window_rect(title) {
                let w_even = (w & !1).max(2);
                let h_even = (h & !1).max(2);
                crop_filter = Some(format!("crop={}:{}:{}:{}", w_even, h_even, x.max(0), y.max(0)));
            }
        }
    }

    // libx264 needs a CPU frame in yuv420p; ddagrab outputs GPU BGRA, so we
    // must hwdownload + format-convert before the encoder. Optional crop is
    // applied in CPU space (after hwdownload) for simplicity.
    let filter_chain = {
        let mut chain = format!(
            "ddagrab=output_idx=0:framerate={}:draw_mouse={}",
            opts.framerate,
            if opts.show_cursor { 1 } else { 0 }
        );
        chain.push_str(",hwdownload,format=bgra");
        if let Some(crop) = &crop_filter {
            chain.push(',');
            chain.push_str(crop);
        }
        chain
    };

    let mut cmd = Command::new(&ffmpeg);
    cmd.arg("-y")
        .args(["-filter_complex", &filter_chain]);

    if opts.include_audio {
        let audio_arg = match &opts.audio_device {
            Some(name) if !name.is_empty() => format!("audio={name}"),
            _ => "audio=virtual-audio-capturer".to_string(),
        };
        cmd.args(["-f", "dshow"]).args(["-i", &audio_arg]);
    }

    match opts.output_format {
        OutputFormat::Mp4 | OutputFormat::Mkv => {
            cmd.args(["-c:v", "libx264"])
                .args(["-preset", "superfast"])
                .args(["-tune", "zerolatency"])
                .args(["-pix_fmt", "yuv420p"])
                .args(["-crf", "23"])
                .args(["-threads", "2"]);
            if opts.include_audio {
                cmd.args(["-c:a", "aac"]).args(["-b:a", "128k"]);
            }
        }
        OutputFormat::Webm => {
            cmd.args(["-c:v", "libvpx-vp9"])
                .args(["-crf", "30"])
                .args(["-b:v", "0"])
                .args(["-threads", "2"]);
            if opts.include_audio {
                cmd.args(["-c:a", "libopus"]).args(["-b:a", "128k"]);
            }
        }
    }

    cmd.arg(out_file.to_string_lossy().to_string());

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS);

    let child = cmd.spawn().map_err(|e| format!("Failed to launch ffmpeg: {e}"))?;

    state.child = Some(child);
    state.output_path = Some(out_file.clone());
    state.started_at = Some(Local::now());
    state.subtitles.clear();
    state.output_format = Some(opts.output_format.clone());

    Ok(out_file.to_string_lossy().to_string())
}

#[tauri::command]
pub fn stop_recording(app: tauri::AppHandle) -> Result<String, String> {
    let (mut child, output_path, subtitles, output_format) = {
        let mut state = RECORDER.lock().map_err(|e| e.to_string())?;
        let child = state.child.take().ok_or("No recording in progress")?;
        let path = state.output_path.take().ok_or("Missing output path")?;
        let subs = std::mem::take(&mut state.subtitles);
        let fmt = state.output_format.take().unwrap_or_default();
        state.started_at = None;
        (child, path, subs, fmt)
    };

    // Send 'q' to ffmpeg stdin for graceful exit so MP4 moov atom is written.
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        let _ = stdin.write_all(b"q\n");
        let _ = stdin.flush();
    }

    // Wait up to 10s for ffmpeg to flush and exit.
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed().as_secs() > 10 => {
                let _ = child.kill();
                break;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(100)),
            Err(_) => break,
        }
    }

    // If subtitles exist, burn them into a new file using ffmpeg.
    let final_path = if !subtitles.is_empty() {
        burn_subtitles(&app, &output_path, &subtitles, &output_format).unwrap_or(output_path)
    } else {
        output_path
    };

    Ok(final_path.to_string_lossy().to_string())
}

fn ms_to_srt_ts(ms: i64) -> String {
    let total = ms.max(0);
    let h = total / 3_600_000;
    let m = (total % 3_600_000) / 60_000;
    let s = (total % 60_000) / 1000;
    let mil = total % 1000;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, mil)
}

fn burn_subtitles(
    app: &tauri::AppHandle,
    video: &PathBuf,
    subs: &[SubtitleEntry],
    output_format: &OutputFormat,
) -> Result<PathBuf, String> {
    let srt_path = video.with_extension("srt");
    let mut srt_content = String::new();
    for (i, sub) in subs.iter().enumerate() {
        let end_ms = sub.end_ms.unwrap_or_else(|| {
            subs.get(i + 1)
                .map(|n| n.start_ms.min(sub.start_ms + 5000))
                .unwrap_or(sub.start_ms + 3000)
        });
        srt_content.push_str(&format!("{}\n", i + 1));
        srt_content.push_str(&format!(
            "{} --> {}\n",
            ms_to_srt_ts(sub.start_ms),
            ms_to_srt_ts(end_ms)
        ));
        srt_content.push_str(&sub.text);
        srt_content.push_str("\n\n");
    }
    std::fs::write(&srt_path, srt_content).map_err(|e| e.to_string())?;

    let burned = video.with_file_name(format!(
        "{}_subtitled.{}",
        video.file_stem().and_then(|s| s.to_str()).unwrap_or("output"),
        output_format.extension()
    ));

    let ffmpeg = ffmpeg_path(app)?;
    let srt_for_filter = srt_path
        .to_string_lossy()
        .replace('\\', "/")
        .replace(':', "\\:");
    let filter = format!(
        "subtitles='{}':force_style='FontName=Microsoft YaHei,FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,Outline=1,Shadow=0,Alignment=2,MarginV=40'",
        srt_for_filter
    );

    let mut cmd = Command::new(ffmpeg);
    cmd.arg("-y")
        .args(["-i", &video.to_string_lossy()])
        .args(["-vf", &filter]);

    match output_format {
        OutputFormat::Mp4 | OutputFormat::Mkv => {
            cmd.args(["-c:v", "libx264"])
                .args(["-preset", "superfast"])
                .args(["-crf", "23"])
                .args(["-pix_fmt", "yuv420p"])
                .args(["-c:a", "copy"]);
        }
        OutputFormat::Webm => {
            cmd.args(["-c:v", "libvpx-vp9"])
                .args(["-crf", "30"])
                .args(["-b:v", "0"])
                .args(["-c:a", "libopus"])
                .args(["-b:a", "128k"]);
        }
    }

    cmd.arg(burned.to_string_lossy().to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let status = cmd.status().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(burned)
    } else {
        Err("Subtitle burn-in failed".into())
    }
}

#[tauri::command]
pub fn add_subtitle(text: String) -> Result<usize, String> {
    let mut state = RECORDER.lock().map_err(|e| e.to_string())?;
    let started = state.started_at.ok_or("Not recording")?;
    let elapsed = (Local::now() - started).num_milliseconds();
    state.subtitles.push(SubtitleEntry {
        start_ms: elapsed,
        end_ms: None,
        text,
    });
    Ok(state.subtitles.len())
}

#[tauri::command]
pub fn get_status() -> Result<RecordingStatus, String> {
    let state = RECORDER.lock().map_err(|e| e.to_string())?;
    let elapsed_ms = state
        .started_at
        .map(|t| (Local::now() - t).num_milliseconds())
        .unwrap_or(0);
    Ok(RecordingStatus {
        is_recording: state.child.is_some(),
        output_path: state.output_path.as_ref().map(|p| p.to_string_lossy().to_string()),
        elapsed_ms,
        subtitle_count: state.subtitles.len(),
    })
}

#[tauri::command]
pub fn default_output_dir(app: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    // Portable-first: write next to the executable so a USB-stick install Just Works.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let dir = parent.join("Recordings");
            return Ok(dir.to_string_lossy().to_string());
        }
    }
    let docs = app.path().document_dir().map_err(|e| e.to_string())?;
    Ok(docs.join("ScreenRecord").to_string_lossy().to_string())
}

#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut cmd = Command::new("explorer.exe");
        cmd.arg(format!("/select,{}", path));
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, TRUE, CloseHandle};
    use windows_sys::Win32::System::ProcessStatus::GetModuleBaseNameW;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_VM_READ,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
        GetWindowThreadProcessId, IsWindowVisible, GWL_EXSTYLE, WS_EX_TOOLWINDOW,
    };

    struct Collected(Vec<WindowInfo>);

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let collected = &mut *(lparam as *mut Collected);

        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        // Skip tool windows (tray, hidden chrome, etc.)
        let exstyle = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if exstyle & WS_EX_TOOLWINDOW != 0 {
            return TRUE;
        }
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return TRUE;
        }
        let mut buf: Vec<u16> = vec![0; (len + 1) as usize];
        let got = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if got <= 0 {
            return TRUE;
        }
        let title = OsString::from_wide(&buf[..got as usize])
            .to_string_lossy()
            .to_string();
        if title.trim().is_empty() {
            return TRUE;
        }

        // Resolve process name (best-effort).
        let mut pid: u32 = 0;
        let _ = GetWindowThreadProcessId(hwnd, &mut pid);
        let mut process_name = String::new();
        if pid != 0 {
            let handle = OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ,
                0,
                pid,
            );
            if !handle.is_null() {
                let mut pbuf: [u16; 260] = [0; 260];
                let got = GetModuleBaseNameW(handle, std::ptr::null_mut(), pbuf.as_mut_ptr(), pbuf.len() as u32);
                if got > 0 {
                    process_name = OsString::from_wide(&pbuf[..got as usize])
                        .to_string_lossy()
                        .to_string();
                }
                CloseHandle(handle);
            }
        }

        collected.0.push(WindowInfo {
            title,
            process_name,
        });
        TRUE
    }

    let mut collected = Collected(Vec::new());
    unsafe {
        EnumWindows(Some(enum_proc), &mut collected as *mut _ as LPARAM);
    }

    // Deduplicate by title (gdigrab matches first window with that title anyway).
    collected.0.sort_by(|a, b| a.title.cmp(&b.title));
    collected.0.dedup_by(|a, b| a.title == b.title);
    Ok(collected.0)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn list_windows() -> Result<Vec<WindowInfo>, String> {
    Ok(Vec::new())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RecordingInfo {
    pub filename: String,
    pub path: String,
    pub size_bytes: u64,
    pub modified: String,
}

#[tauri::command]
pub fn list_recordings(output_dir: String) -> Result<Vec<RecordingInfo>, String> {
    let dir = PathBuf::from(&output_dir);
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let mut recordings = Vec::new();
    let entries = std::fs::read_dir(&dir).map_err(|e| e.to_string())?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() { continue; }
        let ext = path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(ext.as_str(), "mp4" | "mkv" | "webm") { continue; }

        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        if stem.ends_with("_subtitled") { continue; }

        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let modified = metadata.modified()
            .map_err(|e| e.to_string())?
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        let dt = chrono::DateTime::from_timestamp(modified.as_secs() as i64, 0)
            .unwrap_or_default()
            .format("%Y-%m-%d %H:%M:%S")
            .to_string();

        recordings.push(RecordingInfo {
            filename: path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string(),
            path: path.to_string_lossy().to_string(),
            size_bytes: metadata.len(),
            modified: dt,
        });
    }

    recordings.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(recordings)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SubtitleInput {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[tauri::command]
pub fn burn_subtitles_to_video(
    app: tauri::AppHandle,
    video_path: String,
    subtitles: Vec<SubtitleInput>,
) -> Result<String, String> {
    let video = PathBuf::from(&video_path);
    if !video.exists() {
        return Err("Video file not found".into());
    }
    if subtitles.is_empty() {
        return Err("No subtitles provided".into());
    }

    let ext = video.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("mp4")
        .to_lowercase();
    let output_format = match ext.as_str() {
        "mkv" => OutputFormat::Mkv,
        "webm" => OutputFormat::Webm,
        _ => OutputFormat::Mp4,
    };

    let entries: Vec<SubtitleEntry> = subtitles.into_iter().map(|s| SubtitleEntry {
        start_ms: s.start_ms,
        end_ms: Some(s.end_ms),
        text: s.text,
    }).collect();

    let result = burn_subtitles(&app, &video, &entries, &output_format)?;
    Ok(result.to_string_lossy().to_string())
}

#[tauri::command]
pub fn import_srt(path: String) -> Result<Vec<SubtitleInput>, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    let blocks: Vec<&str> = content.split("\n\n").collect();

    for block in blocks {
        let lines: Vec<&str> = block.trim().lines().collect();
        if lines.len() < 3 { continue; }

        let ts_line = lines[1];
        let parts: Vec<&str> = ts_line.split(" --> ").collect();
        if parts.len() != 2 { continue; }

        let start_ms = parse_srt_timestamp(parts[0].trim())?;
        let end_ms = parse_srt_timestamp(parts[1].trim())?;
        let text = lines[2..].join("\n");

        entries.push(SubtitleInput { start_ms, end_ms, text });
    }

    Ok(entries)
}

fn parse_srt_timestamp(ts: &str) -> Result<i64, String> {
    let parts: Vec<&str> = ts.split(':').collect();
    if parts.len() != 3 { return Err("Invalid SRT timestamp".into()); }
    let h: i64 = parts[0].parse().map_err(|_| "Invalid hour")?;
    let m: i64 = parts[1].parse().map_err(|_| "Invalid minute")?;
    let sec_parts: Vec<&str> = parts[2].split(',').collect();
    if sec_parts.len() != 2 { return Err("Invalid SRT timestamp".into()); }
    let s: i64 = sec_parts[0].parse().map_err(|_| "Invalid second")?;
    let ms: i64 = sec_parts[1].parse().map_err(|_| "Invalid millisecond")?;
    Ok(h * 3600000 + m * 60000 + s * 1000 + ms)
}

#[cfg(target_os = "windows")]
#[tauri::command]
pub fn list_audio_devices(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let ffmpeg = ffmpeg_path(&app)?;
    let mut cmd = Command::new(&ffmpeg);
    cmd.args(["-list_devices", "true"])
        .args(["-f", "dshow"])
        .arg("-i")
        .arg("dummy")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().map_err(|e| format!("Failed to run ffmpeg: {e}"))?;
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut devices = Vec::new();
    let mut in_audio_section = false;

    for line in stderr.lines() {
        if line.contains("DirectShow audio devices") {
            in_audio_section = true;
            continue;
        }
        if line.contains("DirectShow video devices") || line.contains("Dummy device") {
            in_audio_section = false;
            continue;
        }
        if in_audio_section && line.contains("(audio)") && !line.contains("Alternative") {
            if let Some(start) = line.find('"') {
                if let Some(end) = line[start + 1..].find('"') {
                    let name = &line[start + 1..start + 1 + end];
                    devices.push(name.to_string());
                }
            }
        }
    }

    if !devices.iter().any(|d| d == "virtual-audio-capturer") {
        devices.push("virtual-audio-capturer".to_string());
    }

    Ok(devices)
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub fn list_audio_devices(_app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(Vec::new())
}
