mod audio;
mod transcribe;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            audio::extract_audio,
            transcribe::transcribe_audio,
        ])
        .run(tauri::generate_context!())
        .expect("error while running 16x Media Digest");
}
