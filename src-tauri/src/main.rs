// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(windows)]
fn setup_embedded_webview2() {
    // If a WebView2Runtime/ directory sits next to the .exe (portable build),
    // point Tauri/WebView2Loader at it so the app works on machines without
    // the WebView2 Evergreen runtime installed (locked-down corporate PCs).
    let exe_dir = match std::env::current_exe().ok().and_then(|p| p.parent().map(|p| p.to_path_buf())) {
        Some(d) => d,
        None => return,
    };
    let runtime_root = exe_dir.join("WebView2Runtime");
    if !runtime_root.is_dir() {
        return;
    }
    // Fixed Version CAB expands to a versioned subfolder; pick the first one
    // that contains msedgewebview2.exe.
    let candidate = std::fs::read_dir(&runtime_root)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.is_dir() && p.join("msedgewebview2.exe").is_file());
    let target = candidate.unwrap_or(runtime_root.clone());
    if target.join("msedgewebview2.exe").is_file() {
        std::env::set_var("WEBVIEW2_BROWSER_EXECUTABLE_FOLDER", &target);
    }
}

fn main() {
    #[cfg(windows)]
    setup_embedded_webview2();
    screen_record_lib::run()
}
