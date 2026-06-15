mod recorder;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            recorder::start_recording,
            recorder::stop_recording,
            recorder::add_subtitle,
            recorder::get_status,
            recorder::default_output_dir,
            recorder::reveal_in_explorer,
            recorder::list_windows,
            recorder::list_audio_devices,
            recorder::list_recordings,
            recorder::burn_subtitles_to_video,
            recorder::import_srt,
        ])
        .setup(|app| {
            // Ensure binaries dir exists for dev mode hint.
            let _ = app.handle();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
